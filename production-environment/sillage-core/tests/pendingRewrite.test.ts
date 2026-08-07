import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("pending price rewrite on Save", () => {
  const pendingSrc = readFileSync(join(import.meta.dir, "../src/sync/pendingRewrite.ts"), "utf8");
  const apiSrc = readFileSync(join(import.meta.dir, "../src/server/routes/api.ts"), "utf8");
  const runSrc = readFileSync(join(import.meta.dir, "../src/sync/run.ts"), "utf8");

  test("exports kick + drain for settings/vendor Save", () => {
    expect(pendingSrc).toContain("export async function kickPriceRewrite");
    expect(pendingSrc).toContain("export async function kickContentRewrite");
    expect(pendingSrc).toContain("export async function drainPendingRewrites");
    expect(pendingSrc).toContain('rewriteOnly: true');
    expect(pendingSrc).toContain('source: "cache"');
  });

  test("runSync drains pending rewrites after releasing the lock", () => {
    expect(runSrc).toContain("drainPendingRewrites");
    expect(runSrc).toContain('await import("./pendingRewrite.ts")');
  });

  test("settings and vendor pricing Save kick rewrite-only", () => {
    expect(apiSrc).toContain("kickPriceRewrite");
    expect(apiSrc).toContain("kickContentRewrite");
    expect(apiSrc).toContain("patch.fxRate !== undefined");
    expect(apiSrc).toContain("patch.minVisibleStock !== undefined");
    expect(apiSrc).toContain("global_price_multiplier");
    expect(apiSrc).toContain("alreadyRunning");
  });
});
