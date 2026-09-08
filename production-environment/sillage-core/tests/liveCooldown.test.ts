import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("retail live cooldown — no silent cache", () => {
  const liveGate = readFileSync(join(import.meta.dir, "../src/vendors/liveGate.ts"), "utf8");
  const apiSrc = readFileSync(join(import.meta.dir, "../src/server/routes/api.ts"), "utf8");
  const runSrc = readFileSync(join(import.meta.dir, "../src/sync/run.ts"), "utf8");
  const bfSrc = readFileSync(join(import.meta.dir, "../src/vendors/beautyfort/connector.ts"), "utf8");
  const btsSrc = readFileSync(join(import.meta.dir, "../src/vendors/bts/connector.ts"), "utf8");
  const scheduleSrc = readFileSync(join(import.meta.dir, "../src/sync/schedule.ts"), "utf8");

  test("resolveLiveOrCache returns blocked instead of cache fallback", () => {
    expect(liveGate).toContain('mode: "live" | "blocked" | "local"');
    expect(liveGate).toContain('return { mode: "blocked", gate }');
    expect(liveGate).toContain("export async function getRetailLiveCooldown");
    expect(liveGate).toContain("export async function getStorefrontLiveCooldown");
  });

  test("POST /sync/run rejects live starts during cooldown", () => {
    expect(apiSrc).toContain("getStorefrontLiveCooldown");
    expect(apiSrc).toContain("storefrontVendorSlugs");
    expect(apiSrc).toContain("cooldown: true");
    expect(apiSrc).toContain("retryInMinutes: cooldown.retryInMinutes");
    expect(apiSrc).not.toContain('v === "beautyfort" || v === "bts"');
  });

  test("live-status exposes countdown without cache age", () => {
    expect(apiSrc).toContain("cooldownMinutes: cooldown.cooldownMinutes");
    expect(apiSrc).toContain("dailyRemaining");
    expect(apiSrc).not.toContain("cacheAgeMinutes");
  });

  test("fast live path skips vendor when gate blocks — no disk fallback", () => {
    expect(runSrc).toContain("skipping live price/stock sync");
    expect(runSrc).toContain('options.source === "live" && vendor.slug !== "wholesale-perfumes"');
  });

  test("BF/BTS connectors throw when live is blocked", () => {
    expect(bfSrc).toContain('resolved.mode === "blocked"');
    expect(btsSrc).toContain('resolved.mode === "blocked"');
    expect(bfSrc).not.toContain("live gated");
    expect(btsSrc).not.toContain("live gated — cached");
  });

  test("scheduler skips live ticks only when the storefront is cooling", () => {
    expect(scheduleSrc).toContain("getStorefrontLiveCooldown");
    expect(scheduleSrc).toContain("storefront cooling");
    expect(scheduleSrc).toContain("anyAllow");
  });

  test("Vendors UI does not expose the retired daily download cap", () => {
    const vendorsSrc = readFileSync(join(import.meta.dir, "../web/src/pages/Vendors.tsx"), "utf8");
    expect(vendorsSrc).not.toContain("liveMaxPerDay");
    expect(vendorsSrc).not.toContain("Live downloads");
    expect(vendorsSrc).toContain("How often this vendor updates");
    expect(vendorsSrc).toContain("About once a day on the shop");
    expect(vendorsSrc).toContain("re-downloads their full stock file");
    expect(vendorsSrc).toContain("Daily full catalogue rebuild");
  });

  test("dashboard Sync/Overview do not pin BeautyFort+BTS vendors", () => {
    const overview = readFileSync(join(import.meta.dir, "../web/src/pages/Overview.tsx"), "utf8");
    const sync = readFileSync(join(import.meta.dir, "../web/src/pages/Sync.tsx"), "utf8");
    expect(overview).not.toContain('vendors: ["beautyfort", "bts"]');
    expect(sync).not.toContain('vendors: ["beautyfort", "bts"]');
    expect(overview).toContain('api.runSync("fast", { source: "live" })');
  });

  test("settings Save keeps cooldown and fast cadence in lockstep", () => {
    expect(apiSrc).toContain('key === "live_feed_min_minutes"');
    expect(apiSrc).toContain('await setSetting("fast_sync_minutes", persist)');
    expect(apiSrc).toContain('await setSetting("live_feed_min_minutes", persist)');
  });
});
