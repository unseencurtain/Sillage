/**
 * Whether a signed-in customer actually bought the product they are reviewing.
 *
 * WooCommerce is the record of a sale, so the check reads the shop's own HPOS tables rather than
 * asking the browser or trusting the storefront. An order counts when it exists, belongs to that
 * customer (by account id, or by the billing email on the order — a guest purchase later linked to
 * an account still counts), is in a paid state, and has a line whose product or variation carries
 * the EAN.
 *
 * Delivery is part of the check: a review opens only after the goods arrived. A mixed order has one
 * vendor row per warehouse and is reviewable only once every row is delivered or cancelled, so a
 * customer waiting on a second parcel is not asked to review half an order. The line itself must
 * also have been delivered; a cancelled line is never reviewable.
 *
 * Dry-run orders are deliberately included. They are real WooCommerce orders the customer can see
 * in their account, and their vendor rows still record a delivery rehearsal; the reminder sender
 * excludes them separately, so a test order can never trigger an email.
 *
 * Any database error denies the review: it is better to show "we could not verify your purchase"
 * than to publish a review from someone who never bought.
 */
import { sil, wp } from "../config/env.ts";
import { query, type RowDataPacket } from "../db/pool.ts";
import { logger } from "../lib/log.ts";

const log = logger("reviews");

/** Paid orders. A cancelled, failed, refunded or pending order is not a purchase. */
export const PURCHASED_STATUSES = ["wc-processing", "wc-completed"] as const;

export interface PurchasedProduct {
  ean: string;
  productSlug: string;
  productName: string;
  orderId: number;
  orderNumber: string;
  orderStatus: string;
  orderedAt: string;
  /** True once every shipment on that order has arrived (or been cancelled) and this line arrived. */
  delivered: boolean;
  deliveredAt: string | null;
}

interface PurchaseRow extends RowDataPacket {
  ean: string | null;
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
 * appears once: the most recent delivered order wins, because that is the one that makes it
 * reviewable; otherwise the most recent order is shown with its delivery note.
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
    // Every line is read, including lines without an EAN: they cannot be reviewed, but their
    // warehouse still has to arrive before the order counts as delivered.
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
        WHERE o.status IN (${statuses})
          AND (${owner} OR ${mail})
        ORDER BY o.date_created_gmt DESC, v.id DESC, i.id DESC`,
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
    { delivered: boolean; deliveredAt: number | null }
  >();
  for (const row of rows) {
    const orderId = Number(row.wc_order_id);
    const state = byOrder.get(orderId) ?? { delivered: true, deliveredAt: null };
    if (row.vendor_status !== "delivered" && row.vendor_status !== "cancelled") state.delivered = false;
    if (row.vendor_status === "delivered" && row.delivered_at) {
      const stamp = Date.parse(String(row.delivered_at).replace(" ", "T") + "Z");
      if (Number.isFinite(stamp)) state.deliveredAt = Math.max(state.deliveredAt ?? 0, stamp);
    }
    byOrder.set(orderId, state);
  }

  const byEan = new Map<string, PurchasedProduct>();
  for (const row of rows) {
    // A cancelled line is not a purchase waiting to arrive, and it can never open a review.
    if (row.vendor_status === "cancelled") continue;

    const ean = String(row.ean ?? "");
    if (!/^\d{8,14}$/.test(ean)) continue;

    const state = byOrder.get(Number(row.wc_order_id));
    // A cancelled line on an otherwise settled order is not a purchase the customer can review.
    const delivered = Boolean(state?.delivered) && row.vendor_status === "delivered";
    const deliveredAt =
      delivered && state?.deliveredAt
        ? new Date(state.deliveredAt).toISOString().replace(".000Z", "Z")
        : null;

    const candidate: PurchasedProduct = {
      ean,
      productSlug: String(row.slug ?? ""),
      productName: String(row.post_title ?? row.item_name ?? ""),
      orderId: Number(row.wc_order_id),
      orderNumber: String(row.wc_order_number ?? row.wc_order_id),
      orderStatus: String(row.order_status ?? ""),
      orderedAt: String(row.ordered_at ?? ""),
      delivered,
      deliveredAt,
    };

    const existing = byEan.get(ean);
    // Keep a delivered order in preference to a newer one that is still in transit.
    if (!existing || (!existing.delivered && candidate.delivered)) byEan.set(ean, candidate);
  }

  return [...byEan.values()].sort(
    (a, b) =>
      String(b.orderedAt).localeCompare(String(a.orderedAt)) || b.orderId - a.orderId,
  );
}

/** True when this customer has a delivered line for a product carrying this EAN. */
export async function hasPurchased(
  ean: string,
  customerId: number | null,
  email: string,
): Promise<boolean> {
  const purchases = await listPurchases(customerId, email);
  return purchases.some((purchase) => purchase.ean === ean && purchase.delivered);
}
