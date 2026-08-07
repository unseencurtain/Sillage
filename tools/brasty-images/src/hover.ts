/**
 * Trigger the large image preview from a listing row.
 *
 * Brasty has no PDP — the large preview is activated from the row (typically
 * by hovering a thumbnail). Exact hover target is pending investigation.
 */
import type { Locator, Page } from "playwright";
import type { NetworkCapture } from "./types.js";

export interface HoverSelectors {
  /** Thumbnail / preview trigger inside a product row. */
  thumbnail: string;
  /** Optional large-preview container that should appear after hover. */
  previewContainer: string;
}

/** Placeholder selectors — replace from investigate findings. */
export const PENDING_HOVER_SELECTORS: HoverSelectors = {
  thumbnail:
    'img, [class*="thumb"], [class*="image"], [class*="photo"], [style*="background-image"]',
  previewContainer:
    '[class*="preview"], [class*="zoom"], [class*="lightbox"], [class*="popover"], [class*="tooltip"] img, .fancybox-image, [role="dialog"] img',
};

export interface HoverResult {
  ok: boolean;
  detail: string;
  /** Image URLs observed on the network after the hover action began. */
  networkImageUrls: string[];
}

/**
 * Hover the row thumbnail and wait for either a preview container or a new
 * image network response — never a hardcoded sleep.
 */
export async function hoverProductImage(
  page: Page,
  row: Locator,
  network: NetworkCapture,
  selectors: HoverSelectors = PENDING_HOVER_SELECTORS,
): Promise<HoverResult> {
  const thumb = row.locator(selectors.thumbnail).first();
  try {
    await thumb.waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    return {
      ok: false,
      detail:
        "Thumbnail not found in product row. Update PENDING_HOVER_SELECTORS from investigate findings.",
      networkImageUrls: [],
    };
  }

  const before = new Set(network.imageUrls());

  // Race: preview container appears OR a new image response arrives.
  const preview = page.locator(selectors.previewContainer).first();

  const previewAppeared = preview
    .waitFor({ state: "visible", timeout: 10_000 })
    .then(() => "preview" as const)
    .catch(() => null);

  const imageResponse = page
    .waitForResponse(
      (res) => {
        const ct = res.headers()["content-type"] ?? "";
        const url = res.url();
        const isImage =
          res.request().resourceType() === "image" ||
          /^image\//i.test(ct) ||
          /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url);
        return isImage && res.ok() && !before.has(url);
      },
      { timeout: 10_000 },
    )
    .then(() => "network" as const)
    .catch(() => null);

  await thumb.hover({ timeout: 10_000 });

  const winner = await Promise.race([
    previewAppeared,
    imageResponse,
    // Also accept DOM mutation of any large img after hover.
    page
      .waitForFunction(
        () => {
          const imgs = Array.from(document.querySelectorAll("img"));
          return imgs.some((img) => {
            const w = img.naturalWidth || img.width;
            const h = img.naturalHeight || img.height;
            return w >= 300 && h >= 300 && img.offsetParent !== null;
          });
        },
        undefined,
        { timeout: 10_000 },
      )
      .then(() => "dom" as const)
      .catch(() => null),
  ]);

  // Allow the losing waiters to settle without failing the call.
  await Promise.allSettled([previewAppeared, imageResponse]);

  const after = network.imageUrls().filter((u) => !before.has(u));

  if (!winner && after.length === 0) {
    return {
      ok: false,
      detail:
        "Hover produced neither a visible preview nor a new image request. Inspect findings/ and refine hover selectors / strategy.",
      networkImageUrls: after,
    };
  }

  return {
    ok: true,
    detail: `Hover signal: ${winner ?? "network-images-only"} (${after.length} new image URL(s))`,
    networkImageUrls: after,
  };
}
