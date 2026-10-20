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
