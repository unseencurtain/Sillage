/**
 * Pure image visibility helpers. No database imports — unit-testable.
 */

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
  // Encoded `/pic/<token>` thumbs (often URL-encoded `=` → `%3D`) and any beautyfort.com/pic/ path.
  return low.includes("beautyfort.com/pic/") || /beautyfort\.com\/pic\b/.test(low);
}

/** Empty, placeholder, or known-weak vendor thumb — not fit for the storefront. */
export function isUnusableImage(url: string | null | undefined): boolean {
  return isPlaceholderImage(url) || isWeakVendorThumb(url);
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
export type ShopVisibility = "visible" | "hidden_no_image" | "hidden_stock";

export function shopVisibility(opts: {
  stock: number;
  imageUrl: string | null | undefined;
  hideWithoutImage: boolean;
  stockThreshold: number;
}): ShopVisibility {
  if (shouldHideForMissingImage(opts.imageUrl, opts.hideWithoutImage)) return "hidden_no_image";
  if (opts.stock <= opts.stockThreshold) return "hidden_stock";
  return "visible";
}
