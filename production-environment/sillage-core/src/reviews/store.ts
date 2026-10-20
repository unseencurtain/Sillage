/**
 * Product reviews and ratings, kept in SQLite rather than MariaDB.
 *
 * A review is one star rating (1–5) plus optional title and text, attached to a product by its EAN —
 * the same identifier the storefront already resolves for every product page. Nothing here touches
 * the WordPress or Sillage schemas: the file is a bind-mounted SQLite database beside the engine's
 * other data, so a review write can never queue behind a catalogue sync or a WordPress query.
 *
 * A new review is `pending`. Only an operator action in the Sillage dashboard moves it to
 * `published`; the storefront reads the aggregate and the published rows through
 * `/api/public/reviews`, and the product-page generator reads the same file with Python's `sqlite3`
 * to put `aggregateRating` into the prerendered JSON-LD.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { env } from "../config/env.ts";

export const REVIEW_STATUSES = ["pending", "published", "hidden"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface ReviewInput {
  ean: string;
  productSlug?: string;
  productName?: string;
  name: string;
  email?: string;
  rating: number;
  title?: string;
  body?: string;
  /** Uploaded file names, stored under the review's photo directory. */
  photos?: string[];
  /** Every submitted review has passed the paid-order check. Legacy rows default to true too. */
  verified?: boolean;
  /** The shopper's own yes/no answer to “Would you recommend this product?”. */
  recommends?: boolean | null;
  locale?: string;
  customerId?: number | null;
  ip?: string;
  status?: ReviewStatus;
}

/** A row as the dashboard sees it, including moderation state. */
export interface AdminReview {
  id: number;
  ean: string;
  productSlug: string;
  productName: string;
  name: string;
  email: string;
  rating: number;
  title: string;
  body: string;
  photos: string[];
  verified: boolean;
  recommends: boolean | null;
  helpfulCount: number;
  locale: string;
  customerId: number | null;
  createdAt: string;
  status: ReviewStatus;
}

/** A row as the storefront sees it: approved copy only, no customer identity beyond the name. */
export interface Review {
  id: number;
  ean: string;
  name: string;
  rating: number;
  title: string;
  body: string;
  photos: string[];
  verified: boolean;
  recommends: boolean | null;
  helpfulCount: number;
  createdAt: string;
}

export interface ReviewSummary {
  ean: string;
  count: number;
  /** One decimal, or 0 when there are no published reviews. */
  average: number;
}

export interface DashboardQuery {
  status?: ReviewStatus | "all";
  page?: number;
  limit?: number;
}

export interface DashboardPage {
  items: AdminReview[];
  total: number;
  counts: Record<ReviewStatus, number>;
}

export interface ReviewsStore {
  insert(input: ReviewInput): AdminReview;
  /** Published rows for one product, newest first. */
  list(ean: string, limit?: number): Review[];
  summary(ean: string): ReviewSummary;
  summaries(eans: string[]): Map<string, ReviewSummary>;
  countRecentFromIp(ipHash: string, minutes: number): number;
  /** Whether this customer already reviewed this product (any status, so a refused row still blocks a second). */
  hasReviewFrom(ean: string, customerId: number, email: string): boolean;
  /** This customer's own rows, any moderation state — the account's review list. */
  mine(customerId: number, email: string): AdminReview[];
  /** Record one helpful vote from this hashed client address; returns the new count, or null if unknown. */
  markHelpful(id: number, ipHash: string): number | null;
  /** Replace a row's photos after the files have been written. */
  setPhotos(id: number, photos: string[]): boolean;
  dashboard(query?: DashboardQuery): DashboardPage;
  setStatus(id: number, status: ReviewStatus): boolean;
  /** Remove a row and return it, so its photo files can be removed from disk too. */
  delete(id: number): AdminReview | null;
  close(): void;
}

/** A barcode, exactly as the storefront's EAN route accepts it. */
export function isEan(value: unknown): value is string {
  return typeof value === "string" && /^\d{8,14}$/.test(value);
}

/**
 * The only shape a stored photo name may have: 16 random bytes and an extension the upload gate
 * accepts. Keeping the check here means a malformed or hand-edited row can never become a path or
 * a public URL; the upload route and the photo route both use this same rule.
 */
export const REVIEW_PHOTO_NAME = /^[a-f0-9]{32}\.(jpg|png|webp)$/;

/**
 * Store the client address only as a salted hash: it exists to rate-limit a single browser, and a
 * review has no business carrying a readable IP after the request ends.
 */
export function hashIp(ip: string, salt = "sillage-reviews"): string {
  return createHash("sha256").update(`${salt}|${ip}`).digest("hex").slice(0, 32);
}

/** `4.5` rather than `4.499999…`, and `0` rather than `null` for an empty product. */
export function roundAverage(value: number | null | undefined): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.round(number * 10) / 10;
}

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === "string" && (REVIEW_STATUSES as readonly string[]).includes(value);
}

function migrate(db: Database): void {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS reviews (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ean           TEXT    NOT NULL,
      product_slug  TEXT    NOT NULL DEFAULT '',
      product_name  TEXT    NOT NULL DEFAULT '',
      name          TEXT    NOT NULL,
      email         TEXT    NOT NULL DEFAULT '',
      rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      title         TEXT    NOT NULL DEFAULT '',
      body          TEXT    NOT NULL DEFAULT '',
      photos        TEXT    NOT NULL DEFAULT '[]',
      verified      INTEGER NOT NULL DEFAULT 1,
      recommends    INTEGER,
      helpful_count INTEGER NOT NULL DEFAULT 0,
      locale        TEXT    NOT NULL DEFAULT '',
      customer_id   INTEGER,
      ip_hash       TEXT    NOT NULL DEFAULT '',
      status        TEXT    NOT NULL DEFAULT 'pending',
      created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_ean ON reviews (ean, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reviews_ip  ON reviews (ip_hash, created_at);
    CREATE TABLE IF NOT EXISTS review_helpful (
      review_id  INTEGER NOT NULL,
      ip_hash    TEXT    NOT NULL,
      created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      PRIMARY KEY (review_id, ip_hash)
    );
  `);

  // Columns added after the first deployment. SQLite has no `ADD COLUMN IF NOT EXISTS`, so ask.
  const columns = new Set(
    (db.query(`PRAGMA table_info(reviews)`).all() as Array<{ name: string }>).map((row) => row.name),
  );
  for (const [name, definition] of [
    ["product_name", "TEXT NOT NULL DEFAULT ''"],
    ["email", "TEXT NOT NULL DEFAULT ''"],
    ["photos", "TEXT NOT NULL DEFAULT '[]'"],
    ["verified", "INTEGER NOT NULL DEFAULT 1"],
    ["recommends", "INTEGER"],
    ["helpful_count", "INTEGER NOT NULL DEFAULT 0"],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE reviews ADD COLUMN ${name} ${definition}`);
  }
  // A row written before moderation existed is a review that was already public; keep it so.
  db.exec(`UPDATE reviews SET status = 'published' WHERE status = 'ok'`);
}

type Row = {
  id: number;
  ean: string;
  product_slug: string;
  product_name: string;
  name: string;
  email: string;
  rating: number;
  title: string;
  body: string;
  photos: string;
  verified: number;
  recommends: number | null;
  helpful_count: number;
  locale: string;
  customer_id: number | null;
  created_at: string;
  status: string;
};

/** A malformed or older value is an empty list, never a parse error on a read path. */
function photoNames(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((name): name is string => typeof name === "string" && REVIEW_PHOTO_NAME.test(name))
      .slice(0, 5);
  } catch {
    return [];
  }
}

function recommendsValue(value: number | null): boolean | null {
  return value === null ? null : Number(value) === 1;
}

function toAdmin(row: Row): AdminReview {
  return {
    id: Number(row.id),
    ean: String(row.ean),
    productSlug: String(row.product_slug ?? ""),
    productName: String(row.product_name ?? ""),
    name: String(row.name),
    email: String(row.email ?? ""),
    rating: Number(row.rating),
    title: String(row.title),
    body: String(row.body),
    photos: photoNames(row.photos),
    verified: Number(row.verified) !== 0,
    recommends: recommendsValue(row.recommends),
    helpfulCount: Number(row.helpful_count) || 0,
    locale: String(row.locale ?? ""),
    customerId: row.customer_id === null ? null : Number(row.customer_id),
    createdAt: String(row.created_at),
    status: isReviewStatus(row.status) ? row.status : "pending",
  };
}

function toPublic(row: Row): Review {
  return {
    id: Number(row.id),
    ean: String(row.ean),
    name: String(row.name),
    rating: Number(row.rating),
    title: String(row.title),
    body: String(row.body),
    photos: photoNames(row.photos),
    verified: Number(row.verified) !== 0,
    recommends: recommendsValue(row.recommends),
    helpfulCount: Number(row.helpful_count) || 0,
    createdAt: String(row.created_at),
  };
}

export function openReviews(path: string): ReviewsStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  migrate(db);

  const insertStmt = db.query(`
    INSERT INTO reviews
      (ean, product_slug, product_name, name, email, rating, title, body, photos, verified,
       recommends, locale, customer_id, ip_hash, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const byIdStmt = db.query(`SELECT * FROM reviews WHERE id = ?`);
  const listStmt = db.query(`
    SELECT * FROM reviews
    WHERE ean = ? AND status = 'published'
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);
  const summaryStmt = db.query(`
    SELECT COUNT(*) AS count, AVG(rating) AS average
    FROM reviews
    WHERE ean = ? AND status = 'published'
  `);
  const ipStmt = db.query(`
    SELECT COUNT(*) AS count
    FROM reviews
    WHERE ip_hash = ? AND created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?)
  `);
  const mineStmt = db.query(`
    SELECT 1 AS found FROM reviews
    WHERE ean = ? AND (customer_id = ? OR (email <> '' AND LOWER(email) = LOWER(?)))
    LIMIT 1
  `);
  const mineRowsStmt = db.query(`
    SELECT * FROM reviews
    WHERE (customer_id = ? AND ? > 0) OR (email <> '' AND LOWER(email) = LOWER(?))
    ORDER BY created_at DESC, id DESC
  `);
  const countByStatusStmt = db.query(`SELECT status, COUNT(*) AS count FROM reviews GROUP BY status`);
  const setStatusStmt = db.query(`UPDATE reviews SET status = ? WHERE id = ?`);
  const setPhotosStmt = db.query(`UPDATE reviews SET photos = ? WHERE id = ?`);
  // A pending or hidden row is not public, so it must not collect public votes either.
  const helpfulStmt = db.query(
    `SELECT helpful_count FROM reviews WHERE id = ? AND status = 'published'`,
  );
  const voteStmt = db.query(`INSERT OR IGNORE INTO review_helpful (review_id, ip_hash) VALUES (?, ?)`);
  const bumpHelpfulStmt = db.query(
    `UPDATE reviews SET helpful_count = helpful_count + 1 WHERE id = ?`,
  );
  const deleteStmt = db.query(`DELETE FROM reviews WHERE id = ?`);

  return {
    insert(input) {
      const result = insertStmt.run(
        input.ean,
        input.productSlug ?? "",
        input.productName ?? "",
        input.name,
        input.email ?? "",
        input.rating,
        input.title ?? "",
        input.body ?? "",
        JSON.stringify((input.photos ?? []).slice(0, 5)),
        input.verified === false ? 0 : 1,
        input.recommends === undefined || input.recommends === null ? null : input.recommends ? 1 : 0,
        input.locale ?? "",
        input.customerId ?? null,
        input.ip ? hashIp(input.ip) : "",
        input.status ?? "pending",
      );
      const row = byIdStmt.get(Number(result.lastInsertRowid)) as Row | null;
      if (!row) throw new Error("review insert returned no row");
      return toAdmin(row);
    },

    list(ean, limit = 50) {
      const rows = listStmt.all(ean, Math.max(1, Math.min(200, Math.trunc(limit)))) as Row[];
      return rows.map(toPublic);
    },

    summary(ean) {
      const row = summaryStmt.get(ean) as { count: number; average: number | null } | null;
      return {
        ean,
        count: Number(row?.count) || 0,
        average: roundAverage(row?.average),
      };
    },

    summaries(eans) {
      const map = new Map<string, ReviewSummary>();
      for (const ean of eans) map.set(ean, this.summary(ean));
      return map;
    },

    countRecentFromIp(ipHash, minutes) {
      const row = ipStmt.get(ipHash, `-${Math.max(1, Math.trunc(minutes))} minutes`) as {
        count: number;
      } | null;
      return Number(row?.count) || 0;
    },

    hasReviewFrom(ean, customerId, email) {
      const row = mineStmt.get(ean, customerId, email) as { found: number } | null;
      return Boolean(row?.found);
    },

    mine(customerId, email) {
      const rows = mineRowsStmt.all(customerId, customerId, email) as Row[];
      return rows.map(toAdmin);
    },

    markHelpful(id, ipHash) {
      const row = helpfulStmt.get(id) as { helpful_count: number } | null;
      if (!row) return null;
      if (ipHash) {
        const voted = voteStmt.run(id, ipHash);
        if (voted.changes > 0) bumpHelpfulStmt.run(id);
      }
      const next = helpfulStmt.get(id) as { helpful_count: number } | null;
      return Number(next?.helpful_count) || 0;
    },

    setPhotos(id, photos) {
      return setPhotosStmt.run(JSON.stringify(photos.slice(0, 5)), id).changes > 0;
    },

    dashboard({ status = "all", page = 1, limit = 25 } = {}) {
      const counts = { pending: 0, published: 0, hidden: 0 } satisfies Record<ReviewStatus, number>;
      for (const row of countByStatusStmt.all() as Array<{ status: string; count: number }>) {
        if (isReviewStatus(row.status)) counts[row.status] = Number(row.count) || 0;
      }

      const where = status === "all" ? "" : "WHERE status = ?";
      const args = status === "all" ? [] : [status];
      const totalRow = db
        .query(`SELECT COUNT(*) AS count FROM reviews ${where}`)
        .get(...args) as { count: number } | null;
      const offset = (Math.max(1, page) - 1) * limit;
      const rows = db
        .query(
          `SELECT * FROM reviews ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, Math.max(1, Math.min(100, limit)), offset) as Row[];

      return {
        items: rows.map(toAdmin),
        total: Number(totalRow?.count) || 0,
        counts,
      };
    },

    setStatus(id, status) {
      return setStatusStmt.run(status, id).changes > 0;
    },

    delete(id) {
      const row = byIdStmt.get(id) as Row | null;
      if (!row) return null;
      return deleteStmt.run(id).changes > 0 ? toAdmin(row) : null;
    },

    close() {
      db.close();
    },
  };
}

let singleton: ReviewsStore | null = null;

/** The engine's one store; the file path is `REVIEWS_DB` (bind-mounted under /app/data). */
export function reviewsStore(): ReviewsStore {
  singleton ??= openReviews(env.reviewsDb);
  return singleton;
}
