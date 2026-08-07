import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guardrail: rewrite-only used to pass empty categoryMaps / brand maps into the writer,
 * which deletes every product_cat and brand relationship on a full rewrite.
 * Decision 29 — maps must be reloaded from sil_category_map / sil_term_map.
 */
describe("rewrite-only taxonomy safety", () => {
  const runSrc = readFileSync(join(import.meta.dir, "../src/sync/run.ts"), "utf8");
  const taxonomySrc = readFileSync(join(import.meta.dir, "../src/sync/taxonomy.ts"), "utf8");

  test("exports loaders used to rebuild maps without a feed fetch", () => {
    expect(taxonomySrc).toContain("export async function loadCategoryMapsFromDb");
    expect(taxonomySrc).toContain("export async function loadFlatTermMapFromDb");
    expect(taxonomySrc).toContain("sil_category_map");
    expect(taxonomySrc).toContain("sil_term_map");
  });

  test("rewriteOnly path rebuilds write context from DB maps", () => {
    expect(runSrc).toContain("if (options.rewriteOnly)");
    expect(runSrc).toContain("buildRewriteWriteContext");
    expect(runSrc).toContain("loadCategoryMapsFromDb");
    expect(runSrc).toContain("loadFlatTermMapFromDb");
    expect(runSrc).toContain("ensureVendorShopCategories");
  });

  test("rewrite-only does not construct empty categoryMaps inline", () => {
    const rewriteBlock = runSrc.match(
      /if \(options\.rewriteOnly\) \{[\s\S]*?return summary;\n\s*\}/,
    );
    expect(rewriteBlock).not.toBeNull();
    expect(rewriteBlock![0]).not.toContain("new Map<number, Map<string, TermRef>>()");
    expect(rewriteBlock![0]).toContain("buildRewriteWriteContext");
  });
});
