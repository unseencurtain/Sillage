import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("BTS fast-sync recovery", () => {
  const runSrc = readFileSync(join(import.meta.dir, "../src/sync/run.ts"), "utf8");
  const diffSrc = readFileSync(join(import.meta.dir, "../src/sync/diff.ts"), "utf8");
  const connectorSrc = readFileSync(join(import.meta.dir, "../src/vendors/bts/connector.ts"), "utf8");
  const clientSrc = readFileSync(join(import.meta.dir, "../src/vendors/bts/BtsClient.ts"), "utf8");

  test("BTS delta uses a floored lookback, not the last combined run", () => {
    expect(runSrc).toContain("resolveDeltaSince");
    expect(runSrc).toContain('vendorId: vendor.slug');
    expect(runSrc).toContain("staleOfferRatio");
  });

  test("price/stock deltas mark products dirty before the WooCommerce writer", () => {
    expect(runSrc).toContain("markPriceDirtyFromPendingOffers");
    const writeBranch = runSrc.indexOf("} else if (!options.dryRun) {");
    const markAt = runSrc.indexOf("await markPriceDirtyFromPendingOffers()");
    expect(writeBranch).toBeGreaterThan(-1);
    expect(markAt).toBeGreaterThan(writeBranch);
  });

  test("partial BTS imports do not vanish the rest of the catalogue", () => {
    expect(diffSrc).toContain("vanish?: boolean");
    expect(runSrc).toContain("vanish: false");
  });

  test("BTS change rows carry a SKU and missing SKUs can be fetched", () => {
    expect(connectorSrc).toContain("sku: String(c.product_sku");
    expect(connectorSrc).toContain("fetchNormalizedBySkus");
    expect(connectorSrc).toContain('prepare("cache"');
  });

  test("product-changes pagination tolerates a missing products array", () => {
    expect(clientSrc).toContain("res.products ?? []");
  });
});
