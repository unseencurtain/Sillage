/**
 * Poll vendors for shipment status and push tracking back into WooCommerce.
 *
 * Writes go through the plugin's REST endpoint (WooCommerce order API), never raw SQL — notes,
 * customer emails and HPOS lookup tables all stay consistent that way.
 */
import { env, sil } from "../config/env.ts";
import { execute, query, type RowDataPacket } from "../db/pool.ts";
import { loadSettings, recordEvent } from "../db/settings.ts";
import { signPayload } from "../lib/hmac.ts";
import { logger } from "../lib/log.ts";
import type { TrackingParcel, VendorPollStatus } from "./adapter.ts";
import { createOrderAdapter } from "./adapters/index.ts";

const log = logger("tracking");

interface PollRow extends RowDataPacket {
  id: number;
  wc_order_id: number;
  vendor_id: number;
  status: string;
  our_reference: string;
  vendor_order_number: string | null;
  dry_run: number;
  last_polled_at: string | null;
  vendor_slug: string;
}

const STATUS_RANK: Record<string, number> = {
  submitted: 1,
  confirmed: 2,
  dispatched: 3,
  delivered: 4,
};

function mapPollToRow(status: VendorPollStatus): string | null {
  switch (status) {
    case "confirmed":
      return "confirmed";
    case "dispatched":
      return "dispatched";
    case "delivered":
      return "delivered";
    case "cancelled":
      return "cancelled";
    default:
      return null;
  }
}

async function pushToWooCommerce(payload: Record<string, unknown>): Promise<boolean> {
  const body = JSON.stringify({ ...payload, timestamp: Math.floor(Date.now() / 1000) });
  const url = `${env.wordpress.baseUrl}/wp-json/sillage/v1/order-update`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Sillage-Signature": signPayload(body, env.wordpress.sharedSecret),
      },
      body,
    });
    if (!response.ok) {
      log.warn(`order-update returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
      return false;
    }
    return true;
  } catch (err) {
    log.warn(`order-update failed: ${String(err)}`);
    return false;
  }
}

async function recordParcels(
  vendorOrderId: number,
  parcels: TrackingParcel[],
): Promise<TrackingParcel[]> {
  const fresh: TrackingParcel[] = [];
  for (const parcel of parcels) {
    if (!parcel.code) continue;
    const result = await execute(
      `INSERT IGNORE INTO ${sil("sil_vendor_order_tracking")}
         (vendor_order_id, courier, tracking_code, tracking_url, dispatched_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        vendorOrderId,
        parcel.courier || null,
        parcel.code,
        parcel.url || null,
        parcel.dispatchedAt
          ? parcel.dispatchedAt.slice(0, 19).replace("T", " ")
          : null,
      ],
    );
    if (result.affectedRows > 0) fresh.push(parcel);
  }
  return fresh;
}

async function markPushed(vendorOrderId: number, code: string): Promise<void> {
  await execute(
    `UPDATE ${sil("sil_vendor_order_tracking")}
        SET pushed_to_wc = 1
      WHERE vendor_order_id = ? AND tracking_code = ?`,
    [vendorOrderId, code],
  );
}

/**
 * Poll one vendor order. Dry-run rows are skipped — they were never placed at the vendor.
 */
export async function pollVendorOrder(id: number): Promise<{
  id: number;
  status: string;
  parcels: number;
  pushed: number;
}> {
  const rows = await query<PollRow>(
    `SELECT v.*, ven.slug AS vendor_slug
       FROM ${sil("sil_vendor_orders")} v
       JOIN ${sil("sil_vendors")} ven ON ven.id = v.vendor_id
      WHERE v.id = ?`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new Error(`vendor order ${id} not found`);
  if (row.dry_run) {
    return { id, status: row.status, parcels: 0, pushed: 0 };
  }
  if (!row.vendor_order_number) {
    return { id, status: row.status, parcels: 0, pushed: 0 };
  }

  const settings = await loadSettings();
  const adapter = createOrderAdapter(row.vendor_slug);
  const polled = await adapter.poll(row.vendor_order_number, row.our_reference);

  await execute(
    `UPDATE ${sil("sil_vendor_orders")} SET last_polled_at = NOW() WHERE id = ?`,
    [id],
  );

  const next = mapPollToRow(polled.status);
  if (next && (STATUS_RANK[next] ?? 0) > (STATUS_RANK[row.status] ?? 0)) {
    await execute(
      `UPDATE ${sil("sil_vendor_orders")}
          SET status = ?,
              dispatched_at = IF(? = 'dispatched' AND dispatched_at IS NULL, NOW(), dispatched_at),
              delivered_at  = IF(? = 'delivered'  AND delivered_at  IS NULL, NOW(), delivered_at),
              shipping_company = COALESCE(?, shipping_company)
        WHERE id = ?`,
      [next, next, next, polled.shippingCompany, id],
    );
    await execute(
      `INSERT INTO ${sil("sil_order_events")} (vendor_order_id, from_status, to_status, message, context)
       VALUES (?, ?, ?, ?, ?)`,
      [
        id,
        row.status,
        next,
        `vendor status: ${polled.rawStatus}`,
        JSON.stringify({ parcels: polled.parcels.length }),
      ],
    );
  }

  const fresh = await recordParcels(id, polled.parcels);
  let pushed = 0;

  for (const parcel of fresh) {
    const ok = await pushToWooCommerce({
      order_id: row.wc_order_id,
      vendor: row.vendor_slug,
      vendor_order_number: row.vendor_order_number,
      notify_customer: settings.ordersNotifyCustomer,
      tracking: {
        vendor: row.vendor_slug,
        courier: parcel.courier,
        code: parcel.code,
        url: parcel.url,
      },
    });
    if (ok) {
      await markPushed(id, parcel.code);
      pushed++;
    }
  }

  // When every vendor row for this WC order is dispatched or beyond, mark the WC order completed.
  if (next === "dispatched" || next === "delivered") {
    await maybeCompleteWooOrder(row.wc_order_id, settings.ordersNotifyCustomer);
  }

  return { id, status: next ?? row.status, parcels: fresh.length, pushed };
}

async function maybeCompleteWooOrder(wcOrderId: number, notify: boolean): Promise<void> {
  const rows = await query<RowDataPacket & { pending: number }>(
    `SELECT COUNT(*) AS pending FROM ${sil("sil_vendor_orders")}
      WHERE wc_order_id = ?
        AND dry_run = 0
        AND status NOT IN ('dispatched','delivered','cancelled')`,
    [wcOrderId],
  );
  if (Number(rows[0]?.pending ?? 1) > 0) return;

  await pushToWooCommerce({
    order_id: wcOrderId,
    status: "completed",
    notify_customer: notify,
    note: "Sillage: all vendor shipments dispatched.",
  });
}

/**
 * Poll every live order that is waiting on the vendor, respecting the configured interval.
 * BeautyFort asks for no more than one status poll per 5 minutes; we use the setting (default 15).
 */
export async function pollDueOrders(limit = 50): Promise<number> {
  const settings = await loadSettings();
  const minutes = Math.max(5, settings.ordersPollMinutes);

  const rows = await query<PollRow>(
    `SELECT v.id
       FROM ${sil("sil_vendor_orders")} v
      WHERE v.dry_run = 0
        AND v.vendor_order_number IS NOT NULL
        AND v.status IN ('submitted','confirmed','dispatched')
        AND (v.last_polled_at IS NULL
             OR v.last_polled_at <= NOW() - INTERVAL ? MINUTE)
      ORDER BY v.last_polled_at IS NOT NULL, v.last_polled_at ASC
      LIMIT ?`,
    [minutes, limit],
  );

  let n = 0;
  for (const row of rows) {
    try {
      const result = await pollVendorOrder(row.id);
      n++;
      if (result.parcels > 0) {
        log.info(`order ${row.id}: ${result.parcels} new parcel(s), ${result.pushed} pushed to WC`);
      }
    } catch (err) {
      log.error(`poll failed for vendor order ${row.id}`, String(err));
      await recordEvent("error", "tracking", `poll failed for ${row.id}: ${String(err)}`);
    }
  }
  return n;
}
