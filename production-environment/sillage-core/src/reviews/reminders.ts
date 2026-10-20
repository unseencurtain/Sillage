/**
 * Review reminder emails.
 *
 * The shop's own order status is the clock: a mixed cart produces one vendor order per warehouse,
 * and WooCommerce marks the order completed only when every one of them is delivered or cancelled.
 * The reminder is therefore sent a configurable number of days (default 3, Settings → Review
 * reminders) after the *last* shipment arrives, never after the first one — a customer waiting on a
 * second parcel is not asked to review half an order.
 *
 * `sil_review_reminders` is the send log, not a queue. A failed attempt is recorded so the next
 * cron tick does not hammer a dead relay, and `sent_at` is written only after SMTP accepted the
 * message. The message links to the order in the account, where every purchased line offers its
 * own review form.
 */
import { sil, wp } from "../config/env.ts";
import { execute, query, type RowDataPacket } from "../db/pool.ts";
import { loadSettings, recordEvent } from "../db/settings.ts";
import { loadIdentity } from "../identity/identity.ts";
import { logger } from "../lib/log.ts";
import { mailAuth, mailConfigured, sendMail } from "../lib/mail.ts";
import { readWooOrder } from "../orders/ingest.ts";

const log = logger("review-reminders");

/** Fallback when the setting has never been saved. */
export const DEFAULT_REMINDER_DAYS = 3;
/** A failed relay is retried at most once an hour, not on every scheduler tick. */
const RETRY_MINUTES = 60;

interface CandidateRow extends RowDataPacket {
  wc_order_id: number;
  wc_order_number: string | null;
  delivered_at: string;
}

interface ItemRow extends RowDataPacket {
  ean: string | null;
  name: string;
  quantity: number;
}

async function candidates(limit: number, days: number): Promise<CandidateRow[]> {
  return query<CandidateRow>(
    `SELECT v.wc_order_id,
            MAX(v.wc_order_number) AS wc_order_number,
            MAX(v.delivered_at) AS delivered_at,
            MAX(r.sent_at) AS sent_at,
            MAX(r.last_attempt_at) AS last_attempt_at
       FROM ${sil("sil_vendor_orders")} v
       JOIN ${wp("wc_orders")} o
         ON o.id = v.wc_order_id AND o.type = 'shop_order'
        AND o.status IN ('wc-processing','wc-completed')
       LEFT JOIN ${sil("sil_review_reminders")} r ON r.wc_order_id = v.wc_order_id
      WHERE v.dry_run = 0
      GROUP BY v.wc_order_id
     HAVING SUM(v.status NOT IN ('delivered','cancelled')) = 0
        AND SUM(v.status = 'delivered') > 0
        AND MAX(v.delivered_at) <= NOW() - INTERVAL ${days} DAY
        AND sent_at IS NULL
        AND (last_attempt_at IS NULL OR last_attempt_at <= NOW() - INTERVAL ${RETRY_MINUTES} MINUTE)
      ORDER BY MAX(v.delivered_at) ASC
      LIMIT ?`,
    [limit],
  );
}

async function itemsFor(wcOrderId: number): Promise<ItemRow[]> {
  return query<ItemRow>(
    `SELECT i.ean, i.name, i.quantity
       FROM ${sil("sil_vendor_order_items")} i
       JOIN ${sil("sil_vendor_orders")} v ON v.id = i.vendor_order_id
      WHERE v.wc_order_id = ? AND v.dry_run = 0 AND v.status = 'delivered'
      ORDER BY i.id ASC`,
    [wcOrderId],
  );
}

/** Claim the attempt before sending, so two ticks cannot both mail the same order. */
async function beginAttempt(wcOrderId: number, email: string): Promise<void> {
  await execute(
    `INSERT INTO ${sil("sil_review_reminders")} (wc_order_id, email, attempts, last_attempt_at)
     VALUES (?, ?, 1, NOW())
     ON DUPLICATE KEY UPDATE
       email = VALUES(email),
       attempts = attempts + 1,
       last_attempt_at = NOW()`,
    [wcOrderId, email],
  );
}

async function finishAttempt(
  wcOrderId: number,
  sent: boolean,
  error: string | null,
): Promise<void> {
  await execute(
    `UPDATE ${sil("sil_review_reminders")}
        SET sent_at = IF(?, NOW(), sent_at),
            last_error = ?
      WHERE wc_order_id = ?`,
    [sent ? 1 : 0, error?.slice(0, 1000) ?? null, wcOrderId],
  );
}

function displayName(order: Awaited<ReturnType<typeof readWooOrder>>): string {
  const first = order?.billing.firstName?.trim() ?? "";
  return first;
}

function productLine(item: ItemRow): string {
  const quantity = Number(item.quantity) || 1;
  return quantity > 1 ? `${item.name} (×${quantity})` : item.name;
}

/** Send the due reminders. Returns how many messages SMTP accepted. */
export async function sendReviewReminders(limit = 20): Promise<number> {
  const [settings, identity] = await Promise.all([loadSettings(), loadIdentity()]);
  const auth = mailAuth(settings.mailUsername, settings.mailPassword);
  // Without credentials every attempt would fail every hour and fill the events table. Wait for
  // the operator to finish Settings → Email sending; the orders stay eligible.
  if (!mailConfigured(auth)) return 0;

  const days = Math.max(
    1,
    Math.min(60, Math.trunc(settings.reviewReminderDays) || DEFAULT_REMINDER_DAYS),
  );
  const due = await candidates(Math.max(1, Math.min(100, limit)), days);
  if (due.length === 0) return 0;

  const shop = (settings.wpBaseUrl || "").replace(/\/$/, "");
  const from = identity.sender_email || settings.mailUsername || auth.user;
  const fromName = identity.store_name || "PrinsCosmetic";
  const replyTo = identity.reply_to || identity.support_email || from;

  let sent = 0;
  for (const row of due) {
    const order = await readWooOrder(Number(row.wc_order_id));
    const email = order?.billing.email?.trim() ?? "";
    if (!order || !email) {
      await beginAttempt(Number(row.wc_order_id), email);
      await finishAttempt(Number(row.wc_order_id), false, "order has no billing email");
      continue;
    }

    await beginAttempt(Number(row.wc_order_id), email);

    const items = (await itemsFor(Number(row.wc_order_id))).filter((item) => item.ean);
    const orderNumber = order.id ? String(row.wc_order_number ?? order.id) : String(row.wc_order_id);
    const orderUrl = shop ? `${shop}/account/orders/${order.id}` : "";
    const firstName = displayName(order);
    const productLinks = items.map((item) => {
      const url = orderUrl ? `${orderUrl}?review=${encodeURIComponent(String(item.ean))}` : "";
      return `- ${productLine(item)}${url ? `\n  ${url}` : ""}`;
    });

    const text = [
      firstName ? `Hi ${firstName},` : "Hello,",
      "",
      `Your order #${orderNumber} has arrived. We hope you are enjoying it.`,
      "",
      items.length
        ? "Tell us what you think — it takes a minute, and a review helps the next shopper choose:"
        : "Tell us what you think — it takes a minute, and a review helps the next shopper choose.",
      ...productLinks,
      "",
      orderUrl ? `Your order: ${orderUrl}` : "",
      "",
      "Thank you,",
      fromName,
    ]
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    const result = await sendMail(
      {
        from,
        fromName,
        to: [email],
        replyTo,
        subject: `How was your order #${orderNumber}?`,
        text,
      },
      auth,
    );

    if (result.ok) {
      sent++;
      await finishAttempt(Number(row.wc_order_id), true, null);
      await recordEvent("info", "reviews", `review reminder sent for order ${orderNumber}`);
    } else {
      await finishAttempt(Number(row.wc_order_id), false, result.error ?? "send failed");
      log.warn(`review reminder for order ${orderNumber} failed: ${result.error ?? "unknown"}`);
      await recordEvent("warn", "reviews", `review reminder failed for order ${orderNumber}`);
    }
  }

  return sent;
}
