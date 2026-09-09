import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isParkedVendor,
  storefrontVendorSlugs,
  vendorSelectableForSync,
} from "../src/vendors/registry.ts";

describe("retail storefront", () => {
  test("this process is retail BeautyFort + BTS", () => {
    expect(storefrontVendorSlugs()).toEqual(["beautyfort", "bts"]);
    expect(isParkedVendor("wholesale-perfumes")).toBe(true);
    expect(isParkedVendor("beautyfort")).toBe(false);
    expect(vendorSelectableForSync("beautyfort", false)).toBe(true);
    expect(vendorSelectableForSync("wholesale-perfumes", true)).toBe(false);
  });

  test("dry-run comes from the request or the setting, and nothing else overrides it", () => {
    // Every stack runs against the same two wholesalers with the same credentials, so no stack is
    // a sandbox and none of them may quietly overrule the Orders page in either direction.
    const src = readFileSync(join(import.meta.dir, "../src/orders/dispatch.ts"), "utf8");
    expect(src).toContain("options.dryRun ?? settings.ordersDryRun");
    expect(src).not.toContain("devBox");
  });

  test("overview hidden reasons are exclusive (image, stock, operator)", () => {
    const src = readFileSync(join(import.meta.dir, "../src/server/routes/api.ts"), "utf8");
    expect(src).toContain("hidden_no_image");
    expect(src).toContain("hidden_stock");
    expect(src).toContain("hidden_operator");
  });

  test("compose has no wholesale profile or wholesale-* containers", () => {
    const compose = readFileSync(join(import.meta.dir, "../../compose.yaml"), "utf8");
    expect(compose).not.toContain("profiles: [\"wholesale\"]");
    expect(compose).not.toContain("container_name: wholesale-db");
    expect(compose).not.toContain("container_name: wholesale-core");
    expect(compose).toContain("container_name: ecom-db");
    expect(compose).toContain("container_name: sillage-core");
  });

  test("order adapters are BeautyFort + BTS only", () => {
    const src = readFileSync(join(import.meta.dir, "../src/orders/adapters/index.ts"), "utf8");
    expect(src).toContain("BeautyfortOrderAdapter");
    expect(src).toContain("BtsOrderAdapter");
    expect(src).not.toContain("WholesalePerfumes");
  });

  test("sitemap CLI imports from src/cli via ../config, not a bogus ../src path", () => {
    const src = readFileSync(join(import.meta.dir, "../src/cli/sitemap.ts"), "utf8");
    expect(src).toContain('from "../config/secrets.ts"');
    expect(src).toContain('from "../sync/sitemaps.ts"');
    expect(src).not.toContain('from "../src/');
  });
});
