/**
 * Pluggable image extraction — PENDING live-site investigation.
 *
 * DO NOT invent Brasty-specific selectors or URL rewrite rules here.
 * After `npm run investigate` writes findings/, the operator (or a follow-up
 * change) should register a concrete ExtractionStrategy based on that evidence.
 *
 * The production downloader calls `getExtractionStrategy()` and must fail
 * loudly while the strategy remains pending.
 */
import type {
  ExtractionContext,
  ExtractionStrategy,
  NetworkCapture,
} from "./types.js";

/**
 * Prefer the visually / byte-wise largest candidate when multiple URLs exist.
 * Size hints from URL path segments (e.g. /large/, /thumb/, dimensions) are
 * used only as a ranking heuristic — never as a screenshot substitute.
 */
export function pickLargestImageUrl(urls: string[]): string | null {
  if (urls.length === 0) return null;
  if (urls.length === 1) return urls[0]!;

  const scored = urls.map((url) => ({ url, score: scoreUrl(url) }));
  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.url;
}

function scoreUrl(url: string): number {
  const low = url.toLowerCase();
  let score = 0;
  if (/\/(orig|original|full|large|big|zoom|hires|high)(\/|_|\.)/i.test(low)) score += 100;
  if (/\/(thumb|small|tiny|mini|icon|preview)(\/|_|\.)/i.test(low)) score -= 80;
  const dim = low.match(/(\d{3,4})x(\d{3,4})/);
  if (dim) score += Number(dim[1]) * Number(dim[2]) / 1000;
  if (/\.jpe?g(\?|$)/i.test(low)) score += 5;
  if (/\.webp(\?|$)/i.test(low)) score += 3;
  // Longer paths sometimes encode higher-res variants.
  score += Math.min(low.length / 100, 5);
  return score;
}

/**
 * Evidence helpers usable by a future concrete strategy. Safe to call today;
 * they do not assume Brasty DOM shape beyond generic img / data-* / CSS bg.
 */
export async function collectDomImageCandidates(
  ctx: ExtractionContext,
): Promise<string[]> {
  const { page, row } = ctx;
  const urls = new Set<string>();

  const fromEval = await page.evaluate(() => {
    const out: string[] = [];
    const push = (u: string | null | undefined): void => {
      if (u && /^https?:\/\//i.test(u)) out.push(u);
    };
    const imgs = Array.from(document.querySelectorAll("img"));
    for (const img of imgs) {
      push(img.currentSrc || img.src);
      push(img.getAttribute("data-src"));
      push(img.getAttribute("data-original"));
      push(img.getAttribute("data-zoom-image"));
      push(img.getAttribute("data-large"));
      push(img.getAttribute("data-full"));
      for (let ai = 0; ai < img.attributes.length; ai++) {
        const attr = img.attributes.item(ai);
        if (
          attr &&
          attr.name.startsWith("data-") &&
          /^https?:\/\//i.test(attr.value)
        ) {
          out.push(attr.value);
        }
      }
    }
    const els = Array.from(document.querySelectorAll("*")) as HTMLElement[];
    for (const el of els) {
      const bg = getComputedStyle(el).backgroundImage;
      const m = /url\(["']?(https?:\/\/[^"')]+)["']?\)/i.exec(bg);
      if (m?.[1]) out.push(m[1]);
      for (let ai = 0; ai < el.attributes.length; ai++) {
        const attr = el.attributes.item(ai);
        if (
          attr &&
          attr.name.startsWith("data-") &&
          /^https?:\/\//i.test(attr.value)
        ) {
          out.push(attr.value);
        }
      }
    }
    return out;
  });
  for (const u of fromEval) urls.add(u);

  // Row-scoped imgs.
  const rowImgs = row.locator("img");
  const n = await rowImgs.count();
  for (let i = 0; i < n; i++) {
    const img = rowImgs.nth(i);
    for (const attr of ["src", "data-src", "data-original", "data-zoom-image", "data-large"]) {
      const v = await img.getAttribute(attr).catch(() => null);
      if (v && /^https?:\/\//i.test(v)) urls.add(v);
    }
  }

  return [...urls];
}

export function collectNetworkImageCandidates(network: NetworkCapture): string[] {
  return network.imageUrls();
}

/**
 * PENDING strategy — refuses to invent production selectors.
 * Replace by calling `setExtractionStrategy(...)` once findings identify the mechanism.
 */
export const pendingInvestigationStrategy: ExtractionStrategy = {
  name: "pending-investigation",
  async extract(ctx: ExtractionContext): Promise<string | null> {
    // Gather evidence for debugging, but do not pretend we know the answer.
    const dom = await collectDomImageCandidates(ctx);
    const net = collectNetworkImageCandidates(ctx.network);
    const combined = pickLargestImageUrl([...new Set([...dom, ...net])]);

    if (!combined) {
      throw new Error(
        [
          "Image extraction strategy is still pending investigation.",
          "Run: npm run investigate",
          "Review tools/images/brasty/findings/investigate-report.md (+ .json),",
          "then implement a concrete ExtractionStrategy in imageExtractor.ts",
          "and register it via setExtractionStrategy().",
          `EAN=${ctx.ean} domCandidates=${dom.length} networkCandidates=${net.length}`,
        ].join(" "),
      );
    }

    // Even if candidates exist, refuse silent production use until strategy is chosen.
    throw new Error(
      [
        "Image extraction strategy is still pending investigation.",
        `Found ${dom.length} DOM + ${net.length} network candidate URL(s)`,
        `(largest guess would be ${combined}), but selectors/URL rules must be`,
        "confirmed from findings/ before production download.",
        "Implement and register a concrete strategy in imageExtractor.ts.",
      ].join(" "),
    );
  },
};

let activeStrategy: ExtractionStrategy = pendingInvestigationStrategy;

export function getExtractionStrategy(): ExtractionStrategy {
  return activeStrategy;
}

export function setExtractionStrategy(strategy: ExtractionStrategy): void {
  activeStrategy = strategy;
}

/**
 * Example skeleton for a post-investigation strategy (NOT registered).
 * Copy / adapt after findings answer questions (a)–(g).
 */
export const strategySkeletonFromFindings: ExtractionStrategy = {
  name: "skeleton-from-findings",
  async extract(ctx: ExtractionContext): Promise<string | null> {
    // TODO(operator): based on findings/
    // - if (g) predictable thumb→full URL: rewrite row thumbnail src
    // - if (e)/(f) network/API: prefer waitForResponse + parse JSON / image URL
    // - if (a)/(b)/(c)/(d) DOM: read the confirmed attribute / bg / injected img
    const net = collectNetworkImageCandidates(ctx.network);
    const dom = await collectDomImageCandidates(ctx);
    return pickLargestImageUrl([...new Set([...net, ...dom])]);
  },
};
