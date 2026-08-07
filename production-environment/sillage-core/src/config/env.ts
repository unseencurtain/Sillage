import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${key}`);
}

function opt(key: string, fallback = ""): string {
  return process.env[key] ?? fallback;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new Error(`Environment variable ${key} must be an integer`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === "") return fallback;
  return v === "true" || v === "1" || v === "yes";
}

const rootDir = resolve(import.meta.dir, "../..");

export const env = {
  rootDir,
  nodeEnv: opt("NODE_ENV", "development"),
  isProduction: opt("NODE_ENV", "development") === "production",
  logLevel: opt("LOG_LEVEL", "info"),
  port: int("PORT", 4000),

  db: {
    host: str("DB_HOST", "127.0.0.1"),
    port: int("DB_PORT", 3307),
    user: str("DB_USER", "sillage"),
    password: str("SILLAGE_DB_PASSWORD"),
    /** sillage-core's own schema. */
    sillage: str("SILLAGE_DB", "sillage"),
    /** WordPress's schema. Both live on the same server so one connection spans them. */
    wordpress: str("WORDPRESS_DB", "earth"),
    wpPrefix: str("WP_TABLE_PREFIX", "wp_"),
    connectionLimit: int("DB_CONNECTION_LIMIT", 10),
  },

  wordpress: {
    baseUrl: str("WP_BASE_URL", "http://localhost").replace(/\/$/, ""),
    /** In-Docker URL for finalize / REST (e.g. http://ecom). Falls back to baseUrl. */
    internalUrl: (opt("WORDPRESS_INTERNAL_URL") || opt("WP_INTERNAL_URL") || "").replace(/\/$/, ""),
    sharedSecret: str("SILLAGE_SHARED_SECRET"),
  },

  beautyfort: {
    user: opt("BEAUTYFORT_USER"),
    secret: opt("BEAUTYFORT_SECRET"),
    endpoint: opt("BEAUTYFORT_ENDPOINT", "https://www.beautyfort.com/api/soap/v4"),
    testMode: bool("BEAUTYFORT_TEST_MODE", false),
  },

  bts: {
    token: opt("BTS_JWT_TOKEN"),
    baseUrl: opt("BTS_BASE_URL", "https://api.btswholesaler.com/v1/api"),
    language: opt("BTS_LANGUAGE", "en-US"),
  },

  wholesalePerfumes: {
    user: opt("WHOLESALE_PERFUMES_USER"),
    token: opt("WHOLESALE_PERFUMES_TOKEN"),
    catalogUrl: opt(
      "WHOLESALE_PERFUMES_CATALOG_URL",
      "https://www.wholesale-perfumes.eu/xml/catalog/LovelyXml/en",
    ),
    storeUrl: opt(
      "WHOLESALE_PERFUMES_STOCK_URL",
      "https://www.wholesale-perfumes.eu/xml/store/LovelyXml/EUR",
    ),
    apiBaseUrl: opt("WHOLESALE_PERFUMES_API_BASE_URL", "https://www.wholesale-perfumes.eu/api/v1"),
  },

  dashboard: {
    user: opt("DASHBOARD_USER", "admin"),
    password: opt("DASHBOARD_PASSWORD"),
    sessionSecret: opt("SESSION_SECRET") || randomBytes(32).toString("hex"),
  },

  fixturesDir: resolve(rootDir, opt("FIXTURES_DIR", "../../.feedscratch")),
} as const;

/** Fully-qualified WordPress table name. Never rely on a pooled connection's default schema. */
export function wp(table: string): string {
  return `\`${env.db.wordpress}\`.\`${env.db.wpPrefix}${table}\``;
}

/** Fully-qualified sillage table name. */
export function sil(table: string): string {
  return `\`${env.db.sillage}\`.\`${table}\``;
}
