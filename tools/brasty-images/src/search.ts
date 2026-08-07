/**
 * Product search by EAN on the Brasty listing.
 *
 * Selectors below are INTENTIONALLY generic / configurable placeholders.
 * Do NOT invent Brasty-specific CSS from imagination — refine them from
 * `npm run investigate` findings before a production run.
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

/**
 * Default selector guesses — expected to be replaced after investigation.
 * Marked pending so production runs fail clearly if the DOM does not match.
 */
export const PENDING_SEARCH_SELECTORS: SearchSelectors = {
  searchInput:
    'input[type="search"], input[name*="search" i], input[placeholder*="search" i], input[placeholder*="EAN" i], input[placeholder*="ean" i]',
  productRow:
    'table tbody tr, [class*="product-row"], [class*="productRow"], [data-ean], [class*="product-list"] > *, [role="row"]',
  rowEan: '[data-ean], [class*="ean"], td, span, div',
};

export async function searchByEan(
  page: Page,
  ean: string,
  selectors: SearchSelectors = PENDING_SEARCH_SELECTORS,
): Promise<SearchOutcome> {
  const input = page.locator(selectors.searchInput).first();
  try {
    await input.waitFor({ state: "visible", timeout: 15_000 });
  } catch {
    return {
      ok: false,
      reason: "page_structure",
      detail:
        "Search input not found. Update PENDING_SEARCH_SELECTORS from investigate findings.",
    };
  }

  await input.click({ clickCount: 3 });
  await input.fill("");
  await input.fill(ean);
  // Prefer pressing Enter / input event over arbitrary sleeps.
  await input.press("Enter");

  const rows = page.locator(selectors.productRow);

  // Wait until the listing settles to exactly one visible matching row.
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
          return text.includes(target);
        });
        return visible.length === 1;
      },
      { rowSel: selectors.productRow, target: ean },
      { timeout: 20_000 },
    );
  } catch {
    // Fall through to classify not_found vs ambiguous vs structure.
  }

  const count = await rows.count();
  const matching: Locator[] = [];
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    if (!(await row.isVisible().catch(() => false))) continue;
    const text = ((await row.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
    if (text.includes(ean)) matching.push(row);
  }

  if (matching.length === 0) {
    return {
      ok: false,
      reason: "not_found",
      detail: `No visible product row containing EAN ${ean}`,
    };
  }
  if (matching.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      detail: `${matching.length} visible rows contain EAN ${ean}; need exactly one`,
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
  // Prefer an explicit data-ean attribute on the row or a child.
  const dataEan = await row.getAttribute("data-ean").catch(() => null);
  if (dataEan && dataEan.trim() === searched) return dataEan.trim();

  const child = row.locator(rowEanSel);
  const childCount = await child.count();
  for (let i = 0; i < childCount; i++) {
    const el = child.nth(i);
    const attr = await el.getAttribute("data-ean").catch(() => null);
    if (attr && attr.trim() === searched) return attr.trim();
    const text = ((await el.innerText().catch(() => "")) ?? "").trim();
    // Tokenise and look for an exact EAN token.
    for (const token of text.split(/[\s,;|/]+/)) {
      if (token === searched) return token;
    }
  }

  const whole = ((await row.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
  if (whole.includes(searched)) return searched;
  return "";
}
