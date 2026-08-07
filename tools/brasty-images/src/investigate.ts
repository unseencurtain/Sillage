/**
 * Investigation harness — GATE before production extraction.
 *
 * Brasty has no product detail pages. Products exist only in a searchable
 * listing; the large preview is triggered from the row. For a small set of
 * operator-supplied EANs this script determines, with evidence:
 *
 *   (a) is the large image already in the DOM?
 *   (b) is it in a data-* attribute?
 *   (c) is it injected after hover?
 *   (d) is it a CSS background-image?
 *   (e) is it requested over the network after hover?
 *   (f) is there an API/JSON endpoint returning image URLs?
 *   (g) is there a predictable thumbnail-URL → full-size-URL relationship?
 *
 * Writes findings/investigate-report.md + findings/investigate-report.json.
 * Does NOT implement production selectors — that waits on these findings.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright";
import { assertStorageStateExists, loadConfig } from "./config.js";
import { hoverProductImage, PENDING_HOVER_SELECTORS } from "./hover.js";
import { Logger } from "./logger.js";
import { attachNetworkCapture } from "./networkCapture.js";
import { PENDING_SEARCH_SELECTORS, searchByEan } from "./search.js";
import { openAuthenticatedContext, SessionExpiredError } from "./session.js";
import type { InvestigateFindings, InvestigateQuestion } from "./types.js";

interface DomSnapshot {
  imgSrcs: string[];
  dataAttrs: { tag: string; name: string; value: string }[];
  backgroundImages: string[];
  largeVisibleImgs: { src: string; naturalWidth: number; naturalHeight: number }[];
}

async function snapshotDom(page: Page): Promise<DomSnapshot> {
  return page.evaluate(() => {
    const imgSrcs: string[] = [];
    const dataAttrs: { tag: string; name: string; value: string }[] = [];
    const backgroundImages: string[] = [];
    const largeVisibleImgs: {
      src: string;
      naturalWidth: number;
      naturalHeight: number;
    }[] = [];

    const imgs = Array.from(document.querySelectorAll("img"));
    for (const img of imgs) {
      const src = img.currentSrc || img.src;
      if (src) imgSrcs.push(src);
      for (let ai = 0; ai < img.attributes.length; ai++) {
        const attr = img.attributes.item(ai);
        if (attr && attr.name.startsWith("data-") && attr.value) {
          dataAttrs.push({ tag: "img", name: attr.name, value: attr.value });
        }
      }
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w >= 300 && h >= 300 && img.offsetParent !== null) {
        largeVisibleImgs.push({ src, naturalWidth: w, naturalHeight: h });
      }
    }

    const els = Array.from(document.querySelectorAll("*")) as HTMLElement[];
    for (const el of els) {
      for (let ai = 0; ai < el.attributes.length; ai++) {
        const attr = el.attributes.item(ai);
        if (
          attr &&
          attr.name.startsWith("data-") &&
          (/image|img|src|photo|zoom|large|full|url/i.test(attr.name) ||
            /^https?:\/\//i.test(attr.value) ||
            /\.(jpe?g|png|webp)(\?|$)/i.test(attr.value))
        ) {
          dataAttrs.push({
            tag: el.tagName.toLowerCase(),
            name: attr.name,
            value: attr.value.slice(0, 500),
          });
        }
      }
      const bg = getComputedStyle(el).backgroundImage;
      if (bg && bg !== "none") {
        const m = /url\(["']?(https?:\/\/[^"')]+)["']?\)/i.exec(bg);
        if (m?.[1]) backgroundImages.push(m[1]);
      }
    }

    return { imgSrcs, dataAttrs, backgroundImages, largeVisibleImgs };
  });
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

function guessThumbToFull(thumbs: string[], fulls: string[]): string[] {
  const hints: string[] = [];
  for (const t of thumbs) {
    for (const f of fulls) {
      if (t === f) continue;
      try {
        const tu = new URL(t);
        const fu = new URL(f);
        if (tu.origin !== fu.origin) continue;
        const tp = tu.pathname;
        const fp = fu.pathname;
        // Common patterns: /thumb/ ↔ /large/, _s. ↔ _l., dimensions in path
        if (
          tp.replace(/thumb|small|mini|s\d+/gi, "X") ===
            fp.replace(/large|big|orig|full|l\d+/gi, "X") ||
          tp.replace(/\/\d+x\d+\//g, "/DIM/") === fp.replace(/\/\d+x\d+\//g, "/DIM/")
        ) {
          hints.push(`${t}  →  ${f}`);
        } else {
          // Same basename family?
          const tb = tp.split("/").pop() ?? "";
          const fb = fp.split("/").pop() ?? "";
          const tStem = tb.replace(/\.(jpe?g|png|webp)$/i, "").replace(/[_-]?(thumb|small|s)$/i, "");
          const fStem = fb.replace(/\.(jpe?g|png|webp)$/i, "").replace(/[_-]?(large|big|orig|full|l)$/i, "");
          if (tStem && tStem === fStem) {
            hints.push(`${t}  →  ${f}  (shared stem)`);
          }
        }
      } catch {
        /* ignore bad URLs */
      }
    }
  }
  return uniq(hints).slice(0, 20);
}

async function investigateOneEan(
  page: Page,
  ean: string,
  log: Logger,
): Promise<{
  ean: string;
  searchOk: boolean;
  searchDetail: string;
  before: DomSnapshot;
  after: DomSnapshot;
  networkBeforeHover: string[];
  networkAfterHover: string[];
  jsonEndpoints: { url: string; status: number; bodyPreview?: string }[];
  hoverDetail: string;
  allRequests: { url: string; method: string; resourceType: string }[];
}> {
  const network = attachNetworkCapture(page);
  try {
    network.clear();
    log.info(`Investigating EAN ${ean}…`);
    const search = await searchByEan(page, ean, PENDING_SEARCH_SELECTORS);
    if (!search.ok) {
      log.warn(`Search failed for ${ean}: ${search.detail}`);
      return {
        ean,
        searchOk: false,
        searchDetail: search.detail,
        before: emptySnap(),
        after: emptySnap(),
        networkBeforeHover: [],
        networkAfterHover: [],
        jsonEndpoints: [],
        hoverDetail: "skipped — search failed",
        allRequests: [],
      };
    }

    const before = await snapshotDom(page);
    const networkBeforeHover = network.imageUrls();

    // Clear image bookkeeping for the hover window (keep request log for API discovery).
    const hoverNetBaseline = new Set(network.imageUrls());
    const hover = await hoverProductImage(
      page,
      search.rowLocator,
      network,
      PENDING_HOVER_SELECTORS,
    );

    // Give late responses a chance via Playwright wait, not sleep:
    await page
      .waitForLoadState("networkidle", { timeout: 5_000 })
      .catch(() => undefined);

    const after = await snapshotDom(page);
    const networkAfterHover = network
      .imageUrls()
      .filter((u) => !hoverNetBaseline.has(u));

    const jsonEndpoints = network.jsonEndpoints().map((r) => ({
      url: r.url,
      status: r.status,
      bodyPreview: r.bodyPreview,
    }));

    // Also dump row HTML snippet for the operator.
    const rowHtml = await safeRowHtml(search.rowLocator);
    log.info(`Row HTML snippet (${ean}): ${rowHtml.slice(0, 400)}…`);

    return {
      ean,
      searchOk: true,
      searchDetail: `matched EAN ${search.matchedEan}`,
      before,
      after,
      networkBeforeHover,
      networkAfterHover,
      jsonEndpoints,
      hoverDetail: hover.detail,
      allRequests: network.requests.map((r) => ({
        url: r.url,
        method: r.method,
        resourceType: r.resourceType,
      })),
    };
  } finally {
    network.dispose();
  }
}

function emptySnap(): DomSnapshot {
  return {
    imgSrcs: [],
    dataAttrs: [],
    backgroundImages: [],
    largeVisibleImgs: [],
  };
}

async function safeRowHtml(row: Locator): Promise<string> {
  try {
    return (await row.evaluate((el) => el.outerHTML)).slice(0, 2000);
  } catch {
    return "(unavailable)";
  }
}

function synthesizeQuestions(
  results: Awaited<ReturnType<typeof investigateOneEan>>[],
): {
  questions: InvestigateQuestion[];
  thumbHints: string[];
  recommended: string;
  notes: string[];
} {
  const ok = results.filter((r) => r.searchOk);
  const notes: string[] = [];

  if (ok.length === 0) {
    notes.push(
      "No EAN searched successfully. Fix search selectors (PENDING_SEARCH_SELECTORS) using the live DOM, then re-run investigate.",
    );
  }

  const largeBefore = ok.some((r) => r.before.largeVisibleImgs.length > 0);
  const largeAfterOnly = ok.some(
    (r) =>
      r.after.largeVisibleImgs.some(
        (img) => !r.before.largeVisibleImgs.some((b) => b.src === img.src),
      ),
  );
  const dataImageAttrs = ok.flatMap((r) =>
    [...r.before.dataAttrs, ...r.after.dataAttrs].filter(
      (a) =>
        /^https?:\/\//i.test(a.value) ||
        /\.(jpe?g|png|webp)/i.test(a.value) ||
        /image|src|zoom|large|full/i.test(a.name),
    ),
  );
  const bgBefore = ok.flatMap((r) => r.before.backgroundImages);
  const bgAfterNew = ok.flatMap((r) =>
    r.after.backgroundImages.filter((u) => !r.before.backgroundImages.includes(u)),
  );
  const netAfter = ok.flatMap((r) => r.networkAfterHover);
  const jsonWithImages = ok.flatMap((r) =>
    r.jsonEndpoints.filter(
      (j) =>
        j.bodyPreview &&
        (/https?:\/\/[^"'\s]+\.(jpe?g|png|webp)/i.test(j.bodyPreview) ||
          /"image|"img|"photo|"picture|"url"/i.test(j.bodyPreview)),
    ),
  );

  const thumbs = ok.flatMap((r) => r.before.imgSrcs);
  const fulls = uniq([
    ...ok.flatMap((r) => r.after.largeVisibleImgs.map((i) => i.src)),
    ...netAfter,
  ]);
  const thumbHints = guessThumbToFull(thumbs, fulls);

  const questions: InvestigateQuestion[] = [
    {
      id: "a",
      question: "Is the large image already present in the DOM (before hover)?",
      answer: ok.length === 0 ? "unknown" : largeBefore ? "yes" : "no",
      evidence: ok.flatMap((r) =>
        r.before.largeVisibleImgs.map(
          (i) =>
            `[${r.ean}] ${i.src} (${i.naturalWidth}x${i.naturalHeight})`,
        ),
      ),
    },
    {
      id: "b",
      question: "Is the large image stored in a data-* attribute?",
      answer:
        ok.length === 0 ? "unknown" : dataImageAttrs.length > 0 ? "yes" : "no",
      evidence: dataImageAttrs
        .slice(0, 30)
        .map((a) => `<${a.tag} ${a.name}="${a.value}">`),
    },
    {
      id: "c",
      question: "Is the large image injected into the DOM after hover?",
      answer: ok.length === 0 ? "unknown" : largeAfterOnly ? "yes" : "no",
      evidence: ok.flatMap((r) => {
        const newly = r.after.largeVisibleImgs.filter(
          (img) => !r.before.largeVisibleImgs.some((b) => b.src === img.src),
        );
        return newly.map(
          (i) =>
            `[${r.ean}] after hover: ${i.src} (${i.naturalWidth}x${i.naturalHeight}); hover=${r.hoverDetail}`,
        );
      }),
    },
    {
      id: "d",
      question: "Is the large image a CSS background-image?",
      answer:
        ok.length === 0
          ? "unknown"
          : bgBefore.length + bgAfterNew.length > 0
            ? bgAfterNew.length > 0
              ? "partial"
              : "yes"
            : "no",
      evidence: [
        ...bgBefore.slice(0, 10).map((u) => `before: ${u}`),
        ...bgAfterNew.slice(0, 10).map((u) => `after-hover: ${u}`),
      ],
    },
    {
      id: "e",
      question: "Is the large image requested over the network after hover?",
      answer: ok.length === 0 ? "unknown" : netAfter.length > 0 ? "yes" : "no",
      evidence: netAfter.slice(0, 30).map((u) => u),
    },
    {
      id: "f",
      question: "Is there an API/JSON endpoint returning image URLs?",
      answer:
        ok.length === 0 ? "unknown" : jsonWithImages.length > 0 ? "yes" : "no",
      evidence: jsonWithImages.slice(0, 15).map(
        (j) =>
          `${j.status} ${j.url}\n${(j.bodyPreview ?? "").slice(0, 500)}`,
      ),
    },
    {
      id: "g",
      question:
        "Is there a predictable thumbnail-URL → full-size-URL relationship?",
      answer:
        ok.length === 0 ? "unknown" : thumbHints.length > 0 ? "yes" : "unknown",
      evidence:
        thumbHints.length > 0
          ? thumbHints
          : [
              "No automatic pattern detected from sampled URLs. Compare thumb vs full paths manually in the JSON dump.",
            ],
    },
  ];

  // Recommend a strategy direction without inventing selectors.
  let recommended = "pending — review evidence below before coding extractors";
  if (netAfter.length > 0) {
    recommended =
      "Prefer network capture after hover (question e). Implement ExtractionStrategy that waits for the confirmed image response and picks the largest URL.";
  } else if (jsonWithImages.length > 0) {
    recommended =
      "Prefer API/JSON parse (question f). Implement ExtractionStrategy that waitForResponse on the confirmed endpoint and reads the image field.";
  } else if (largeAfterOnly) {
    recommended =
      "Prefer post-hover DOM read (question c). Implement ExtractionStrategy that reads the injected <img> / preview container src.";
  } else if (dataImageAttrs.length > 0) {
    recommended =
      "Prefer data-* attribute read (question b). Implement ExtractionStrategy that pulls the confirmed attribute from the row/thumbnail.";
  } else if (thumbHints.length > 0) {
    recommended =
      "Prefer URL rewrite (question g). Implement ExtractionStrategy that transforms the thumbnail URL using the confirmed pattern.";
  } else if (bgBefore.length + bgAfterNew.length > 0) {
    recommended =
      "Prefer CSS background-image (question d). Implement ExtractionStrategy that reads computed style url(...) from the confirmed element.";
  }

  notes.push(
    "Production selectors in search.ts / hover.ts / imageExtractor.ts are still PENDING.",
  );
  notes.push(
    "After reviewing this report, implement a concrete ExtractionStrategy and call setExtractionStrategy() from download-images.ts (or imageExtractor.ts).",
  );
  notes.push(
    "Do not enable a full CSV download until the strategy is registered and a few EANs succeed end-to-end.",
  );

  return { questions, thumbHints, recommended, notes };
}

function toMarkdown(findings: InvestigateFindings): string {
  const lines: string[] = [];
  lines.push("# Brasty image investigation report");
  lines.push("");
  lines.push(`Generated: ${findings.generatedAt}`);
  lines.push(`Base URL: ${findings.baseUrl}`);
  lines.push(`EANs: ${findings.eans.join(", ") || "(none)"}`);
  lines.push(`Session valid: ${findings.sessionValid}`);
  lines.push("");
  lines.push("## Recommended strategy direction");
  lines.push("");
  lines.push(findings.recommendedStrategy);
  lines.push("");
  lines.push("## Questions");
  lines.push("");
  for (const q of findings.questions) {
    lines.push(`### (${q.id}) ${q.question}`);
    lines.push("");
    lines.push(`**Answer:** ${q.answer}`);
    lines.push("");
    if (q.evidence.length === 0) {
      lines.push("_No evidence captured._");
    } else {
      lines.push("Evidence:");
      for (const e of q.evidence) {
        lines.push(`- \`${e.replace(/`/g, "'")}\``);
      }
    }
    lines.push("");
  }
  if (findings.thumbnailToFullSizeHints.length > 0) {
    lines.push("## Thumbnail → full-size hints");
    lines.push("");
    for (const h of findings.thumbnailToFullSizeHints) {
      lines.push(`- ${h}`);
    }
    lines.push("");
  }
  lines.push("## Operator next steps");
  lines.push("");
  for (const n of findings.notes) {
    lines.push(`1. ${n}`);
  }
  lines.push("");
  lines.push(
    "Paste the chosen mechanism back into `src/imageExtractor.ts` (register via `setExtractionStrategy`), refine `PENDING_SEARCH_SELECTORS` / `PENDING_HOVER_SELECTORS` if needed, then run `npm run download` on a tiny CSV slice.",
  );
  lines.push("");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger(cfg.logPath);
  assertStorageStateExists(cfg.storageStatePath);

  const eans = [...cfg.investigateEans];
  // Also accept CLI args: npm run investigate -- 4011… 4012…
  for (const arg of process.argv.slice(2)) {
    if (/^\d{8,14}$/.test(arg)) eans.push(arg);
  }
  const uniqueEans = uniq(eans);

  if (uniqueEans.length === 0) {
    throw new Error(
      "No EANs supplied. Set INVESTIGATE_EANS in .env (comma-separated) or pass EANs as CLI args:\n  npm run investigate -- 4011700747597",
    );
  }

  mkdirSync(cfg.findingsDir, { recursive: true });

  const browser = await chromium.launch({ headless: cfg.headless });
  let sessionValid = false;
  const results: Awaited<ReturnType<typeof investigateOneEan>>[] = [];

  try {
    const context = await openAuthenticatedContext(browser, cfg);
    sessionValid = true;
    const page = await context.newPage();
    await page.goto(cfg.brastyBaseUrl, { waitUntil: "domcontentloaded" });

    for (const ean of uniqueEans) {
      results.push(await investigateOneEan(page, ean, log));
      if (cfg.politenessDelayMs > 0) {
        await new Promise((r) => setTimeout(r, cfg.politenessDelayMs));
      }
    }

    await context.close();
  } catch (err) {
    if (err instanceof SessionExpiredError) {
      log.error(err.message);
      process.exitCode = 2;
      return;
    }
    throw err;
  } finally {
    await browser.close();
  }

  const { questions, thumbHints, recommended, notes } =
    synthesizeQuestions(results);

  const findings: InvestigateFindings = {
    generatedAt: new Date().toISOString(),
    baseUrl: cfg.brastyBaseUrl,
    eans: uniqueEans,
    sessionValid,
    questions,
    thumbnailToFullSizeHints: thumbHints,
    recommendedStrategy: recommended,
    notes,
  };

  // Attach raw per-EAN dumps for the operator (machine-readable only).
  const rawPath = join(cfg.findingsDir, "investigate-raw.json");
  writeFileSync(rawPath, JSON.stringify({ findings, results }, null, 2), "utf8");

  const jsonPath = join(cfg.findingsDir, "investigate-report.json");
  writeFileSync(jsonPath, JSON.stringify(findings, null, 2), "utf8");

  const mdPath = join(cfg.findingsDir, "investigate-report.md");
  writeFileSync(mdPath, toMarkdown(findings), "utf8");

  log.info("── investigation summary ──");
  for (const q of questions) {
    log.info(`  (${q.id}) ${q.answer} — ${q.question}`);
    if (q.evidence[0]) log.info(`       e.g. ${q.evidence[0].slice(0, 120)}`);
  }
  log.info(`Recommended: ${recommended}`);
  log.info(`Wrote ${mdPath}`);
  log.info(`Wrote ${jsonPath}`);
  log.info(`Wrote ${rawPath}`);
  log.info(
    "NEXT: review findings, implement ExtractionStrategy in imageExtractor.ts, then download a tiny CSV slice.",
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
