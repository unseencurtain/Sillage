/**
 * Resolve better product images when a vendor (especially BeautyFort) ships placeholders.
 *
 * Priority for a given EAN:
 *   1. data/image_overrides.json (hand-curated + ocean/shopify matches from the prior enricher)
 *   2. Another vendor's offer image for the same EAN (usually BTS)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sil } from "../config/env.ts";
import { query, type RowDataPacket } from "../db/pool.ts";
import { logger } from "../lib/log.ts";

const log = logger("images");

function normalizeEan(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^'+/, "");
  if (!cleaned || cleaned === "0000000000000" || !/^\d+$/.test(cleaned)) return null;
  return cleaned.replace(/^0+/, "") || null;
}

export function isPlaceholderImage(url: string | null | undefined): boolean {
  if (!url) return true;
  const low = url.toLowerCase();
  return (
    low.includes("no_image") ||
    low.includes("woocommerce-placeholder") ||
    low.includes("placeholder") ||
    low.endsWith("/images/") ||
    (low.includes("/thumb/") && low.includes("noimage"))
  );
}

/** BeautyFort's /pic/ CDN serves tiny thumbs — treat as replaceable when a better URL exists. */
export function isWeakVendorThumb(url: string | null | undefined): boolean {
  if (!url) return true;
  if (isPlaceholderImage(url)) return true;
  const low = url.toLowerCase();
  return low.includes("beautyfort.com/pic/");
}

let overridesCache: Map<string, string> | null = null;

export function loadImageOverrides(root = process.cwd()): Map<string, string> {
  if (overridesCache) return overridesCache;
  const path = join(root, "data", "image_overrides.json");
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    const map = new Map<string, string>();
    for (const [k, v] of Object.entries(raw)) {
      const ean = normalizeEan(k);
      if (!ean || isPlaceholderImage(v)) continue;
      map.set(ean, v);
    }
    overridesCache = map;
    log.info(`loaded ${map.size} image overrides from ${path}`);
    return map;
  } catch (err) {
    log.warn(`image overrides not loaded: ${String(err)}`);
    overridesCache = new Map();
    return overridesCache;
  }
}

/** Build EAN → image from non-vanished offers that already have a real URL. */
export async function loadOfferImageIndex(): Promise<Map<string, string>> {
  const rows = await query<RowDataPacket & { primary_ean: string | null; image_url: string | null }>(
    `SELECT primary_ean, image_url FROM ${sil("sil_offers")}
      WHERE vanished_at IS NULL
        AND primary_ean IS NOT NULL AND primary_ean != ''
        AND image_url IS NOT NULL AND image_url != ''`,
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    const ean = normalizeEan(row.primary_ean);
    if (!ean || isPlaceholderImage(row.image_url)) continue;
    if (!map.has(ean)) map.set(ean, row.image_url!);
  }
  return map;
}

export interface ImageLookup {
  resolve(eans: string[], current: string | null): string | null;
}

export async function buildImageLookup(root = process.cwd()): Promise<ImageLookup> {
  const overrides = loadImageOverrides(root);
  const fromOffers = await loadOfferImageIndex();
  return {
    resolve(eans, current) {
      // Prefer curated / cross-vendor images over empty, placeholder, or BeautyFort thumbs.
      for (const raw of eans) {
        const ean = normalizeEan(raw);
        if (!ean) continue;
        const hit = overrides.get(ean) ?? fromOffers.get(ean);
        if (hit && hit !== current) {
          if (isWeakVendorThumb(current) || isPlaceholderImage(current)) return hit;
          // Even a non-weak current URL loses to an override (hand-curated wins).
          if (overrides.has(ean)) return hit;
        }
      }
      return current;
    },
  };
}
