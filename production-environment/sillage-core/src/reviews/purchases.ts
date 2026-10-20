/**
 * Whether a signed-in customer actually bought the product they are reviewing.
 *
 * WooCommerce is the record of a sale, so the check reads the shop's own HPOS tables rather than
 * asking the browser or trusting the storefront. An order counts when it exists, belongs to that
 * customer (by account id, or by the billing email on the order — a guest purchase later linked to
 * an account still counts), is in a paid state, and has a line whose product or variation carries
 * the EAN.
 *
 * The EAN is resolved through Sillage's index first (one product can carry up to 26 barcodes, which
 * is why they are not a postmeta row) and only then through WooCommerce's GTIN field. Any database
 * error denies the review: it is better to show "we could not verify your purchase" than to publish
 * a review from someone who never bought.
 */
import { sil, wp } from "../config/env.ts";
import { query, type RowDataPacket } from "../db/pool.ts";
import { logger } from "../lib/log.ts";

const log = logger("reviews");

/** Paid orders. A cancelled, failed, refunded or pending order is not a purchase. */
export const PURCHASED_STATUSES = ["wc-processing", "wc-completed"] as const;

interface IdRow extends RowDataPacket {
  id: number;
}

async function productIdsForEan(ean: string): Promise<number[]> {
  try {
    const indexed = await query<IdRow>(
      `SELECT DISTINCT wp_post_id AS id FROM ${sil("sil_ean_index")} WHERE ean = ? LIMIT 50`,
      [ean],
    );
    if (indexed.length) return indexed.map((row) => Number(row.id));
  } catch {
    // An older install may not have the index yet; the product's own field still answers.
  }

  // The index is written by the catalogue sync; a product added minutes ago may not be in it yet.
  try {
    const primary = await query<IdRow>(
      `SELECT DISTINCT post_id AS id FROM ${wp("postmeta")}
        WHERE meta_key IN ('_global_unique_id', '_sillage_ean') AND meta_value = ? LIMIT 50`,
      [ean],
    );
    return primary.map((row) => Number(row.id));
  } catch (err) {
    log.warn("could not resolve an EAN to a product", String(err));
    return [];
  }
}

export interface PurchasedProduct {
  ean: string;
  productSlug: string;
  productName: string;
  orderId: number;
  orderNumber: string;
  orderStatus: string;
  orderedAt: string;
  /** True once every shipment on that order has arrived (or been cancelled). */
  delivered: boolean;
  deliveredAt: string | null;
}

interface PurchaseRow extends RowDataPacket {
  ean: string;
  item_name: string;
  wp_post_id: number | null;
  slug: string | null;
  post_title: string | null;
  wc_order_id: number;
  wc_order_number: string | null;
  vendor_status: string;
  delivered_at: string | null;
  order_status: string;
  ordered_at: string | null;
}

/**
 * Every product this customer bought, newest order first, with the delivery state of its order.
 *
 * The account's review tab is a list of real purchases, so it reads the same vendor orders the
 * shop dispatched rather than trusting a product list from the browser. A product bought twice
 * appears once, at its most recent order.
 */
export async function listPurchases(
  customerId: number | null,
  email: string,
): Promise<PurchasedProduct[]> {
  const owner = customerId && customerId > 0 ? "o.customer_id = ?" : "1 = 0";
  const ownerParams = customerId && customerId > 0 ? [customerId] : [];
  const mail = email ? "LOWER(a.email) = LOWER(?)" : "1 = 0";
  const mailParams = email ? [email] : [];
  const statuses = PURCHASED_STATUSES.map(() => "?").join(",");

  let rows: PurchaseRow[];
  try {
    rows = await query<PurchaseRow>(
      `SELECT i.ean, i.name AS item_name, i.wp_post_id,
              p.post_name AS slug, p.post_title,
              v.wc_order_id, v.wc_order_number,
              v.status AS vendor_status, v.delivered_at,
              o.status AS order_status, o.date_created_gmt AS ordered_at
         FROM ${sil("sil_vendor_order_items")} i
         JOIN ${sil("sil_vendor_orders")} v ON v.id = i.vendor_order_id
         JOIN ${wp("wc_orders")} o
           ON o.id = v.wc_order_id AND o.type = 'shop_order'
         JOIN ${wp("wc_order_addresses")} a
           ON a.order_id = o.id AND a.address_type = 'billing'
         LEFT JOIN ${wp("posts")} p ON p.ID = i.wp_post_id
        WHERE v.dry_run = 0
          AND i.ean IS NOT NULL AND i.ean <> ''
          AND o.status IN (${statuses})
          AND (${owner} OR ${mail})
        ORDER BY o.date_created_gmt DESC, v.id DESC`,
      [...PURCHASED_STATUSES, ...ownerParams, ...mailParams],
    );
  } catch (err) {
    log.warn("could not list a customer's purchases", String(err));
    return [];
  }

  // A mixed order has one vendor row per warehouse; it counts as delivered only when every one
  // of them has arrived (or was cancelled), and the date is the last arrival.
  const byOrder = new Map<
    number,
    { delivered: boolean; deliveredAt: number | null; rows: PurchaseRow[] }
  >();
  for (const row of rows) {
    const state = byOrder.get(Number(row.wc_order_id)) ?? {
      delivered: true,
      deliveredAt: null,
      rows: [],
    };
    state.rows.push(row);
    if (row.vendor_status !== "delivered" && row.vendor_status !== "cancelled") state.delivered = false;
    if (row.vendor_status === "delivered" && row.delivered_at) {
      const stamp = Date.parse(String(row.delivered_at).replace(" ", "T") + "Z");
      if (Number.isFinite(stamp)) state.deliveredAt = Math.max(state.deliveredAt ?? 0, stamp);
    }
    byOrder.set(Number(row.wc_order_id), state);
  }

  const seen = new Set<string>();
  const purchases: PurchasedProduct[] = [];
  for (const row of rows) {
    const ean = String(row.ean);
    if (!/^\d{8,14}$/.test(ean) || seen.has(ean)) continue;
    seen.add(ean);

    const state = byOrder.get(Number(row.wc_order_id));
    const deliveredAt = state?.deliveredAt
      ? new Date(state.deliveredAt).toISOString().replace(".000Z", "Z")
      : null;

    purchases.push({
      ean,
      productSlug: String(row.slug ?? ""),
      productName: String(row.post_title ?? row.item_name ?? ""),
      orderId: Number(row.wc_order_id),
      orderNumber: String(row.wc_order_number ?? row.wc_order_id),
      orderStatus: String(row.order_status ?? ""),
      orderedAt: String(row.ordered_at ?? ""),
      delivered: Boolean(state?.delivered),
      deliveredAt,
    });
  }
  return purchases;
}

/** True when this customer has a paid order line for a product carrying this EAN. */
export async function hasPurchased(
  ean: string,
  customerId: number | null,
  email: string,
): Promise<boolean> {
  const ids = (await productIdsForEan(ean)).filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return false;

  const placeholders = ids.map(() => "?").join(",");
  const statuses = PURCHASED_STATUSES.map(() => "?").join(",");
  const owner = customerId && customerId > 0 ? "o.customer_id = ?" : "1 = 0";
  const ownerParams = customerId && customerId > 0 ? [customerId] : [];
  const mail = email ? "LOWER(a.email) = LOWER(?)" : "1 = 0";
  const mailParams = email ? [email] : [];

  try {
    const rows = await query<RowDataPacket>(
      `SELECT 1 AS found
         FROM ${wp("wc_orders")} o
         JOIN ${wp("wc_order_addresses")} a
           ON a.order_id = o.id AND a.address_type = 'billing'
         JOIN ${wp("woocommerce_order_items")} i
           ON i.order_id = o.id AND i.order_item_type = 'line_item'
         JOIN ${wp("woocommerce_order_itemmeta")} m
           ON m.order_item_id = i.order_item_id
          AND m.meta_key IN ('_product_id', '_variation_id')
        WHERE o.type = 'shop_order'
          AND o.status IN (${statuses})
          AND (${owner} OR ${mail})
          AND m.meta_value IN (${placeholders})
        LIMIT 1`,
      [...PURCHASED_STATUSES, ...ownerParams, ...mailParams, ...ids],
    );
    return rows.length > 0;
  } catch (err) {
    // Denying is the safe failure: no review is published on the strength of a broken query.
    log.warn("purchase check failed; refusing the review", String(err));
    return false;
  }
}
