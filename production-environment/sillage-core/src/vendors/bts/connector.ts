import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../../config/env.ts";
import { logger } from "../../lib/log.ts";
import { parseLenientJson } from "../beautyfort/BeautyfortClient.ts";
import {
  feedCacheCategories,
  feedCacheProducts,
  readFeedCache,
  writeFeedCache,
} from "../feedCache.ts";
import { recordLiveFetch, resolveLiveOrCache } from "../liveGate.ts";
import { VendorConnector } from "../VendorConnector.ts";
import type {
  FeedSource,
  NormalizedProduct,
  PriceStockUpdate,
  ProgressFn,
  VendorCategoryNode,
} from "../types.ts";
import { BTSClient } from "./BtsClient.ts";
import type { Category, Product } from "./types.ts";

const log = logger("bts");

/**
 * BTS's own `gender` field is 98.4% "unisex", so it is worthless as a facet. Gender is instead
 * derived by walking a product's category ancestors and matching these segment names. The feed is
 * multilingual in places, hence the Spanish and French variants.
 */
const GENDER_PATTERNS: Array<[RegExp, string]> = [
  [/^(kids?|children|ni[nñ]os?|infantil|baby|beb[eé])$/i, "Kids"],
  [/^(wom[ae]n|women'?s|damen|mujer|femme|female|her)$/i, "Women"],
  [/^(m[ae]n|men'?s|herren|hombre|homme|male|him)$/i, "Men"],
  [/^unisex$/i, "Unisex"],
];

export class BtsConnector extends VendorConnector {
  readonly slug = "bts";
  readonly skuPrefix = "BTS";

  private categoryNodes = new Map<string, VendorCategoryNode>();
  /** Category id -> resolved gender, memoized while walking ancestors. */
  private genderByCategory = new Map<string, string | null>();

  async prepare(source: FeedSource, progress?: ProgressFn): Promise<void> {
    this.categoryNodes.clear();
    this.genderByCategory.clear();

    let raw: Category[];
    if (source === "local") {
      const path = join(env.fixturesDir, "bts_categories_full.json");
      progress?.(`reading category fixture ${path}`);
      raw = parseLenientJson(await readFile(path, "utf8")) as Category[];
    } else if (source === "cache") {
      const cached = await readFeedCache("bts");
      const cats = cached ? feedCacheCategories(cached) : null;
      if (Array.isArray(cats) && cats.length > 0) {
        progress?.(`using cached BTS categories (${cats.length})`);
        raw = cats as Category[];
      } else {
        try {
          const path = join(env.fixturesDir, "bts_categories_full.json");
          raw = parseLenientJson(await readFile(path, "utf8")) as Category[];
          progress?.(`cache missing categories — fixture ${path}`);
        } catch {
          raw = [];
        }
      }
    } else {
      const resolved = await resolveLiveOrCache("bts", "live");
      if (resolved.mode === "cache") {
        const cached = await readFeedCache("bts");
        const cats = cached ? feedCacheCategories(cached) : null;
        if (Array.isArray(cats) && cats.length > 0) {
          progress?.(`live gated — cached BTS categories (${cats.length})`);
          raw = cats as Category[];
        } else {
          progress?.("fetching category tree (no category cache)");
          raw = await this.client().getListCategories(env.bts.language);
        }
      } else {
        progress?.("fetching category tree");
        raw = await this.client().getListCategories(env.bts.language);
      }
    }

    for (const node of raw) {
      const key = String(node.id);
      this.categoryNodes.set(key, {
        key,
        name: String(node.name ?? "").trim() || `Category ${key}`,
        parentKey: node.parent_id && node.parent_id !== 0 ? String(node.parent_id) : null,
      });
    }
    // Stash for writeFeedCache — products fetch will merge.
    this._pendingCategories = raw;
    log.info(`category tree: ${this.categoryNodes.size} nodes`);
  }

  private _pendingCategories: Category[] = [];

  async fetchRaw(source: FeedSource, progress?: ProgressFn): Promise<unknown[]> {
    if (source === "local") {
      const path = join(env.fixturesDir, "bts_products_full.json");
      progress?.(`reading fixture ${path}`);
      const parsed = parseLenientJson(await readFile(path, "utf8"));
      const rows = Array.isArray(parsed)
        ? parsed
        : (parsed as { products?: unknown[] }).products;
      if (!Array.isArray(rows)) throw new Error(`${path} did not parse to an array`);
      log.info(`loaded ${rows.length} products from fixture`);
      return rows;
    }

    if (source === "cache") {
      const cached = await readFeedCache("bts");
      if (!cached) throw new Error("no BTS feed cache — run one live sync first");
      const rows = feedCacheProducts(cached);
      progress?.(`using cached BTS feed (${rows.length} rows)`);
      return rows;
    }

    const resolved = await resolveLiveOrCache("bts", "live");
    if (resolved.mode === "cache") {
      const cached = await readFeedCache("bts");
      if (cached) {
        const rows = feedCacheProducts(cached);
        progress?.(
          `live gated (${resolved.gate?.reason ?? "rate limit"}) — cache (${rows.length} rows)`,
        );
        return rows;
      }
      log.warn("live gated and no cache — forcing one BTS download");
    }

    progress?.("downloading catalogue (paginated, 500/page)");
    const rows = await this.client().getAllProducts(
      { page_size: 500, language_code: env.bts.language },
      (page, totalPages, fetched) => progress?.(`page ${page}/${totalPages} — ${fetched} products`),
    );
    log.info(`downloaded ${rows.length} products`);
    await writeFeedCache("bts", { products: rows, categories: this._pendingCategories });
    await recordLiveFetch("bts");
    return rows;
  }

  normalize(raw: unknown): NormalizedProduct | null {
    const r = raw as Product;
    const vendorProductId = String(r.id ?? "").trim();
    if (!vendorProductId || vendorProductId === "undefined") return null;

    const name = String(r.name ?? "").trim();
    if (!name) return null;

    const vendorPrice = Number(r.price);
    if (!Number.isFinite(vendorPrice) || vendorPrice <= 0) return null;

    const ean = String(r.ean ?? "").trim();
    const eans = ean && /^\d+$/.test(ean) ? [ean] : [];

    // "14498/15029" — 61% of rows carry two ids, some carry up to twenty.
    const categoryRefs = String(r.categories ?? "")
      .split("/")
      .map((c) => c.trim())
      .filter((c) => c.length > 0 && this.categoryNodes.has(c));

    const attributes: Record<string, string> = {};
    const gender = this.genderFromCategories(categoryRefs) ?? this.genderFromField(r.gender);
    if (gender) attributes["gender"] = gender;

    const rrp = Number(r.recommended_price);

    const stock = Number(r.stock);

    return {
      vendorSlug: this.slug,
      vendorProductId,
      sku: this.makeSku(vendorProductId),
      eans,
      name,
      description: String(r.description ?? "").trim(),
      brand: String(r.manufacturer ?? "").trim() || null,
      categoryRefs,
      attributes,
      vendorPrice,
      // Zero means "no RRP published" on 46% of rows; the pricing clamp handles the rest.
      vendorRecommendedPrice: Number.isFinite(rrp) && rrp > 0 ? rrp : null,
      stock: Number.isFinite(stock) ? Math.max(0, Math.trunc(stock)) : 0,
      imageUrl: String(r.image ?? "").trim() || null,
      galleryUrls: [],
      extra: {
        flammable: r.flammable ?? false,
        leadTimeHours: r.leadtime_to_ship ? Number(r.leadtime_to_ship) : (r.delivery ?? null),
        restrictedCountries: r.restricted_countries ?? [],
      },
    };
  }

  categories(): VendorCategoryNode[] {
    return [...this.categoryNodes.values()];
  }

  /** BTS supports a real delta, so the 30-minute fast sync avoids pulling 46k rows. */
  override async fetchPriceStock(since: Date, progress?: ProgressFn): Promise<PriceStockUpdate[] | null> {
    // The endpoint refuses a window wider than 30 days.
    const earliest = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
    const from = since < earliest ? earliest : since;
    const stamp = from.toISOString().slice(0, 19).replace("T", " ");

    progress?.(`fetching changes since ${stamp}`);
    const changes = await this.client().getAllProductChanges(stamp, env.bts.language);

    return changes.map((c) => ({
      vendorProductId: String(c.id),
      price: Number(c.product_price),
      recommendedPrice: Number(c.recommended_price) > 0 ? Number(c.recommended_price) : null,
      stock: Math.max(0, Math.trunc(Number(c.product_stock))),
    }));
  }

  override async fetchServiceableCountries(): Promise<string[]> {
    const countries = await this.client().getCountries();
    return countries.map((c) => c.country_code.toUpperCase());
  }

  private client(): BTSClient {
    if (!env.bts.token) throw new Error("BTS_JWT_TOKEN is not set");
    return new BTSClient({ token: env.bts.token, baseUrl: env.bts.baseUrl, timeout: 180_000 });
  }

  /** Walk each referenced category up to its root, most specific match wins. */
  private genderFromCategories(refs: string[]): string | undefined {
    for (const ref of refs) {
      const resolved = this.resolveGender(ref, 0);
      if (resolved) return resolved;
    }
    return undefined;
  }

  private resolveGender(key: string, depth: number): string | null {
    if (depth > 16) return null; // the live tree is depth 4 and acyclic; this is belt and braces
    const cached = this.genderByCategory.get(key);
    if (cached !== undefined) return cached;

    const node = this.categoryNodes.get(key);
    if (!node) return null;

    let result: string | null = null;
    for (const [pattern, gender] of GENDER_PATTERNS) {
      if (pattern.test(node.name.trim())) {
        result = gender;
        break;
      }
    }
    if (!result && node.parentKey) result = this.resolveGender(node.parentKey, depth + 1);

    this.genderByCategory.set(key, result);
    return result;
  }

  private genderFromField(value: string | undefined): string | undefined {
    switch (String(value ?? "").toLowerCase()) {
      case "woman":
      case "women":
        return "Women";
      case "man":
      case "men":
        return "Men";
      case "children":
        return "Kids";
      default:
        return undefined;
    }
  }
}
