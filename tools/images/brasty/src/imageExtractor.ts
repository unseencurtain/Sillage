/**
 * Pluggable image extraction for Brasty list rows.
 *
 * Confirmed mechanism (investigate 2026-08-07):
 * - List thumb: `/images/w60/<id>.jpg` — NEVER download this
 * - Large preview on hover: `/images/w700/<id>.webp` (network + DOM)
 * - Same large URL is also on `picture[data-image]` before hover
 *
 * Strategy: hover first (caller), then prefer post-hover network / large DOM
 * img, then `data-image`, then w60→w700 rewrite. Never return a w60 thumb.
 */
import type {
  ExtractionContext,
  ExtractionStrategy,
  NetworkCapture,
} from "./types.js";

const THUMB_RE = /\/images\/w60\//i;
/** Placeholders: no-image.jpg and bare `/images/w700/.webp` (Tester rows). */
const NO_IMAGE_RE = /no-image|\/images\/w\d+\/\.webp(?:\?|$)/i;
const WIDTH_RE = /\/images\/w(\d+)\//i;

/** Stem from `/images/wN/<stem>.ext` — used to keep network URLs row-scoped. */
export function imageStem(url: string): string | null {
  const m = /\/images\/w\d+\/([^/?#]+)\./i.exec(url);
  if (!m?.[1] || m[1] === "" || /^no-image$/i.test(m[1])) return null;
  return m[1];
}

/**
 * Prefer the visually / byte-wise largest candidate when multiple URLs exist.
 * Size hints from URL path segments (e.g. /large/, /thumb/, dimensions) are
 * used only as a ranking heuristic — never as a screenshot substitute.
 */
export function pickLargestImageUrl(urls: string[]): string | null {
  const usable = urls.filter((u) => isUsableLargeUrl(u));
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0]!;

  const scored = usable.map((url) => ({ url, score: scoreUrl(url) }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.url;
}

export function isUsableLargeUrl(url: string): boolean {
  if (!url || !/^https?:\/\//i.test(url) && !url.startsWith("/")) return false;
  if (THUMB_RE.test(url)) return false;
  if (NO_IMAGE_RE.test(url)) return false;
  const m = WIDTH_RE.exec(url);
  if (m && Number(m[1]) < 300) return false;
  return true;
}

function scoreUrl(url: string): number {
  const low = url.toLowerCase();
  let score = 0;
  const w = WIDTH_RE.exec(low);
  if (w) score += Number(w[1]);
  if (/\/(orig|original|full|large|big|zoom|hires|high)(\/|_|\.)/i.test(low)) score += 100;
  if (/\/(thumb|small|tiny|mini|icon|preview)(\/|_|\.)/i.test(low)) score -= 80;
  const dim = low.match(/(\d{3,4})x(\d{3,4})/);
  if (dim) score += (Number(dim[1]) * Number(dim[2])) / 1000;
  if (/\.jpe?g(\?|$)/i.test(low)) score += 5;
  if (/\.webp(\?|$)/i.test(low)) score += 8;
  score += Math.min(low.length / 100, 5);
  return score;
}

function absolutize(pageUrl: string, maybeRelative: string): string {
  try {
    return new URL(maybeRelative, pageUrl).href;
  } catch {
    return maybeRelative;
  }
}

/** Rewrite `/images/w60/foo.jpg` → `/images/w700/foo.webp` (confirmed pattern). */
export function thumbToLargeUrl(thumbUrl: string, pageUrl: string): string | null {
  if (!THUMB_RE.test(thumbUrl)) return null;
  try {
    const u = new URL(absolutize(pageUrl, thumbUrl));
    u.pathname = u.pathname
      .replace(/\/images\/w60\//i, "/images/w700/")
      .replace(/\.(jpe?g|png)$/i, ".webp");
    if (NO_IMAGE_RE.test(u.href)) return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Evidence helpers — DOM candidates, excluding known thumbs / placeholders.
 */
export async function collectDomImageCandidates(
  ctx: ExtractionContext,
): Promise<string[]> {
  const { page, row } = ctx;
  const urls = new Set<string>();
  const pageUrl = page.url();

  // Row-scoped only — never scan the whole page (other rows' data-image leaks).
  const dataImage = await row
    .locator("picture[data-image]")
    .first()
    .getAttribute("data-image")
    .catch(() => null);
  if (dataImage) {
    const abs = absolutize(pageUrl, dataImage);
    if (isUsableLargeUrl(abs)) urls.add(abs);
  }

  const rowImgs = row.locator("img");
  const n = await rowImgs.count();
  for (let i = 0; i < n; i++) {
    const img = rowImgs.nth(i);
    for (const attr of ["src", "data-src", "data-original", "data-zoom-image", "data-large"]) {
      const v = await img.getAttribute(attr).catch(() => null);
      if (!v) continue;
      const abs = absolutize(pageUrl, v);
      if (isUsableLargeUrl(abs)) urls.add(abs);
      else if (THUMB_RE.test(abs)) {
        const rewritten = thumbToLargeUrl(abs, pageUrl);
        if (rewritten) urls.add(rewritten);
      }
    }
  }

  return [...urls];
}

export function collectNetworkImageCandidates(network: NetworkCapture): string[] {
  return network.imageUrls().filter((u) => isUsableLargeUrl(u));
}

/**
 * Production strategy: list-row hover → large URL (never thumb src).
 */
export const listRowHoverLargeStrategy: ExtractionStrategy = {
  name: "list-row-hover-large",
  async extract(ctx: ExtractionContext): Promise<string | null> {
    const pageUrl = ctx.page.url();

    // Row anchors first — Tester rows use no-image / `/images/w700/.webp`.
    const dataImage = await ctx.row
      .locator("picture[data-image]")
      .first()
      .getAttribute("data-image")
      .catch(() => null);
    const dataAbs = dataImage ? absolutize(pageUrl, dataImage) : null;
    const rowDataOk = dataAbs && isUsableLargeUrl(dataAbs) ? dataAbs : null;

    const thumbSrc = await ctx.row
      .locator(".c-product__img img, picture img, img")
      .first()
      .getAttribute("src")
      .catch(() => null);
    const thumbAbs = thumbSrc ? absolutize(pageUrl, thumbSrc) : null;
    if (thumbAbs && NO_IMAGE_RE.test(thumbAbs) && !rowDataOk) {
      return null; // genuine missing photo — do not steal another row's image
    }
    const rowStem =
      (rowDataOk && imageStem(rowDataOk)) ||
      (thumbAbs && imageStem(thumbAbs)) ||
      null;

    // 1) Network images from this hover, filtered to the row stem when known.
    const net = collectNetworkImageCandidates(ctx.network).filter((u) => {
      if (!rowStem) return isUsableLargeUrl(u);
      const stem = imageStem(u);
      return stem !== null && stem === rowStem;
    });
    const fromNet = pickLargestImageUrl(net);
    if (fromNet) return fromNet;

    // 2) Row picture[data-image] (confirmed w700 path).
    if (rowDataOk) return rowDataOk;

    // 3) Post-hover preview img — only if its stem matches this row.
    if (rowStem) {
      const largeDom = (await ctx.page.evaluate(`(() => {
        const out = [];
        for (const img of Array.from(document.querySelectorAll("img"))) {
          const src = img.currentSrc || img.src || "";
          if (!src || /\\/images\\/w60\\//i.test(src) || /no-image/i.test(src)) continue;
          if (/\\/images\\/w\\d+\\/\\.webp/i.test(src)) continue;
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          if (w >= 300 && h >= 300) out.push(src);
        }
        return out;
      })()`)) as string[];
      const matched = largeDom
        .map((u) => absolutize(pageUrl, u))
        .filter((u) => imageStem(u) === rowStem && isUsableLargeUrl(u));
      const fromDomLarge = pickLargestImageUrl(matched);
      if (fromDomLarge) return fromDomLarge;
    }

    // 4) Rewrite this row's thumb w60 → w700 (same stem).
    if (thumbAbs) {
      const rewritten = thumbToLargeUrl(thumbAbs, pageUrl);
      if (rewritten && isUsableLargeUrl(rewritten)) return rewritten;
    }

    // 5) Row-scoped DOM candidates only (never page-wide).
    return pickLargestImageUrl(await collectDomImageCandidates(ctx));
  },
};

/** @deprecated Kept for investigate messaging; no longer the active default. */
export const pendingInvestigationStrategy: ExtractionStrategy = {
  name: "pending-investigation",
  async extract(ctx: ExtractionContext): Promise<string | null> {
    const dom = await collectDomImageCandidates(ctx);
    const net = collectNetworkImageCandidates(ctx.network);
    const combined = pickLargestImageUrl([...new Set([...dom, ...net])]);
    throw new Error(
      [
        "Image extraction strategy is still pending investigation.",
        `EAN=${ctx.ean} domCandidates=${dom.length} networkCandidates=${net.length}`,
        combined ? `largest guess would be ${combined}` : "no candidates",
      ].join(" "),
    );
  },
};

let activeStrategy: ExtractionStrategy = listRowHoverLargeStrategy;

export function getExtractionStrategy(): ExtractionStrategy {
  return activeStrategy;
}

export function setExtractionStrategy(strategy: ExtractionStrategy): void {
  activeStrategy = strategy;
}

/** Alias kept for older docs that mention the skeleton name. */
export const strategySkeletonFromFindings = listRowHoverLargeStrategy;
