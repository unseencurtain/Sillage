/**
 * Resolve better product images when a vendor (especially BeautyFort) ships placeholders.
 *
 * Priority for a given EAN:
 *   1. data/image_overrides.json (hand-curated + shopify/oceanfragrances matches from the prior enricher)
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
import {
  absolutizeImageUrl,
  isUnusableImage,
  normalizeEan,
  resolveImageUrl,
  indexOfferImages,
} from "./imageRules.ts";

export {
  absolutizeImageUrl,
  isPlaceholderImage,
  isUnusableImage,
  isWeakVendorThumb,
  normalizeEan,
  resolveImageUrl,
  shouldHideForMissingImage,
  shopImageKey,
  displayedShopImage,
  thumbsNeedWrite,
  indexOfferImages,
} from "./imageRules.ts";

const log = logger("images");

// Keyed by file + CDN origin: the same file resolves to different URLs on the dev box and in
// production, and the origin is editable from Settings while the process is up.
const overridesCache = new Map<string, Map<string, string>>();

/**
 * Read `data/image_overrides.json`, expanding bare filenames onto `cdnBaseUrl`.
 *
 * Photos we host ourselves are stored without an origin so the one committed file is correct on
 * every box. Anything with a scheme is an external CDN's URL and is used as written.
 */
export function loadImageOverrides(root = process.cwd(), cdnBaseUrl = ""): Map<string, string> {
  const path = join(root, "data", "image_overrides.json");
  const cacheKey = `${path}\u0000${cdnBaseUrl}`;
  const cached = overridesCache.get(cacheKey);
  if (cached) return cached;
  const map = new Map<string, string>();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
    let selfHosted = 0;
    for (const [k, v] of Object.entries(raw)) {
      const ean = normalizeEan(k);
      if (!ean) continue;
      const url = absolutizeImageUrl(v, cdnBaseUrl);
      if (isUnusableImage(url)) continue;
      if (url !== (v ?? "").trim()) selfHosted += 1;
      map.set(ean, url);
    }
    log.info(
      `loaded ${map.size} image overrides from ${path}` +
        (selfHosted ? ` (${selfHosted} self-hosted, resolved against ${cdnBaseUrl || "no CDN base"})` : ""),
    );
  } catch (err) {
    log.warn(`image overrides not loaded: ${String(err)}`);
  }
  overridesCache.set(cacheKey, map);
  return map;
}

/** Build EAN → image from non-vanished offers that already have a real URL.

  Indexes **every** barcode on the offer, not only `primary_ean`. A BeautyFort
  row whose extra EAN matches a BTS photo would otherwise stay hidden.
 */
export async function loadOfferImageIndex(): Promise<Map<string, string>> {
  const rows = await query<
    RowDataPacket & { primary_ean: string | null; eans: unknown; image_url: string | null }
  >(
    `SELECT primary_ean, eans, image_url FROM ${sil("sil_offers")}
      WHERE vanished_at IS NULL
        AND image_url IS NOT NULL AND image_url != ''`,
  );
  return indexOfferImages(rows);
}

export interface ImageLookup {
  resolve(eans: string[], current: string | null): string | null;
}

export async function buildImageLookup(root = process.cwd(), cdnBaseUrl = ""): Promise<ImageLookup> {
  const overrides = loadImageOverrides(root, cdnBaseUrl);
  const fromOffers = await loadOfferImageIndex();
  return {
    resolve(eans, current) {
      return resolveImageUrl(eans, current, overrides, fromOffers);
    },
  };
}
