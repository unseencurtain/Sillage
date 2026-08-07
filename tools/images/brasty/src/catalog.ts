/**
 * Brasty B2B product-list pagination helpers.
 *
 * Confirmed (live probe 2026-08-08):
 * - IN STOCK checkbox: `#category-1000001` name `f[t][]` value `1000001`
 * - OUT OF STOCK: `#category-1000002` value `1000002`
 * - ~60 `.c-product` rows / page, paging via `?page=N` (`.c-paging`)
 * - Row EAN in `.c-product__name` as `EAN: <digits>`; large URL on `picture[data-image]`
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Locator, Page } from "playwright";

export type StockFilter = "in_stock" | "out_of_stock";

export const STOCK_FILTER_IDS: Record<StockFilter, string> = {
  in_stock: "1000001",
  out_of_stock: "1000002",
};

export interface CatalogCheckpoint {
  stockFilter: StockFilter;
  page: number;
  maxPage: number;
  /** Rows already handled on the current page (0-based index into visible rows). */
  rowIndex: number;
  startedAt: string;
  updatedAt: string;
  /** Optional label count from the filter checkbox, e.g. 14462. */
  listedCount?: number;
}

export interface ListRowMeta {
  ean: string;
  name: string;
  productId: string | null;
  row: Locator;
  index: number;
}

/** Build a stable filtered list URL for a 1-based page. */
export function buildCatalogListUrl(
  baseUrl: string,
  stockFilter: StockFilter,
  page: number,
): string {
  const origin = new URL(baseUrl).origin;
  const params = new URLSearchParams();
  params.append("f[t][]", STOCK_FILTER_IDS[stockFilter]);
  // Price / order-value ranges observed on the live filter form.
  params.set("f[c]", "0:1000");
  params.set("f[o]", "0:20000");
  params.set("sort", "name");
  if (page > 1) params.set("page", String(page));
  return `${origin}/products?${params.toString()}`;
}

export async function readListedCount(
  page: Page,
  stockFilter: StockFilter,
): Promise<number | undefined> {
  const id = STOCK_FILTER_IDS[stockFilter];
  const label = page.locator(`label[for="category-${id}"]`);
  const text = ((await label.textContent().catch(() => "")) ?? "").replace(
    /\s+/g,
    " ",
  );
  const m = /\((\d[\d\s]*)\)/.exec(text);
  if (!m) return undefined;
  return Number.parseInt(m[1]!.replace(/\s+/g, ""), 10);
}

export async function readMaxPage(page: Page): Promise<number> {
  const links = page.locator(".c-paging a[href*='page=']");
  const n = await links.count();
  let max = 1;
  for (let i = 0; i < n; i++) {
    const href = await links.nth(i).getAttribute("href").catch(() => null);
    if (!href) continue;
    try {
      const u = new URL(href, page.url());
      const p = Number.parseInt(u.searchParams.get("page") ?? "", 10);
      if (Number.isFinite(p) && p > max) max = p;
    } catch {
      /* ignore */
    }
  }
  const active = page.locator(".c-paging__item--active .step, .c-paging__item--active");
  const activeText = ((await active.first().textContent().catch(() => "")) ?? "").trim();
  const activeNum = Number.parseInt(activeText, 10);
  if (Number.isFinite(activeNum) && activeNum > max) max = activeNum;
  return max;
}

export async function loadCatalogPage(
  page: Page,
  baseUrl: string,
  stockFilter: StockFilter,
  pageNum: number,
): Promise<{ rowCount: number; maxPage: number; listedCount?: number }> {
  const url = buildCatalogListUrl(baseUrl, stockFilter, pageNum);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForSelector(".c-product", { timeout: 30_000 });
  // Ensure filter stayed applied (site sometimes drops it on odd navigations).
  const checked = page.locator(`#category-${STOCK_FILTER_IDS[stockFilter]}`);
  const isChecked = await checked.isChecked().catch(() => false);
  if (!isChecked) {
    await checked.check({ force: true }).catch(async () => {
      await page.locator(`label[for="category-${STOCK_FILTER_IDS[stockFilter]}"]`).click();
    });
    await page.waitForSelector(".c-product", { timeout: 30_000 });
  }
  const rowCount = await page.locator(".c-product").count();
  const maxPage = await readMaxPage(page);
  const listedCount = await readListedCount(page, stockFilter);
  return { rowCount, maxPage, listedCount };
}

export async function collectVisibleRows(page: Page): Promise<ListRowMeta[]> {
  const rows = page.locator(".c-product");
  const count = await rows.count();
  const out: ListRowMeta[] = [];
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    if (!(await row.isVisible().catch(() => false))) continue;
    const meta = await extractRowMeta(row, i);
    if (meta) out.push(meta);
  }
  return out;
}

async function extractRowMeta(
  row: Locator,
  index: number,
): Promise<ListRowMeta | null> {
  const name =
    ((await row.locator(".c-product__name h2, h2").first().textContent().catch(() => "")) ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const nameBlock =
    ((await row.locator(".c-product__name").first().innerText().catch(() => "")) ?? "")
      .replace(/\s+/g, " ")
      .trim();
  const whole = ((await row.innerText().catch(() => "")) ?? "").replace(/\s+/g, " ");
  const eanMatch =
    /EAN:\s*(\d{8,14})\b/i.exec(nameBlock) ||
    /EAN:\s*(\d{8,14})\b/i.exec(whole);
  if (!eanMatch?.[1]) return null;
  const idMatch = /\bID:\s*(\d+)\b/i.exec(nameBlock) || /\bID:\s*(\d+)\b/i.exec(whole);
  return {
    ean: eanMatch[1],
    name: name || nameBlock.slice(0, 120),
    productId: idMatch?.[1] ?? null,
    row,
    index,
  };
}

export function loadCheckpoint(path: string): CatalogCheckpoint | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CatalogCheckpoint;
  } catch {
    return null;
  }
}

export function saveCheckpoint(path: string, cp: CatalogCheckpoint): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cp, null, 2)}\n`, "utf8");
}
