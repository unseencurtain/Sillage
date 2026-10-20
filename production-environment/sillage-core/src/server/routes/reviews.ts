/**
 * Public product reviews: read an EAN's rating and rows, ask whether the signed-in customer may
 * review the product, and accept their review.
 *
 * Mounted at `/api/public` beside the contact and withdrawal forms, so the storefront reaches it on
 * its own origin (`/sillagedash/api/public/reviews`) and Caddy strips `/sillagedash` back to
 * `/api/public`. Only `published` rows leave the server.
 *
 * Who may write one is deliberately narrow: a signed-in WordPress customer whose order for a
 * product carrying that EAN has been delivered (see `reviews/purchases.ts`). A mixed order opens
 * only after its last parcel arrives. A new row is `pending` — an operator approves it in the
 * dashboard before it is public or counts toward the rating.
 *
 * The protections are the ones the forms use — a honeypot, a per-IP rate limit counted in the
 * reviews table itself, a spam-word/link filter and the form's own elapsed time — plus the account
 * and purchase check, which no field in the request can influence.
 */
import { randomBytes } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Context } from "hono";
import { env } from "../../config/env.ts";
import { logger } from "../../lib/log.ts";
import {
  hashIp,
  isEan,
  reviewsStore,
  type ReviewStatus,
} from "../../reviews/store.ts";
import { hasPurchased, listPurchases } from "../../reviews/purchases.ts";
import { sessionFor } from "../storefrontSession.ts";
import { looksLikeSpam, tooFast } from "./forms.ts";

const log = logger("reviews");

export const reviews = new Hono();

/** Five photos at 6 MB each, with room for the text fields around them. */
const UPLOAD_LIMIT = 32 * 1024 * 1024;
const TEXT_LIMIT = 16 * 1024;
const MAX_PHOTOS = 5;
const MAX_PHOTO_BYTES = 6 * 1024 * 1024;

reviews.use("*", (c, next) => {
  const multipart = (c.req.header("content-type") ?? "").includes("multipart/form-data");
  const maxSize = c.req.method === "POST" && multipart ? UPLOAD_LIMIT : TEXT_LIMIT;
  return bodyLimit({
    maxSize,
    onError: (ctx) => ctx.json({ ok: false, error: "invalid" }, 413),
  })(c, next);
});

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

interface ReviewRequest {
  body: Body;
  photos: File[];
}

/**
 * A review arrives either as JSON (no photos) or as multipart form data. Both carry the same
 * fields; the multipart body may also carry up to five `photos` files.
 */
async function readReviewRequest(c: Context): Promise<ReviewRequest | null> {
  const type = c.req.header("content-type") ?? "";
  if (!type.includes("multipart/form-data")) {
    const body = await readBody(c);
    return body ? { body, photos: [] } : null;
  }

  try {
    const form = await c.req.formData();
    const body: Body = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") body[key] = value;
    }
    const photos = form
      .getAll("photos")
      .filter((value): value is File => typeof value !== "string" && value.size > 0)
      .slice(0, MAX_PHOTOS);
    return { body, photos };
  } catch {
    return null;
  }
}

/** JPEG, PNG or WebP, decided by the bytes rather than the name the browser supplied. */
function imageExtension(bytes: Uint8Array): "jpg" | "png" | "webp" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "png";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "webp";
  }
  return null;
}

/**
 * Write validated photos under the reviews data directory and return their file names.
 * A file that is too large or not an image refuses the whole submission: a review that silently
 * lost the photos the shopper chose is worse than being asked to choose again.
 */
async function storePhotos(files: File[]): Promise<{ names: string[]; paths: string[] }> {
  const names: string[] = [];
  const paths: string[] = [];
  if (files.length === 0) return { names, paths };

  await mkdir(env.reviewsPhotoDir, { recursive: true });

  try {
    for (const file of files) {
      if (file.size <= 0 || file.size > MAX_PHOTO_BYTES) throw new Error("photo too large");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const extension = imageExtension(bytes);
      if (!extension) throw new Error("photo is not an image");

      const name = `${randomBytes(16).toString("hex")}.${extension}`;
      const path = join(env.reviewsPhotoDir, name);
      await writeFile(path, bytes, { flag: "wx" });
      names.push(name);
      paths.push(path);
    }
    return { names, paths };
  } catch (err) {
    await Promise.all(paths.map((path) => unlink(path).catch(() => undefined)));
    throw err;
  }
}

const PHOTO_NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

/** The clean public path a client should use; Caddy maps it onto this app's photo route. */
export function reviewPhotoPath(name: string): string {
  return `/reviews/photos/${name}`;
}

/** A customer-uploaded photo. Immutable because its name is random and never reused. */
reviews.get("/reviews/photo/:file", async (c) => {
  const name = c.req.param("file");
  if (!PHOTO_NAME.test(name)) return c.json({ ok: false, error: "not found" }, 404);

  const file = Bun.file(join(env.reviewsPhotoDir, name));
  if (!(await file.exists())) return c.json({ ok: false, error: "not found" }, 404);

  const type = extname(name) === ".png" ? "image/png" : extname(name) === ".webp" ? "image/webp" : "image/jpeg";
  return new Response(file, {
    headers: {
      "Content-Type": type,
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

/** The signed-in customer's own review rows, any moderation state. */
reviews.get("/reviews/mine", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const session = await sessionFor(c);
  if (!session.signedIn) return c.json({ ok: false, error: "sign_in_required" }, 401);

  const rows = reviewsStore().mine(session.customerId ?? 0, session.email);
  return c.json({
    ok: true,
    reviews: rows.map((row) => ({
      id: row.id,
      ean: row.ean,
      productSlug: row.productSlug,
      productName: row.productName,
      rating: row.rating,
      title: row.title,
      body: row.body,
      photos: row.photos,
      recommends: row.recommends,
      status: row.status,
      createdAt: row.createdAt,
    })),
  });
});

/**
 * The products this customer may review, taken from the shop's delivered orders. The account uses this
 * to offer a review per purchased item; the engine never trusts a product list from the browser.
 */
reviews.get("/reviews/purchases", async (c) => {
  c.header("Cache-Control", "private, no-store");
  const session = await sessionFor(c);
  if (!session.signedIn) return c.json({ ok: false, error: "sign_in_required" }, 401);

  const purchases = await listPurchases(session.customerId, session.email);
  const mine = reviewsStore().mine(session.customerId ?? 0, session.email);
  const byEan = new Map(mine.map((row) => [row.ean, row]));
  return c.json({
    ok: true,
    purchases: purchases.map((purchase) => {
      const review = byEan.get(purchase.ean);
      return {
        ...purchase,
        reviewStatus: review?.status ?? "none",
        reviewId: review?.id ?? null,
      };
    }),
  });
});

/** One helpful vote per client address, counted in the review row. */
reviews.post("/reviews/:id/helpful", (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: "invalid" }, 400);

  const ip = clientIp(c);
  const count = reviewsStore().markHelpful(id, ip ? hashIp(ip) : "");
  if (count === null) return c.json({ ok: false, error: "not_found" }, 404);
  return c.json({ ok: true, helpfulCount: count });
});

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
  const request = await readReviewRequest(c);
  if (!request) return c.json({ ok: false, error: "invalid" }, 400);
  const { body, photos } = request;
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
  const recommends =
    body.recommends === true || body.recommends === "true"
      ? true
      : body.recommends === false || body.recommends === "false"
        ? false
        : null;

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

  let storedPhotos: { names: string[]; paths: string[] } = { names: [], paths: [] };
  try {
    storedPhotos = await storePhotos(photos);
  } catch (err) {
    log.warn(`review photos refused: ${String(err)}`);
    return c.json({ ok: false, error: "invalid_photo" }, 400);
  }

  let stored;
  try {
    stored = store.insert({
      ean,
      productSlug,
      productName,
      name,
      email: session.email,
      rating,
      title,
      body: review,
      photos: storedPhotos.names,
      verified: true,
      recommends,
      locale,
      customerId: session.customerId,
      ip,
      status: "pending" satisfies ReviewStatus,
    });
  } catch (err) {
    await Promise.all(storedPhotos.paths.map((path) => unlink(path).catch(() => undefined)));
    throw err;
  }

  return c.json({
    ok: true,
    pending: true,
    review: {
      id: stored.id,
      ean: stored.ean,
      rating: stored.rating,
      title: stored.title,
      body: stored.body,
      photos: stored.photos,
      createdAt: stored.createdAt,
    },
  });
});
