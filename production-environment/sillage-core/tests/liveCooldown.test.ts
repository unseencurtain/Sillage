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
  });

  test("POST /sync/run rejects live starts during cooldown", () => {
    expect(apiSrc).toContain("getRetailLiveCooldown");
    expect(apiSrc).toContain("cooldown: true");
    expect(apiSrc).toContain("retryInMinutes: cooldown.retryInMinutes");
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

  test("scheduler skips live ticks only when both vendors are cooling", () => {
    expect(scheduleSrc).toContain("getRetailLiveCooldown");
    expect(scheduleSrc).toContain("both vendors cooling");
    expect(scheduleSrc).toContain("anyAllow");
  });

  test("settings Save keeps cooldown and fast cadence in lockstep", () => {
    expect(apiSrc).toContain('key === "live_feed_min_minutes"');
    expect(apiSrc).toContain('await setSetting("fast_sync_minutes", persist)');
    expect(apiSrc).toContain('await setSetting("live_feed_min_minutes", persist)');
  });
});
