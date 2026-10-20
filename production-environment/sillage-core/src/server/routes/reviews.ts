/**
 * Public product reviews: read an EAN's rating and rows, ask whether the signed-in customer may
 * review the product, and accept their review.
 *
 * Mounted at `/api/public` beside the contact and withdrawal forms, so the storefront reaches it on
 * its own origin (`/sillagedash/api/public/reviews`) and Caddy strips `/sillagedash` back to
 * `/api/public`. Only `published` rows leave the server.
 *
 * Who may write one is deliberately narrow: a signed-in WordPress customer who has a paid order for
 * a product carrying that EAN (see `reviews/purchases.ts`). A new row is `pending` — an operator
 * approves it in the dashboard before it is public or counts toward the rating.
 *
 * The protections are the ones the forms use — a honeypot, a per-IP rate limit counted in the
 * reviews table itself, a spam-word/link filter and the form's own elapsed time — plus the account
 * and purchase check, which no field in the request can influence.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import {
  hashIp,
  isEan,
  reviewsStore,
  type ReviewStatus,
} from "../../reviews/store.ts";
import { hasPurchased } from "../../reviews/purchases.ts";
import { sessionFor } from "../storefrontSession.ts";
import { looksLikeSpam, tooFast } from "./forms.ts";

export const reviews = new Hono();

reviews.use(
  "*",
  bodyLimit({
    maxSize: 16 * 1024,
    onError: (c) => c.json({ ok: false, error: "invalid" }, 413),
  }),
);

/** Reviews allowed from one client inside the window. A customer reviews a product once anyway. */
const RATE_LIMIT = 6;
const RATE_WINDOW_MINUTES = 60;
/** Field a bot fills and a shopper never sees. */
const HONEYPOT = "website";

type Body = Record<string, unknown>;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function clientIp(c: Context): string {
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim().slice(0, 45);
  return (c.req.header("x-real-ip") ?? "").slice(0, 45);
}

async function readBody(c: Context): Promise<Body | null> {
  try {
    const body = await c.req.json<unknown>();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Body) : null;
  } catch {
    return null;
  }
}

/** One product's public rating and its approved reviews, newest first. */
reviews.get("/reviews", (c) => {
  const ean = c.req.query("ean")?.trim() ?? "";
  if (!isEan(ean)) return c.json({ ok: false, error: "invalid" }, 400);

  const store = reviewsStore();
  const summary = store.summary(ean);
  const rows = store.list(ean);
  // Short public cache: an approved review shows up within a minute, and a busy product page does
  // not make SQLite answer every visitor.
  c.header("Cache-Control", "public, max-age=60");
  return c.json({
    ok: true,
    ean,
    count: summary.count,
    average: summary.average,
    reviews: rows,
  });
});

/** The aggregate for several products at once — used by cards and the prerendered-page check. */
reviews.get("/reviews/summary", (c) => {
  const raw = c.req.query("eans")?.trim() ?? "";
  const eans = [...new Set(raw.split(",").map((value) => value.trim()).filter(isEan))].slice(0, 100);
  if (eans.length === 0) return c.json({ ok: false, error: "invalid" }, 400);

  const store = reviewsStore();
  const summaries: Record<string, { count: number; average: number }> = {};
  for (const ean of eans) {
    const summary = store.summary(ean);
    summaries[ean] = { count: summary.count, average: summary.average };
  }
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ ok: true, summaries });
});

/**
 * Whether this browser's session may review this product. The storefront asks before it draws the
 * form, so a guest gets "sign in to review" rather than a form that ends in a refusal. It reveals
 * only the caller's own purchase state.
 */
reviews.get("/reviews/eligibility", async (c) => {
  const ean = c.req.query("ean")?.trim() ?? "";
  if (!isEan(ean)) return c.json({ ok: false, error: "invalid" }, 400);
  // The answer depends on the cookie, so no shared or browser cache may keep the guest answer
  // after the shopper signs in.
  c.header("Cache-Control", "private, no-store");

  const session = await sessionFor(c);
  if (!session.signedIn) {
    return c.json({ ok: true, signedIn: false, purchased: false, reviewed: false, canReview: false });
  }

  const purchased = await hasPurchased(ean, session.customerId, session.email);
  const store = reviewsStore();
  const reviewed = store.hasReviewFrom(ean, session.customerId ?? 0, session.email);
  return c.json({
    ok: true,
    signedIn: true,
    purchased,
    reviewed,
    canReview: purchased && !reviewed,
  });
});

reviews.post("/reviews", async (c) => {
  const body = await readBody(c);
  if (!body) return c.json({ ok: false, error: "invalid" }, 400);
  // A filled honeypot answers "accepted" and stores nothing, exactly like the forms.
  if (text(body[HONEYPOT], 100) !== "") return c.json({ ok: true, pending: true });

  const session = await sessionFor(c);
  if (!session.signedIn) return c.json({ ok: false, error: "sign_in_required" }, 401);

  const ip = clientIp(c);
  const store = reviewsStore();
  const ipHash = ip ? hashIp(ip) : "";
  if (ipHash && store.countRecentFromIp(ipHash, RATE_WINDOW_MINUTES) >= RATE_LIMIT) {
    return c.json({ ok: false, error: "rate_limited" }, 429);
  }

  const ean = text(body.ean, 14);
  const name = text(body.name, 80) || session.name;
  const rating = Number(body.rating);
  const title = text(body.title, 120);
  const review = text(body.body, 4000);
  const productSlug = text(body.productSlug, 191);
  const productName = text(body.productName, 191);
  const locale = text(body.locale, 8);

  if (!isEan(ean) || !name || !Number.isInteger(rating) || rating < 1 || rating > 5) {
    return c.json({ ok: false, error: "invalid" }, 400);
  }
  if (looksLikeSpam([name, title, review])) return c.json({ ok: false, error: "spam" }, 400);
  if (tooFast(body)) return c.json({ ok: false, error: "too_fast" }, 400);

  // Order checks come last: they are the expensive part and only a plausible review should cost one.
  if (!(await hasPurchased(ean, session.customerId, session.email))) {
    return c.json({ ok: false, error: "not_purchased" }, 403);
  }
  if (store.hasReviewFrom(ean, session.customerId ?? 0, session.email)) {
    return c.json({ ok: false, error: "already_reviewed" }, 409);
  }

  const stored = store.insert({
    ean,
    productSlug,
    productName,
    name,
    email: session.email,
    rating,
    title,
    body: review,
    locale,
    customerId: session.customerId,
    ip,
    status: "pending" satisfies ReviewStatus,
  });

  return c.json({
    ok: true,
    pending: true,
    review: {
      id: stored.id,
      ean: stored.ean,
      rating: stored.rating,
      title: stored.title,
      body: stored.body,
      createdAt: stored.createdAt,
    },
  });
});
