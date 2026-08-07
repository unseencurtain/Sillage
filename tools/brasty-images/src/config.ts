import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LogoPosition } from "./types.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

loadDotenv({ path: join(PKG_ROOT, ".env") });

function envString(key: string, fallback: string): string {
  const v = process.env[key];
  return v !== undefined && v.trim() !== "" ? v.trim() : fallback;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`Invalid integer for ${key}: ${raw}`);
  }
  return n;
}

function envFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`Invalid number for ${key}: ${raw}`);
  }
  return n;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const low = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(low)) return true;
  if (["0", "false", "no", "off"].includes(low)) return false;
  throw new Error(`Invalid boolean for ${key}: ${raw}`);
}

function resolvePath(p: string): string {
  if (isAbsolute(p)) return p;
  return resolve(PKG_ROOT, p);
}

function parseLogoPosition(raw: string): LogoPosition {
  const allowed: LogoPosition[] = [
    "bottom-right",
    "bottom-left",
    "top-right",
    "top-left",
    "center",
  ];
  if ((allowed as string[]).includes(raw)) return raw as LogoPosition;
  throw new Error(
    `Invalid LOGO_POSITION="${raw}". Expected one of: ${allowed.join(", ")}`,
  );
}

export interface AppConfig {
  pkgRoot: string;
  brastyCsvPath: string;
  storageStatePath: string;
  outputDir: string;
  watermarkedDir: string;
  logoPath: string;
  logoPosition: LogoPosition;
  logoScale: number;
  logoOpacity: number;
  publicUrlBase: string;
  imageOverridesPath: string;
  manifestPath: string;
  logPath: string;
  findingsDir: string;
  concurrency: number;
  politenessDelayMs: number;
  retryCount: number;
  retryBackoffMs: number;
  headless: boolean;
  investigateEans: string[];
  brastyBaseUrl: string;
  /** Wholesale account email — from BRASTY_EMAIL only. Never logged. */
  brastyEmail: string;
  /** Wholesale account password — from BRASTY_PASSWORD only. Never logged. */
  brastyPassword: string;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const logoRaw = envString("LOGO_PATH", "");
  const cfg: AppConfig = {
    pkgRoot: PKG_ROOT,
    brastyCsvPath: resolvePath(envString("BRASTY_CSV_PATH", "./sample-products.csv")),
    storageStatePath: resolvePath(
      envString("STORAGE_STATE_PATH", "./storageState.json"),
    ),
    outputDir: resolvePath(envString("OUTPUT_DIR", "./output")),
    watermarkedDir: resolvePath(envString("WATERMARKED_DIR", "./watermarked")),
    logoPath: logoRaw ? resolvePath(logoRaw) : "",
    logoPosition: parseLogoPosition(envString("LOGO_POSITION", "bottom-right")),
    logoScale: envFloat("LOGO_SCALE", 0.18),
    logoOpacity: envFloat("LOGO_OPACITY", 0.85),
    publicUrlBase: envString("PUBLIC_URL_BASE", "https://example.com/lps-media").replace(
      /\/$/,
      "",
    ),
    imageOverridesPath: resolvePath(
      envString(
        "IMAGE_OVERRIDES_PATH",
        "../../production-environment/sillage-core/data/image_overrides.json",
      ),
    ),
    manifestPath: resolvePath(envString("MANIFEST_PATH", "./logs/manifest.jsonl")),
    logPath: resolvePath(envString("LOG_PATH", "./logs/download.log")),
    findingsDir: join(PKG_ROOT, "findings"),
    concurrency: Math.max(1, envInt("CONCURRENCY", 1)),
    politenessDelayMs: envInt("POLITENESS_DELAY_MS", 1500),
    retryCount: Math.max(0, envInt("RETRY_COUNT", 3)),
    retryBackoffMs: Math.max(0, envInt("RETRY_BACKOFF_MS", 1000)),
    headless: envBool("HEADLESS", true),
    investigateEans: envString("INVESTIGATE_EANS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    brastyBaseUrl: envString("BRASTY_BASE_URL", "https://wholesale.brasty.com/"),
    brastyEmail: envString("BRASTY_EMAIL", ""),
    brastyPassword: envString("BRASTY_PASSWORD", ""),
    ...overrides,
  };

  if (cfg.concurrency > 4) {
    console.warn(
      `[config] CONCURRENCY=${cfg.concurrency} is aggressive for Brasty; prefer 1–2.`,
    );
  }

  return cfg;
}

/** Require credentials for headless login. Never includes the password in the message. */
export function assertBrastyCredentials(cfg: AppConfig): void {
  const missing: string[] = [];
  if (!cfg.brastyEmail) missing.push("BRASTY_EMAIL");
  if (!cfg.brastyPassword) missing.push("BRASTY_PASSWORD");
  if (missing.length > 0) {
    throw new Error(
      `Missing ${missing.join(" and ")} in environment / .env. ` +
        `Set them as plain env vars (never commit real values).`,
    );
  }
}

/** Fail fast when a saved session is required but missing. */
export function assertStorageStateExists(path: string): void {
  if (!existsSync(path)) {
    throw new Error(
      `Missing Playwright session at ${path}. Run: npm run login`,
    );
  }
}

/**
 * Strip password-like substrings from error text before logging / rethrowing.
 * Never logs BRASTY_PASSWORD.
 */
export function redactSecrets(text: string, password?: string): string {
  let out = text;
  if (password && password.length > 0) {
    out = out.split(password).join("[REDACTED]");
  }
  return out;
}

export { PKG_ROOT };
