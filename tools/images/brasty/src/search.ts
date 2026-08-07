/**
 * Product search by EAN on the Brasty listing.
 *
 * Brasty has no PDP — products are `.c-product` rows in a searchable list.
 * Confirmed from investigate findings (2026-08-07): search input `#frm-search-form-q`,
 * rows `.c-product`, EAN text in `.c-product__name` as `EAN: <digits>`.
 */
import type { Locator, Page } from "playwright";
import type { SearchOutcome } from "./types.js";

export interface SearchSelectors {
  /** Search input on the product listing. */
  searchInput: string;
  /** Candidate product rows after filtering. */
  productRow: string;
  /** Locator (relative to a row) that holds the visible EAN text. */
  rowEan: string;
}

/** Selectors confirmed against wholesale.brasty.com product list. */
export const PENDING_SEARCH_SELECTORS: SearchSelectors = {
  searchInput: "#frm-search-form-q, input.c-search__input[name='q']",
  productRow: ".c-product",
  rowEan: ".c-product__name p, .c-product__name",
};

export async function searchByEan(
  page: Page,
  ean: string,
  selectors: SearchSelectors = PENDING_SEARCH_SELECTORS,
): Promise<SearchOutcome> {
  // Prefer a direct list URL — same destination as submitting the header search.
  const base = new URL(page.url()).origin;
  const targetUrl = `${base}/products?q=${encodeURIComponent(ean)}`;
  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch {
    // Fall back to typing in the search box if navigation fails.
    const input = page.locator(selectors.searchInput).first();
    try {
      await input.waitFor({ state: "visible", timeout: 15_000 });
    } catch {
      return {
        ok: false,
        reason: "page_structure",
        detail:
          "Search input not found and /products?q= navigation failed. Check BRASTY_BASE_URL / session.",
      };
    }
    await input.click({ clickCount: 3 });
    await input.fill("");
    await input.fill(ean);
    await input.press("Enter");
  }

  const rows = page.locator(selectors.productRow);

  try {
    await page.waitForFunction(
      ({ rowSel, target }) => {
        const nodes = Array.from(document.querySelectorAll(rowSel));
        const visible = nodes.filter((el) => {
          const style = window.getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return false;
          const text = (el.textContent ?? "").replace(/\s+/g, " ");
          return new RegExp(`EAN:\\s*${target}\\b`).test(text) || text.includes(target);
        });
        return visible.length >= 1;
      },
      { rowSel: selectors.productRow, target: ean },
      { timeout: 20_000 },
    );
  } catch {
    // Fall through to classify not_found vs ambiguous.
  }

  const count = await rows.count();
  const matching: Locator[] = [];
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    if (!(await row.isVisible().catch(() => false))) continue;
    const text = ((await row.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
    const eanMatch = new RegExp(`EAN:\\s*${ean}\\b`).test(text) || text.includes(ean);
    if (eanMatch) matching.push(row);
  }

  if (matching.length === 0) {
    return {
      ok: false,
      reason: "not_found",
      detail: `No visible .c-product row containing EAN ${ean}`,
    };
  }
  if (matching.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      detail: `${matching.length} visible .c-product rows contain EAN ${ean}; need exactly one`,
    };
  }

  const row = matching[0]!;
  const matchedEan = await extractRowEan(row, ean, selectors.rowEan);
  if (matchedEan !== ean) {
    return {
      ok: false,
      reason: "ean_mismatch",
      detail: `Row EAN "${matchedEan}" !== searched "${ean}"`,
    };
  }

  return { ok: true, rowLocator: row, matchedEan };
}

async function extractRowEan(
  row: Locator,
  searched: string,
  rowEanSel: string,
): Promise<string> {
  const dataEan = await row.getAttribute("data-ean").catch(() => null);
  if (dataEan && dataEan.trim() === searched) return dataEan.trim();

  const child = row.locator(rowEanSel);
  const childCount = await child.count();
  for (let i = 0; i < childCount; i++) {
    const el = child.nth(i);
    const attr = await el.getAttribute("data-ean").catch(() => null);
    if (attr && attr.trim() === searched) return attr.trim();
    const text = ((await el.innerText().catch(() => "")) ?? "").trim();
    const labeled = /EAN:\s*(\d{8,14})\b/i.exec(text);
    if (labeled?.[1] === searched) return labeled[1];
    for (const token of text.split(/[\s,;|/]+/)) {
      if (token === searched) return token;
    }
  }

  const whole = ((await row.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
  const labeled = /EAN:\s*(\d{8,14})\b/i.exec(whole);
  if (labeled?.[1] === searched) return labeled[1];
  if (whole.includes(searched)) return searched;
  return "";
}
