/**
 * Resolve better product images when a vendor (especially BeautyFort) ships placeholders.
 *
 * Priority for a given EAN:
 *   1. data/image_overrides.json (hand-curated + wholesale-perfumes/shopify/oceanfragrances matches from the prior enricher)
 *   2. Another vendor's offer image for the same EAN (usually BTS)
 *
 * Cross-vendor fill runs for every product whose current URL is missing, a placeholder, or a
 * weak BeautyFort thumb — on both full and fast sync paths (caller must invoke resolve()).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sil } from "../config/env.ts";
import { query, type RowDataPacket } from "../db/pool.ts";
import { logger } from "../lib/log.ts";
import { isPlaceholderImage, isWeakVendorThumb } from "./imageRules.ts";

export { isPlaceholderImage, isWeakVendorThumb, shouldHideForMissingImage } from "./imageRules.ts";

const log = logger("images");

function normalizeEan(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^'+/, "");
  if (!cleaned || cleaned === "0000000000000" || !/^\d+$/.test(cleaned)) return null;
  return cleaned.replace(/^0+/, "") || null;
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
      // Prefer curated / cross-vendor images over empty, placeholder, or weak thumbs.
      for (const raw of eans) {
        const ean = normalizeEan(raw);
        if (!ean) continue;
        const override = overrides.get(ean);
        if (override && override !== current) return override;
        const hit = fromOffers.get(ean);
        if (hit && hit !== current && (isWeakVendorThumb(current) || isPlaceholderImage(current))) {
          return hit;
        }
      }
      return current;
    },
  };
}
