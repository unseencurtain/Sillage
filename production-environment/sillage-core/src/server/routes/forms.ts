/**
 * The two public storefront forms: Contact (`/contact`) and Right of Withdrawal (`/withdrawal-right`).
 *
 * These are the only unauthenticated writes in the engine, so they are deliberately thin and
 * paranoid, in the order a submission meets them: a honeypot field, a per-IP rate limit read from
 * the tables themselves, a required-fields check, a link/word spam filter, a time-trap (a form
 * answered in under two seconds is not a person), and — when the operator has set one — a Cloudflare
 * Turnstile challenge. Nothing here reads or returns a row: a submitter learns only that it was
 * accepted or refused, never whether an address is known.
 *
 * Mounted at `/api/public` *before* the session-guarded `/api`, so `requireSession` never sees it.
 * Caddy publishes that mount at `/api/public/...` on the shop's own origin; the old
 * `/sillagedash/api/public/...` names redirect there with `308`. The WordPress session cookie
 * rides along and is what tells us whether the sender was signed in. That answer comes from
 * WordPress, never from the browser's word.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { env } from "../../config/env.ts";
import { loadIdentity } from "../../identity/identity.ts";
import {
  countRecentFromIp,
  insertContact,
  insertWithdrawal,
  type MessageKind,
} from "../../messages/store.ts";
import { loadSettings, recordEvent } from "../../db/settings.ts";
import { logger } from "../../lib/log.ts";
import { mailAuth, mailConfigured, sendMail } from "../../lib/mail.ts";
import { sessionFor } from "../storefrontSession.ts";

const log = logger("forms");

export const forms = new Hono();

// A form post is a few kilobytes at most; anything larger is not a shopper. This limit belongs to
// the two form posts only, never to `*`: this app is mounted at `/api/public` and a wildcard would
// also cap the review endpoint's photo uploads at 64 KB.
const formBodyLimit = bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) => c.json({ ok: false, error: "invalid" }, 413),
});

/** Submissions allowed from one client inside the window. */
const RATE_LIMIT = 5;
const RATE_WINDOW_MINUTES = 15;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Field a bot fills and a shopper never sees. */
const HONEYPOT = "website";
/** Cloudflare's siteverify endpoint. Posted to with the operator's secret, never from the browser. */
const TURNSTILE_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** No person reads a form, decides what to write and sends it this fast. */
const MIN_FILL_MS = 2500;
/**
 * Link shapes that only turn up in the "we can rank your website" post. Bare domains are deliberately
 * limited to a suspicious TLD set — `.eu`, `.gr` and friends are the shop's own customers' addresses.
 */
const SPAM_LINK_RE =
  /(https?:\/\/|www\.|\b[\w-]{2,}\.(?:com|net|org|ru|cn|xyz|top|info|biz|online|shop|site|club|icu)\b)/i;
/** Phrases no genuine message to a cosmetics shop contains. Kept narrow on purpose: a false positive
 * refuses a real customer, so only near-certain junk is listed. */
const SPAM_WORDS = [
  "backlink",
  "guest post",
  "seo service",
  "seo expert",
  "rank your website",
  "rank your site",
  "buy followers",
  "bitcoin",
  "crypto",
  "casino",
  "viagra",
  "cialis",
  "escort",
  "porn",
];

type Body = Record<string, unknown>;

async function readBody(c: Context): Promise<Body | null> {
  try {
    const body = await c.req.json<unknown>();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Body) : null;
  } catch {
    return null;
  }
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function validEmail(value: unknown): string {
  const candidate = text(value, 191);
  return EMAIL_RE.test(candidate) ? candidate : "";
}

function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim().slice(0, 45);
  return (c.req.header("x-real-ip") ?? "").slice(0, 45);
}

/** A filled honeypot answers "accepted" and stores nothing — telling a bot it was caught only helps it. */
function honeypotTripped(body: Body): boolean {
  return text(body[HONEYPOT], 100) !== "";
}

/**
 * How long the shopper had the form open, in milliseconds, measured by the form itself. Anything
 * missing or unreadably small is a refusal: a shopper's browser always sends it, a POST assembled by
 * a script does not.
 */
export function tooFast(body: Body): boolean {
  const elapsed = Number(body.elapsedMs);
  return !Number.isFinite(elapsed) || elapsed < MIN_FILL_MS;
}

/**
 * Does any of the free text look like the spam this form actually receives?
 *
 * Email addresses are blanked first: a shopper writing "please reach me at jane@example.com" in the
 * message must not trip the domain test.
 */
export function looksLikeSpam(parts: string[]): boolean {
  const joined = parts.filter(Boolean).join("\n").toLowerCase();
  if (!joined) return false;
  const withoutEmails = joined.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, " ");
  if (SPAM_LINK_RE.test(withoutEmails)) return true;
  return SPAM_WORDS.some((word) => withoutEmails.includes(word));
}

/**
 * Check a Turnstile token with Cloudflare.
 *
 * Off until the operator sets a secret; when it is on, a token Cloudflare rejects is a refusal. But
 * Cloudflare being *unreachable* must not close the shop's contact form, so a transport failure is
 * recorded and the submission is let through — the honeypot, rate limit, time-trap and filters are
 * all still behind it.
 */
async function turnstileOk(token: string, ip: string): Promise<boolean> {
  const secret = env.turnstile.secret;
  if (!secret) return true;
  if (!token) return false;

  try {
    const form = new FormData();
    form.set("secret", secret);
    form.set("response", token);
    if (ip) form.set("remoteip", ip);

    const response = await fetch(TURNSTILE_URL, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      await recordEvent("warn", "messages", `Turnstile said HTTP ${response.status}; letting a submission through`);
      return true;
    }

    const data = (await response.json()) as { success?: boolean };
    return data?.success === true;
  } catch (err) {
    await recordEvent("warn", "messages", "Turnstile could not be reached; letting a submission through", {
      error: String(err),
    });
    return true;
  }
}

async function rateLimited(c: Context, ip: string): Promise<boolean> {
  if (await countRecentFromIp(ip, RATE_WINDOW_MINUTES) >= RATE_LIMIT) return true;
  return false;
}

/** Comma / space separated operator list, filtered to addresses that stand a chance. */
function recipientsFrom(value: string): string[] {
  return value
    .split(/[,;\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => EMAIL_RE.test(entry));
}

/** Join the parts of a notification body, dropping the blanks, with one blank line between blocks. */
function block(...parts: Array<string | false>): string {
  return parts.filter((part): part is string => Boolean(part)).join("\n\n");
}

/** The notification's subject and body, built from what the shopper typed. */
function summaryFor(kind: MessageKind, body: Body): { subject: string; text: string } {
  const name = text(body.name, 191);
  const email = text(body.email, 191);
  const order = text(body.orderRef, 64);
  const locale = text(body.locale, 8);
  const who = block(name, email).replace("\n\n", " · ");

  const header = block(who, order && `Order: ${order}`, locale && `Language: ${locale}`);

  if (kind === "contact") {
    const subject = text(body.subject, 255);
    const message = text(body.message, 5000);
    return {
      subject: subject ? `[Contact] ${subject}` : `[Contact] ${name || email}`,
      text: block(
        header,
        message,
        `— Sent from the shop's contact form. Reply to this email to answer ${name || "the customer"}.`,
      ),
    };
  }

  const goods = text(body.goods, 2000);
  const orderedOn = text(body.orderedOn, 20);
  const receivedOn = text(body.receivedOn, 20);
  const address = text(body.address, 1000);
  const comment = text(body.comment, 2000);

  return {
    subject: `[Withdrawal] ${order ? `order ${order}` : name || email}`,
    text: block(
      header,
      block("Goods:", goods),
      block(orderedOn && `Ordered on: ${orderedOn}`, receivedOn && `Received on: ${receivedOn}`),
      block(address && `Address:\n${address}`, comment && `Note:\n${comment}`),
      "— Sent from the shop's right-of-withdrawal form.",
    ),
  };
}

/**
 * Email the operator that a message arrived.
 *
 * Runs detached from the response — a shopper is confirmed as soon as the row is stored, never made
 * to wait on SMTP. Every failure is recorded as an event and the row is already safe, so mail being
 * down can never lose a message. `body` is the already-parsed request body: the raw stream cannot be
 * read twice.
 */
async function deliver(id: number, kind: MessageKind, body: Body): Promise<void> {
  try {
    const [identity, settings] = await Promise.all([loadIdentity(), loadSettings()]);

    // The credentials are Settings (Settings → Email sending), so they are read here, not at boot.
    const auth = mailAuth(settings.mailUsername, settings.mailPassword);
    if (!mailConfigured(auth)) {
      await recordEvent(
        "info",
        "messages",
        `message #${id} (${kind}) stored; mail is not configured`,
      );
      return;
    }

    const configured = recipientsFrom(settings.contactRecipients);
    const fallback = recipientsFrom([identity.support_email, identity.admin_email].join(","));
    const to = configured.length > 0 ? configured : fallback;

    if (to.length === 0) {
      await recordEvent("warn", "messages", `message #${id} (${kind}) stored; no notification recipient is set`);
      return;
    }

    const from = identity.sender_email || identity.admin_email;
    if (!EMAIL_RE.test(from)) {
      await recordEvent("warn", "messages", `message #${id} (${kind}) stored; no sender address is set`);
      return;
    }

    const summary = summaryFor(kind, body);
    const result = await sendMail(
      {
        from,
        fromName: identity.store_name || "Storefront",
        to,
        replyTo: text(body.email, 191),
        subject: summary.subject,
        text: summary.text,
      },
      auth,
    );

    if (result.ok) {
      await recordEvent("info", "messages", `message #${id} (${kind}) emailed to ${to.join(", ")}`);
    } else {
      await recordEvent("error", "messages", `message #${id} (${kind}) stored but not emailed: ${result.error}`, {
        id,
        kind,
      });
    }
  } catch (err) {
    log.error(`delivering notification for message #${id} failed`, String(err));
  }
}

/**
 * What the storefront needs before it can render a form: today only the Turnstile site key, which is
 * public by design. Read at render time rather than baked into the bundle, so the operator can turn
 * the challenge on or off from the dashboard without rebuilding the storefront.
 *
 * Cached for a minute in-process: the endpoint is unauthenticated, and it should not be a way to make
 * the engine read all of `sil_settings` on demand.
 */
const SITE_KEY_TTL_MS = 60_000;
let siteKeyCache: { value: string; at: number } | null = null;

forms.get("/forms", async (c) => {
  const now = Date.now();
  if (!siteKeyCache || now - siteKeyCache.at > SITE_KEY_TTL_MS) {
    const settings = await loadSettings();
    siteKeyCache = { value: settings.contactTurnstileSiteKey, at: now };
  }
  return c.json({ turnstileSiteKey: siteKeyCache.value });
});

forms.post("/contact", formBodyLimit, async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ ok: false, error: "invalid" }, 400);
  if (honeypotTripped(body)) return c.json({ ok: true });

  const ip = clientIp(c);
  if (await rateLimited(c, ip)) return c.json({ ok: false, error: "rate_limited" }, 429);

  const name = text(body.name, 191);
  const email = validEmail(body.email);
  const message = text(body.message, 5000);
  if (!name || !email || !message) return c.json({ ok: false, error: "invalid" }, 400);

  if (looksLikeSpam([name, text(body.subject, 255), message])) {
    return c.json({ ok: false, error: "spam" }, 400);
  }
  if (tooFast(body)) return c.json({ ok: false, error: "too_fast" }, 400);
  if (!(await turnstileOk(text(body.turnstileToken, 4096), ip))) {
    return c.json({ ok: false, error: "challenge" }, 400);
  }

  const session = await sessionFor(c);
  const id = await insertContact({
    name,
    email,
    phone: text(body.phone, 64),
    orderRef: text(body.orderRef, 64),
    subject: text(body.subject, 255),
    body: message,
    locale: text(body.locale, 8),
    signedIn: session.signedIn,
    customerId: session.customerId,
    ip,
    userAgent: text(c.req.header("user-agent"), 255),
  });

  void deliver(id, "contact", body);
  return c.json({ ok: true });
});

forms.post("/withdrawal", formBodyLimit, async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ ok: false, error: "invalid" }, 400);
  if (honeypotTripped(body)) return c.json({ ok: true });

  const ip = clientIp(c);
  if (await rateLimited(c, ip)) return c.json({ ok: false, error: "rate_limited" }, 429);

  const name = text(body.name, 191);
  const email = validEmail(body.email);
  const goods = text(body.goods, 2000);
  if (!name || !email || !goods) return c.json({ ok: false, error: "invalid" }, 400);

  if (looksLikeSpam([name, goods, text(body.comment, 2000)])) {
    return c.json({ ok: false, error: "spam" }, 400);
  }
  if (tooFast(body)) return c.json({ ok: false, error: "too_fast" }, 400);
  if (!(await turnstileOk(text(body.turnstileToken, 4096), ip))) {
    return c.json({ ok: false, error: "challenge" }, 400);
  }

  const session = await sessionFor(c);
  const id = await insertWithdrawal({
    name,
    email,
    orderRef: text(body.orderRef, 64),
    goods,
    orderedOn: text(body.orderedOn, 20),
    receivedOn: text(body.receivedOn, 20),
    address: text(body.address, 1000),
    comment: text(body.comment, 2000),
    locale: text(body.locale, 8),
    signedIn: session.signedIn,
    customerId: session.customerId,
    ip,
    userAgent: text(c.req.header("user-agent"), 255),
  });

  void deliver(id, "withdrawal", body);
  return c.json({ ok: true });
});
