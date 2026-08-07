import { describe, expect, test } from "bun:test";
import { BeautyfortConnector } from "../src/vendors/beautyfort/connector.ts";
import { BtsConnector } from "../src/vendors/bts/connector.ts";
import { offerChecksum } from "../src/lib/checksum.ts";
import { foldKey, productSlug, slugify, uniqueTermSlug } from "../src/lib/slugify.ts";
import { computePricing, DEFAULT_RULES } from "../src/sync/pricing.ts";

// These run against the real downloaded feeds in .feedscratch, so they assert the actual data
// shape rather than a hand-written fixture that could drift from reality.

describe("BeautyFort connector", () => {
  const connector = new BeautyfortConnector();

  test("normalizes the full live feed without errors", async () => {
    await connector.prepare();
    const raw = await connector.fetchRaw("local");
    expect(raw.length).toBeGreaterThan(9000);

    const normalized = raw.map((r) => connector.normalize(r)).filter((p) => p !== null);
    // Every record in the live feed is usable; none should be dropped.
    expect(normalized.length).toBe(raw.length);

    for (const p of normalized) {
      expect(p.sku.startsWith("BF-")).toBe(true);
      expect(p.vendorPrice).toBeGreaterThan(0);
      expect(p.stock).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(p.eans)).toBe(true);
      // BeautyFort publishes no RRP.
      expect(p.vendorRecommendedPrice).toBeNull();
    }
  });

  test("decodes UTF-8 rather than mangling it", async () => {
    await connector.prepare();
    const raw = await connector.fetchRaw("local");
    raw.forEach((r) => connector.normalize(r));
    const paths = connector.categories().map((c) => c.key);

    // The atob() bug turned "Reisegröße" into "ReisegrÃ¶Ãe". Assert neither the mojibake
    // sequence nor a replacement character survives anywhere in the tree.
    const joined = paths.join("|");
    expect(joined).not.toContain("Ã");
    expect(joined).not.toContain("\uFFFD");
    expect(paths.some((p) => p.includes("ö") || p.includes("ä") || p.includes("ü"))).toBe(true);
  });

  test("splits multi-EAN barcodes and preserves leading zeros", async () => {
    await connector.prepare();
    const raw = await connector.fetchRaw("local");
    const normalized = raw.map((r) => connector.normalize(r)).filter((p) => p !== null);

    const multi = normalized.filter((p) => p.eans.length > 1);
    expect(multi.length).toBeGreaterThan(1000); // ~16% of 9,209

    const withLeadingZero = normalized.flatMap((p) => p.eans).filter((e) => e.startsWith("0"));
    expect(withLeadingZero.length).toBeGreaterThan(0);
    for (const ean of withLeadingZero) expect(typeof ean).toBe("string");
  });

  test("builds a category tree with every ancestor present", async () => {
    await connector.prepare();
    const raw = await connector.fetchRaw("local");
    raw.forEach((r) => connector.normalize(r));

    const nodes = connector.categories();
    expect(nodes.length).toBeGreaterThan(60);

    const keys = new Set(nodes.map((n) => n.key));
    for (const node of nodes) {
      if (node.parentKey !== null) expect(keys.has(node.parentKey)).toBe(true);
    }
  });

  test("derives gender from the German category path", async () => {
    await connector.prepare();
    const raw = await connector.fetchRaw("local");
    const normalized = raw.map((r) => connector.normalize(r)).filter((p) => p !== null);

    const genders = new Set(normalized.map((p) => p.attributes["gender"]).filter(Boolean));
    expect(genders.has("Women")).toBe(true);
    expect(genders.has("Men")).toBe(true);
  });
});

describe("BTS connector", () => {
  const connector = new BtsConnector();

  test("normalizes the full live feed without errors", async () => {
    await connector.prepare("local");
    const raw = await connector.fetchRaw("local");
    expect(raw.length).toBeGreaterThan(45000);

    const normalized = raw.map((r) => connector.normalize(r)).filter((p) => p !== null);
    expect(normalized.length).toBe(raw.length);

    for (const p of normalized) {
      expect(p.sku.startsWith("BTS-")).toBe(true);
      expect(p.vendorPrice).toBeGreaterThan(0);
      expect(p.categoryRefs.length).toBeGreaterThan(0);
    }
  });

  test("resolves every referenced category against the tree", async () => {
    await connector.prepare("local");
    const nodes = new Map(connector.categories().map((n) => [n.key, n]));
    expect(nodes.size).toBeGreaterThan(4000);

    const raw = await connector.fetchRaw("local");
    const normalized = raw.map((r) => connector.normalize(r)).filter((p) => p !== null);

    // The live feed has zero dangling references, so dropping any would mean a bug here.
    const dangling = normalized.filter((p) => p.categoryRefs.some((c) => !nodes.has(c)));
    expect(dangling.length).toBe(0);
  });

  test("discards the useless RRP zeros", async () => {
    await connector.prepare("local");
    const raw = await connector.fetchRaw("local");
    const normalized = raw.map((r) => connector.normalize(r)).filter((p) => p !== null);

    const withRrp = normalized.filter((p) => p.vendorRecommendedPrice !== null);
    // 46% of rows publish 0, which must normalize to null, not 0.
    expect(withRrp.length).toBeLessThan(normalized.length);
    for (const p of withRrp) expect(p.vendorRecommendedPrice!).toBeGreaterThan(0);
  });

  test("derives gender from the category tree, not the 98%-unisex field", async () => {
    await connector.prepare("local");
    const raw = await connector.fetchRaw("local");
    const normalized = raw.map((r) => connector.normalize(r)).filter((p) => p !== null);

    const men = normalized.filter((p) => p.attributes["gender"] === "Men").length;
    // The raw feed labels only 278 products "man"; the "Men" category root alone holds far more.
    expect(men).toBeGreaterThan(278);
  });
});

describe("checksums", () => {
  test("are stable across calls and sensitive to a price change", async () => {
    const connector = new BeautyfortConnector();
    await connector.prepare();
    const raw = (await connector.fetchRaw("local")).slice(0, 200);
    const products = raw.map((r) => connector.normalize(r)).filter((p) => p !== null);

    for (const p of products) expect(offerChecksum(p)).toBe(offerChecksum(p));

    const first = products[0]!;
    const before = offerChecksum(first);
    expect(offerChecksum({ ...first, vendorPrice: first.vendorPrice + 1 })).not.toBe(before);
    expect(offerChecksum({ ...first, stock: first.stock + 1 })).not.toBe(before);
  });
});

describe("slugify", () => {
  test("applies German transliteration the way WordPress does", () => {
    expect(slugify("Reisegröße")).toBe("reisegroesse");
    expect(slugify("Körperpflege")).toBe("koerperpflege");
    expect(slugify("Haarspülung")).toBe("haarspuelung");
    expect(slugify("Estée Lauder")).toBe("estee-lauder");
    expect(slugify("Bath & Body")).toBe("bath-and-body");
  });

  test("produces deterministic, unique product slugs", () => {
    const a = productSlug("Rochas Eau De Rochas Eau De Toilette Spray 100ml", "BTS-64220");
    expect(a).toBe(productSlug("Rochas Eau De Rochas Eau De Toilette Spray 100ml", "BTS-64220"));
    expect(a.endsWith("-bts-64220")).toBe(true);
    expect(a.length).toBeLessThanOrEqual(200);

    // Same name, different vendor product: different slug, no collision check needed.
    const b = productSlug("Rochas Eau De Rochas Eau De Toilette Spray 100ml", "BF-P407231");
    expect(a).not.toBe(b);
  });

  test("truncates very long names within the post_name column limit", () => {
    const slug = productSlug("x".repeat(400), "BTS-1");
    expect(slug.length).toBeLessThanOrEqual(200);
  });

  test("suffixes colliding term slugs", () => {
    const taken = new Set<string>();
    expect(uniqueTermSlug("Fragrance", taken)).toBe("fragrance");
    expect(uniqueTermSlug("Fragrance", taken)).toBe("fragrance-2");
    expect(uniqueTermSlug("Fragrance", taken)).toBe("fragrance-3");
  });
});

describe("pricing", () => {
  test("multiplies and rounds to two decimals", () => {
    const r = computePricing(
      { vendorPrice: 30.1, vendorRecommendedPrice: null, stock: 44 },
      { ...DEFAULT_RULES, multiplier: 1.2 },
    );
    expect(r.regularPrice).toBe(36.12);
    expect(r.salePrice).toBeNull();
    expect(r.effectivePrice).toBe(36.12);
    expect(r.onSale).toBe(false);
  });

  test("ignores vendor RRP entirely — price is always cost × multiplier", () => {
    const r = computePricing({ vendorPrice: 30, vendorRecommendedPrice: 110, stock: 5 }, DEFAULT_RULES);
    expect(r.regularPrice).toBe(30);
    expect(r.salePrice).toBeNull();
    expect(r.effectivePrice).toBe(30);
    expect(r.onSale).toBe(false);
  });

  test("absurd BTS RRP outliers never appear on the storefront", () => {
    const r = computePricing({ vendorPrice: 30, vendorRecommendedPrice: 42795, stock: 5 }, DEFAULT_RULES);
    expect(r.regularPrice).toBe(30);
    expect(r.salePrice).toBeNull();
  });

  test("hides at or below the threshold and forces out of stock", () => {
    const rules = { ...DEFAULT_RULES, stockThreshold: 3 };
    expect(computePricing({ vendorPrice: 10, vendorRecommendedPrice: null, stock: 3 }, rules).hidden).toBe(true);
    expect(computePricing({ vendorPrice: 10, vendorRecommendedPrice: null, stock: 3 }, rules).stockStatus).toBe(
      "outofstock",
    );
    expect(computePricing({ vendorPrice: 10, vendorRecommendedPrice: null, stock: 4 }, rules).hidden).toBe(false);
    expect(computePricing({ vendorPrice: 10, vendorRecommendedPrice: null, stock: 4 }, rules).stockStatus).toBe(
      "instock",
    );
  });

  test("zero stock is out of stock even with a negative threshold", () => {
    const rules = { ...DEFAULT_RULES, stockThreshold: -1 };
    const r = computePricing({ vendorPrice: 10, vendorRecommendedPrice: null, stock: 0 }, rules);
    expect(r.hidden).toBe(false);
    expect(r.stockStatus).toBe("outofstock");
  });

  test("never produces a free product", () => {
    const r = computePricing(
      { vendorPrice: 0.07, vendorRecommendedPrice: null, stock: 1 },
      { ...DEFAULT_RULES, multiplier: 0.01 },
    );
    expect(r.effectivePrice).toBeGreaterThan(0);
  });
});

describe("foldKey", () => {
  test("matches how the database collation compares strings", () => {
    // These pairs are equal under utf8mb4_unicode_ci. Keying term maps by toLowerCase() instead
    // made JavaScript disagree with the database, and those terms were recreated every run.
    expect(foldKey("MARLIES MOLLER")).toBe(foldKey("Marlies Möller"));
    expect(foldKey("DSQUARED2")).toBe(foldKey("DSQUARED²"));
    expect(foldKey("GIANFRANCO FERRÉ")).toBe(foldKey("Gianfranco Ferre"));
    expect(foldKey("  Dior  ")).toBe(foldKey("DIOR"));
  });

  test("keeps genuinely different brands apart", () => {
    expect(foldKey("Lancôme")).not.toBe(foldKey("Lancaster"));
    expect(foldKey("Armaf")).not.toBe(foldKey("Armani"));
  });

  test("differs from slugify, which transliterates German", () => {
    // slugify maps "ö" to "oe" for WordPress compatibility, which would keep these apart.
    expect(slugify("Möller")).toBe("moeller");
    expect(foldKey("Möller")).toBe("moller");
  });
});
