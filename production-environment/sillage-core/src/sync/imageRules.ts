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

/** True when the setting is on and the finally-resolved image is still unusable. */
export function shouldHideForMissingImage(
  imageUrl: string | null | undefined,
  hideEnabled: boolean,
): boolean {
  return hideEnabled && isUnusableImage(imageUrl);
}
