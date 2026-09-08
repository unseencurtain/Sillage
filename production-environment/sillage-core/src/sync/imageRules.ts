/**
 * Pure image visibility helpers. No database imports — unit-testable.
 */

/** A stringified Python `None`, a literal `null`, or nothing at all — never a filename. */
function isJunkToken(lowercased: string): boolean {
  return !lowercased || lowercased === "none" || lowercased === "null";
}

export function isPlaceholderImage(url: string | null | undefined): boolean {
  if (!url) return true;
  const trimmed = url.trim();
  const low = trimmed.toLowerCase();
  if (isJunkToken(low)) return true;
  // Shop only renders http(s). "None" and other junk must not count as a photo.
  if (!/^https?:\/\//i.test(trimmed)) return true;
  return (
    low.includes("no_image") ||
    low.includes("woocommerce-placeholder") ||
    low.includes("placeholder") ||
    low.endsWith("/images/") ||
    (low.includes("/thumb/") && low.includes("noimage"))
  );
}

/** Canonical empty-vs-URL compare. Unusable stored values collapse to "". */
export function shopImageKey(url: string | null | undefined): string {
  if (isUnusableImage(url)) return "";
  return url!.trim();
}

/**
 * Customer-facing URL for hide / dashboard Shop column.
 * Woo `_external_thumbnail_url` is what the plugin prints.
 * `undefined` means Woo was not queried — fall back to the resolved feed URL.
 * `null` or junk means the shop has no photo, even if the vendor feed still has a file.
 */
export function displayedShopImage(
  wooThumb: string | null | undefined,
  resolved: string | null | undefined,
): string | null {
  if (wooThumb === undefined) {
    const fallback = resolved?.trim() ?? "";
    return isUnusableImage(fallback) ? null : fallback;
  }
  if (wooThumb === null || isUnusableImage(wooThumb)) return null;
  return wooThumb.trim();
}

/** True when Woo meta and the URL we would write are not the same shop photo. */
export function thumbsNeedWrite(
  wooThumb: string | null | undefined,
  resolved: string | null | undefined,
): boolean {
  return shopImageKey(wooThumb) !== shopImageKey(resolved);
}

/** BeautyFort's /pic/ CDN serves tiny thumbs — treat as replaceable when a better URL exists. */
export function isWeakVendorThumb(url: string | null | undefined): boolean {
  if (!url) return true;
  if (isPlaceholderImage(url)) return true;
  const low = url.toLowerCase();
  // Encoded `/pic/<token>` thumbs (often URL-encoded `=` → `%3D`) and any beautyfort.com/pic/ path.
  return low.includes("beautyfort.com/pic/") || /beautyfort\.com\/pic\b/.test(low);
}

/** Empty, placeholder, or known-weak vendor thumb — not fit for the storefront. */
export function isUnusableImage(url: string | null | undefined): boolean {
  return isPlaceholderImage(url) || isWeakVendorThumb(url);
}

/**
 * Expand a host-relative override onto whichever image CDN this deployment owns.
 *
 * `image_overrides.json` is committed and shipped to every box, so a photo we host ourselves is
 * stored as a bare filename and gains its origin here. Baking the origin into the file instead
 * silently tied one shop to another shop's CDN: a rebuilt storefront kept serving 3,221 photos off
 * the old box, and repurposing that box would have broken them.
 *
 * A value that already carries a scheme is somebody else's URL (Shopify, a vendor CDN) and is
 * returned untouched. With no base configured, a relative value stays relative and
 * `isUnusableImage` rejects it — better an unphotographed product than a broken `<img>`.
 */
export function absolutizeImageUrl(
  value: string | null | undefined,
  cdnBaseUrl: string | null | undefined,
): string {
  const trimmed = (value ?? "").trim();
  // Junk must not be given an origin. The enricher writes a stringified `None` when it found
  // nothing, and prefixing that yields `https://cdn/None` — a URL that looks perfectly usable and
  // renders as a broken image on the product page.
  if (isJunkToken(trimmed.toLowerCase())) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//")) return trimmed;
  const base = (cdnBaseUrl ?? "").trim().replace(/\/+$/, "");
  if (!base) return trimmed;
  return `${base}/${trimmed.replace(/^\/+/, "")}`;
}

/** Strip junk so EAN maps match across vendors (leading zeros, quoted barcodes). */
export function normalizeEan(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().replace(/^'+/, "");
  if (!cleaned || cleaned === "0000000000000" || !/^\d+$/.test(cleaned)) return null;
  return cleaned.replace(/^0+/, "") || null;
}

/** Same fill order the writer uses: override → other vendor’s usable photo → else null if unusable. */
export function resolveImageUrl(
  eans: string[],
  current: string | null,
  overrides: Map<string, string>,
  fromOffers: Map<string, string>,
): string | null {
  for (const raw of eans) {
    const ean = normalizeEan(raw);
    if (!ean) continue;
    const override = overrides.get(ean);
    if (override && !isUnusableImage(override) && override !== current) return override;
    const hit = fromOffers.get(ean);
    if (hit && !isUnusableImage(hit) && hit !== current && isUnusableImage(current)) {
      return hit;
    }
  }
  // Still empty / placeholder / weak BF thumb with no better source — clear so
  // hide_products_without_image can exclude the product instead of serving a tiny /pic/ URL.
  return isUnusableImage(current) ? null : current;
}

/** True when the setting is on and the finally-resolved image is still unusable. */
export function shouldHideForMissingImage(
  imageUrl: string | null | undefined,
  hideEnabled: boolean,
): boolean {
  return hideEnabled && isUnusableImage(imageUrl);
}

/** Why a product is hidden from the shop loop (same rules the writer applies). */
export type ShopVisibility = "visible" | "hidden_no_image" | "hidden_stock" | "hidden_operator";

export function shopVisibility(opts: {
  stock: number;
  imageUrl: string | null | undefined;
  hideWithoutImage: boolean;
  stockThreshold: number;
  operatorHidden?: boolean;
}): ShopVisibility {
  if (opts.operatorHidden) return "hidden_operator";
  if (shouldHideForMissingImage(opts.imageUrl, opts.hideWithoutImage)) return "hidden_no_image";
  if (opts.stock <= opts.stockThreshold) return "hidden_stock";
  return "visible";
}

function offerEans(primary: string | null | undefined, rawEans: unknown): string[] {
  const out: string[] = [];
  if (primary) out.push(primary);
  let extra: unknown = rawEans;
  if (typeof extra === "string" && extra.trim()) {
    const raw = extra;
    try {
      extra = JSON.parse(raw);
    } catch {
      extra = raw.split(/[\s,;]+/);
    }
  }
  if (Array.isArray(extra)) {
    for (const v of extra) if (v != null) out.push(String(v));
  }
  return out;
}

/** Index every barcode on an offer, not only `primary_ean`. */
export function indexOfferImages(
  rows: Array<{
    primary_ean: string | null;
    eans?: unknown;
    image_url: string | null;
  }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const row of rows) {
    if (isUnusableImage(row.image_url)) continue;
    const url = row.image_url!;
    for (const raw of offerEans(row.primary_ean, row.eans)) {
      const ean = normalizeEan(raw);
      if (ean && !map.has(ean)) map.set(ean, url);
    }
  }
  return map;
}
