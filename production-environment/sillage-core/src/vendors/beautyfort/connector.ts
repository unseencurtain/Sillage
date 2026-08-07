import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { env } from "../../config/env.ts";
import { logger } from "../../lib/log.ts";
import { feedCacheProducts, readFeedCache, writeFeedCache } from "../feedCache.ts";
import { recordLiveFetch, resolveLiveOrCache } from "../liveGate.ts";
import { VendorConnector } from "../VendorConnector.ts";
import type { FeedSource, NormalizedProduct, ProgressFn, VendorCategoryNode } from "../types.ts";
import { BeautyfortClient, parseLenientJson } from "./BeautyfortClient.ts";

const log = logger("beautyfort");

/** A raw BeautyFort stock-file record. All 13 keys are present on every row. */
interface BeautyfortRaw {
  Barcode: string;
  Brand: string;
  Category: string;
  Collection: string;
  Description: string;
  FullName: string;
  Price: string;
  Quantity: string;
  Size: string;
  StockCode: string;
  StockLevel: number;
  ThumbnailImageUrl: string;
  Type: string;
}

/**
 * BeautyFort encodes gender in the category path, which is the reliable source for both vendors.
 * Keys are lowercased leaf segment names.
 */
const GENDER_BY_SEGMENT: Record<string, string> = {
  damen: "Women",
  herren: "Men",
  unisex: "Unisex",
  kinder: "Kids",
};

export class BeautyfortConnector extends VendorConnector {
  readonly slug = "beautyfort";
  readonly skuPrefix = "BF";

  private categoryNodes = new Map<string, VendorCategoryNode>();

  /**
   * BeautyFort has no category endpoint — the tree is implicit in the product rows. `prepare` is a
   * no-op and the node set is accumulated during `normalize`, so `categories()` must be read after
   * the feed has been normalized.
   */
  async prepare(): Promise<void> {
    this.categoryNodes.clear();
  }

  async fetchRaw(source: FeedSource, progress?: ProgressFn): Promise<unknown[]> {
    if (source === "local") {
      const path = join(env.fixturesDir, "beautyfort_full.json");
      progress?.(`reading fixture ${path}`);
      const parsed = parseLenientJson(await readFile(path, "utf8"));
      if (!Array.isArray(parsed)) throw new Error(`${path} did not parse to an array`);
      log.info(`loaded ${parsed.length} products from fixture`);
      return parsed;
    }

    if (source === "cache") {
      const cached = await readFeedCache("beautyfort");
      if (!cached) throw new Error("no BeautyFort feed cache — run one live sync first");
      const rows = feedCacheProducts(cached);
      progress?.(`using cached BeautyFort feed (${rows.length} rows)`);
      return rows;
    }

    // `live` — hard-gated. Prefer disk cache when the min interval or daily cap blocks us.
    const resolved = await resolveLiveOrCache("beautyfort", "live");
    if (resolved.mode === "cache") {
      const cached = await readFeedCache("beautyfort");
      if (cached) {
        const rows = feedCacheProducts(cached);
        progress?.(
          `live gated (${resolved.gate?.reason ?? "rate limit"}) — cache (${rows.length} rows)`,
        );
        return rows;
      }
      log.warn("live gated and no cache — forcing one BeautyFort download");
    }

    progress?.("downloading stock file (SOAP, whole catalogue, no pagination)");
    const client = new BeautyfortClient({
      user: env.beautyfort.user,
      secret: env.beautyfort.secret,
      endpoint: env.beautyfort.endpoint,
      testMode: env.beautyfort.testMode,
    });
    const rows = await client.getStockFile();
    log.info(`downloaded ${rows.length} products`);
    await writeFeedCache("beautyfort", rows);
    await recordLiveFetch("beautyfort");
    return rows;
  }

  normalize(raw: unknown): NormalizedProduct | null {
    const r = raw as BeautyfortRaw;
    const vendorProductId = String(r.StockCode ?? "").trim();
    if (!vendorProductId) return null;

    const name = String(r.FullName ?? "").trim();
    if (!name) return null;

    const vendorPrice = Number.parseFloat(String(r.Price ?? ""));
    if (!Number.isFinite(vendorPrice) || vendorPrice <= 0) return null;

    // Barcode holds up to 26 comma-separated EANs on 16% of rows. Never cast to a number:
    // 2,854 tokens in the live feed have leading zeros.
    const eans = [...new Set(
      String(r.Barcode ?? "")
        .split(",")
        .map((e) => e.trim())
        .filter((e) => e.length > 0 && /^\d+$/.test(e)),
    )];

    const categoryPath = String(r.Category ?? "").trim();
    const categoryRefs = categoryPath ? [categoryPath] : [];
    if (categoryPath) this.registerPath(categoryPath);

    const attributes: Record<string, string> = {};
    const type = String(r.Type ?? "").trim();
    if (type) attributes["type"] = type;
    const size = String(r.Size ?? "").trim();
    if (size) attributes["volume"] = `${size} ml`;
    const gender = this.genderFromPath(categoryPath);
    if (gender) attributes["gender"] = gender;

    // Empty on 10.2% of rows; the plugin renders a WooCommerce placeholder in that case.
    const image = String(r.ThumbnailImageUrl ?? "").trim();

    const stockLevel = Number(r.StockLevel);

    return {
      vendorSlug: this.slug,
      vendorProductId,
      sku: this.makeSku(vendorProductId),
      eans,
      name,
      description: String(r.Description ?? "").trim(),
      brand: String(r.Brand ?? "").trim() || null,
      categoryRefs,
      attributes,
      vendorPrice,
      // BeautyFort publishes no RRP at all.
      vendorRecommendedPrice: null,
      stock: Number.isFinite(stockLevel) ? Math.max(0, Math.trunc(stockLevel)) : 0,
      imageUrl: image || null,
      galleryUrls: [],
      extra: {
        collection: String(r.Collection ?? "").trim() || null,
        size: size || null,
        type: type || null,
      },
    };
  }

  categories(): VendorCategoryNode[] {
    return [...this.categoryNodes.values()];
  }

  /**
   * Split `"Duft > Damen"` into nodes keyed by their running path prefix, so the leaf key matches
   * what `categoryRefs` carries and every ancestor is created exactly once.
   */
  private registerPath(path: string): void {
    const segments = path
      .split(">")
      .map((s) => s.trim())
      .filter(Boolean);

    let parentKey: string | null = null;
    let running = "";
    for (const segment of segments) {
      running = running ? `${running} > ${segment}` : segment;
      if (!this.categoryNodes.has(running)) {
        this.categoryNodes.set(running, { key: running, name: segment, parentKey });
      }
      parentKey = running;
    }
  }

  private genderFromPath(path: string): string | undefined {
    for (const segment of path.split(">")) {
      const hit = GENDER_BY_SEGMENT[segment.trim().toLowerCase()];
      if (hit) return hit;
    }
    return undefined;
  }
}
