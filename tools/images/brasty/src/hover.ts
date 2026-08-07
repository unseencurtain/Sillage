/**
 * Trigger the large image preview from a listing row.
 *
 * Brasty shows a small `/images/w60/` thumb in the list; the large
 * `/images/w700/` asset loads on hover (network + injected preview).
 * Never treat the thumb `src` as the product photo.
 */
import type { Locator, Page } from "playwright";
import type { NetworkCapture } from "./types.js";

export interface HoverSelectors {
  /** Thumbnail / preview trigger inside a product row. */
  thumbnail: string;
  /** Optional large-preview container that should appear after hover. */
  previewContainer: string;
}

/** Selectors confirmed against wholesale.brasty.com `.c-product` rows. */
export const PENDING_HOVER_SELECTORS: HoverSelectors = {
  thumbnail: ".c-product__img picture, .c-product__img img, picture.i-c-product__img",
  previewContainer:
    '[class*="preview"] img, [class*="zoom"] img, [class*="popover"] img, [class*="tooltip"] img, .fancybox-image, img[src*="/images/w700/"]',
};

export interface HoverResult {
  ok: boolean;
  detail: string;
  /** Image URLs observed on the network after the hover action began. */
  networkImageUrls: string[];
}

function isLargeBrastyImage(url: string): boolean {
  if (/no-image/i.test(url)) return false;
  if (/\/images\/w60\//i.test(url)) return false;
  // Confirmed large preview path; also accept any wN where N >= 300.
  const m = /\/images\/w(\d+)\//i.exec(url);
  if (m) return Number(m[1]) >= 300;
  return /\.(jpe?g|png|webp)(\?|$)/i.test(url) && !/\/w60\//i.test(url);
}

/**
 * Hover the row thumbnail and wait for either a preview container or a new
 * large image network response — never a hardcoded sleep.
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
        "Thumbnail not found in .c-product row (expected .c-product__img). Check session / list markup.",
      networkImageUrls: [],
    };
  }

  const before = new Set(network.imageUrls());

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
        return (
          isImage &&
          res.ok() &&
          !before.has(url) &&
          isLargeBrastyImage(url)
        );
      },
      { timeout: 10_000 },
    )
    .then(() => "network" as const)
    .catch(() => null);

  await thumb.scrollIntoViewIfNeeded().catch(() => undefined);
  await thumb.hover({ timeout: 10_000 });

  const winner = await Promise.race([
    previewAppeared,
    imageResponse,
    page
      .waitForFunction(
        () => {
          const imgs = Array.from(document.querySelectorAll("img"));
          return imgs.some((img) => {
            const src = img.currentSrc || img.src || "";
            if (/\/images\/w60\//i.test(src) || /no-image/i.test(src)) return false;
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

  await Promise.allSettled([previewAppeared, imageResponse]);

  const after = network
    .imageUrls()
    .filter((u) => !before.has(u) && isLargeBrastyImage(u));

  if (!winner && after.length === 0) {
    // data-image already holds the large URL; hover may still have "succeeded"
    // visually via CSS without a new request if the asset was cached.
    const dataImage = await row
      .locator("picture[data-image]")
      .first()
      .getAttribute("data-image")
      .catch(() => null);
    if (dataImage && /\/images\/w(?:[3-9]\d{2,}|\d{4,})\//i.test(dataImage)) {
      return {
        ok: true,
        detail:
          "Hover produced no new network image (likely cache); picture[data-image] has large URL",
        networkImageUrls: after,
      };
    }
    return {
      ok: false,
      detail:
        "Hover produced neither a large preview nor a new w700+ image request. Thumb-only rows should be skipped.",
      networkImageUrls: after,
    };
  }

  return {
    ok: true,
    detail: `Hover signal: ${winner ?? "network-images-only"} (${after.length} new large image URL(s))`,
    networkImageUrls: after,
  };
}
