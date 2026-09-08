import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseSillageProfile,
  lockName,
  env,
} from "../src/config/env.ts";
import {
  isParkedVendor,
  parkedVendorSlugsFor,
  storefrontVendorSlugs,
  vendorSelectableForSync,
} from "../src/vendors/registry.ts";
import { resolveDispatchDryRun, wholesaleMinOrderEur } from "../src/storefront/profile.ts";

describe("storefront profile", () => {
  test("parseSillageProfile defaults to retail", () => {
    expect(parseSillageProfile("")).toBe("retail");
    expect(parseSillageProfile("RETAIL")).toBe("retail");
    expect(parseSillageProfile("wholesale")).toBe("wholesale");
    expect(parseSillageProfile(" Wholesale ")).toBe("wholesale");
  });

  test("this test process is retail (default env)", () => {
    expect(env.sillageProfile).toBe("retail");
    expect(env.lockPrefix).toBe("sillage");
    expect(lockName("sync")).toBe("sillage:sync");
  });

  test("retail parks wholesale-perfumes; wholesale parks BF/BTS", () => {
    expect([...parkedVendorSlugsFor("retail")].sort()).toEqual(["wholesale-perfumes"]);
    expect([...parkedVendorSlugsFor("wholesale")].sort()).toEqual(["beautyfort", "bts"]);
    expect(isParkedVendor("wholesale-perfumes", "retail")).toBe(true);
    expect(isParkedVendor("beautyfort", "retail")).toBe(false);
    expect(isParkedVendor("beautyfort", "wholesale")).toBe(true);
    expect(isParkedVendor("wholesale-perfumes", "wholesale")).toBe(false);
  });

  test("storefrontVendorSlugs is WPF on wholesale and BF+BTS on retail", () => {
    expect(storefrontVendorSlugs("retail")).toEqual(["beautyfort", "bts"]);
    expect(storefrontVendorSlugs("wholesale")).toEqual(["wholesale-perfumes"]);
  });

  test("vendorSelectableForSync matches the two storefronts", () => {
    expect(vendorSelectableForSync("beautyfort", false, "retail")).toBe(true);
    expect(vendorSelectableForSync("wholesale-perfumes", false, "retail")).toBe(false);
    expect(vendorSelectableForSync("wholesale-perfumes", true, "retail")).toBe(true);
    expect(vendorSelectableForSync("beautyfort", true, "wholesale")).toBe(false);
    expect(vendorSelectableForSync("bts", false, "wholesale")).toBe(false);
    expect(vendorSelectableForSync("wholesale-perfumes", false, "wholesale")).toBe(true);
  });

  test("wholesale min order is €300 and dispatch dry-run is forced when profile is wholesale", () => {
    expect(wholesaleMinOrderEur()).toBe(300);
    // This process is retail, so resolveDispatchDryRun honours the request.
    expect(resolveDispatchDryRun(false)).toBe(false);
    expect(resolveDispatchDryRun(true)).toBe(true);
  });

  test("overview hidden reasons are exclusive (image, stock, operator)", () => {
    const apiSrc = readFileSync(join(import.meta.dir, "../src/server/routes/api.ts"), "utf8");
    expect(apiSrc).toContain("AS hidden_operator");
    expect(apiSrc).toContain("IFNULL(sp.operator_hidden, 0) = 0");
    expect(apiSrc).toContain("so.image_url IS NOT NULL AND so.image_url != ''");
    expect(apiSrc).toContain("hiddenOperator:");
  });

  test("sync run uses profile-aware park + lockName", () => {
    const runSrc = readFileSync(join(import.meta.dir, "../src/sync/run.ts"), "utf8");
    expect(runSrc).toContain("parkForeignVendorsFromStorefront");
    expect(runSrc).toContain("vendorSelectableForSync");
    expect(runSrc).toContain("lockName(name)");
    expect(runSrc).toContain("applyStorefrontProfile");
  });

  test("pending rewrite lock uses lockName", () => {
    const pendingSrc = readFileSync(join(import.meta.dir, "../src/sync/pendingRewrite.ts"), "utf8");
    expect(pendingSrc).toContain('lockName("sync")');
    expect(pendingSrc).not.toContain('["sillage:sync"]');
  });

  test("wholesale-perfumes adapter dry-run returns before cart mutation", () => {
    const src = readFileSync(
      join(import.meta.dir, "../src/orders/adapters/wholesale-perfumes.ts"),
      "utf8",
    );
    const dryIdx = src.indexOf("if (dryRun)");
    const clearIdx = src.indexOf("await api.clearCart()");
    expect(dryIdx).toBeGreaterThan(-1);
    expect(clearIdx).toBeGreaterThan(dryIdx);
    expect(src).toContain("No DELETE/POST to the cart API");
    expect(src).toContain('lockName("wholesale-perfumes-cart")');
  });

  test("dispatch always consults resolveDispatchDryRun", () => {
    const src = readFileSync(join(import.meta.dir, "../src/orders/dispatch.ts"), "utf8");
    expect(src).toContain("resolveDispatchDryRun(options.dryRun ?? settings.ordersDryRun)");
  });

  test("compose wholesale services are behind the wholesale profile", () => {
    const compose = readFileSync(join(import.meta.dir, "../../compose.yaml"), "utf8");
    expect(compose).toContain("profiles: [\"wholesale\"]");
    expect(compose).toContain("container_name: wholesale-db");
    expect(compose).toContain("container_name: wholesale-ecom");
    expect(compose).toContain("container_name: wholesale-core");
    expect(compose).toContain("WORDPRESS_DB_HOST: wholesale-db");
    expect(compose).toContain("DB_HOST: wholesale-db");
    expect(compose).toContain("SILLAGE_PROFILE: wholesale");
    expect(compose).toContain("SILLAGE_LOCK_PREFIX: sillage-wholesale");
    expect(compose).toContain("WP_REDIS_PREFIX', 'wholesale:");
    expect(compose).not.toMatch(/container_name:\s*wpf-/);
    expect(compose).toContain("SILLAGE_STOREFRONT_PROFILE");
  });

  test("wholesale bootstrap writes WordPress rewrite htaccess so /shop/ works", () => {
    const boot = readFileSync(join(import.meta.dir, "../../scripts/bootstrap-wholesale.sh"), "utf8");
    const htaccess = readFileSync(
      join(import.meta.dir, "../../ecom_sites/config/wordpress.htaccess"),
      "utf8",
    );
    expect(boot).toContain("ecom_sites/config/wordpress.htaccess");
    expect(boot).toContain("wp-wholesale/.htaccess");
    expect(boot).toContain("show_on_front");
    expect(boot).toContain("woocommerce_coming_soon");
    expect(htaccess).toContain("RewriteEngine On");
    expect(htaccess).toContain("RewriteRule . /index.php [L]");
  });
});
