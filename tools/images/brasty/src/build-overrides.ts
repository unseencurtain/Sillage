/**
 * Turn an image output directory into an EAN → public URL map and MERGE it
 * into production-environment/sillage-core/data/image_overrides.json.
 *
 * Never clobber existing entries (BeautyFort / wholesale-perfumes enricher owns many keys).
 * Backs up the target file before writing.
 *
 * This is the only allowed write outside tools/images/brasty/, and only at
 * runtime — do not hand-edit image_overrides.json from this package's scaffold.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/** Prefer watermarked/ when it has files; otherwise output/. */
function resolveSourceDir(outputDir: string, watermarkedDir: string): string {
  if (existsSync(watermarkedDir)) {
    const n = readdirSync(watermarkedDir).filter((f) =>
      IMAGE_EXT.has(extname(f).toLowerCase()),
    ).length;
    if (n > 0) return watermarkedDir;
  }
  return outputDir;
}

/** Filename stems like 4011700747597.jpg or 4011700747597-2.jpg → EAN key. */
function eanFromFilename(file: string): string | null {
  const stem = basename(file, extname(file));
  const m = /^(\d{8,14})(?:-\d+)?$/.exec(stem);
  return m?.[1] ?? null;
}

function normalizeEan(raw: string): string | null {
  const cleaned = raw.trim().replace(/^'+/, "");
  if (!cleaned || cleaned === "0000000000000" || !/^\d+$/.test(cleaned)) {
    return null;
  }
  return cleaned.replace(/^0+/, "") || null;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger(cfg.logPath);

  const sourceDir = resolveSourceDir(cfg.outputDir, cfg.watermarkedDir);
  if (!existsSync(sourceDir)) {
    throw new Error(`Source image directory missing: ${sourceDir}`);
  }

  const files = readdirSync(sourceDir)
    .filter((f) => IMAGE_EXT.has(extname(f).toLowerCase()))
    .sort();
  const additions = new Map<string, string>();
  for (const file of files) {
    const eanRaw = eanFromFilename(file);
    if (!eanRaw) {
      log.warn(`skip non-EAN filename: ${file}`);
      continue;
    }
    const ean = normalizeEan(eanRaw);
    if (!ean) continue;
    // First file wins for a given EAN (EAN.jpg before EAN-1.jpg thanks to sort).
    if (additions.has(ean)) continue;
    const url = `${cfg.publicUrlBase}/${file}`;
    additions.set(ean, url);
  }

  log.info(
    `Built ${additions.size} URL(s) from ${sourceDir} (base=${cfg.publicUrlBase})`,
  );

  const target = cfg.imageOverridesPath;
  mkdirSync(dirname(target), { recursive: true });

  let existing: Record<string, string> = {};
  if (existsSync(target)) {
    const raw = readFileSync(target, "utf8");
    existing = JSON.parse(raw) as Record<string, string>;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${target}.bak-${stamp}`;
    copyFileSync(target, backup);
    log.info(`Backed up existing overrides → ${backup}`);
  } else {
    log.warn(`Target did not exist; will create: ${target}`);
  }

  let added = 0;
  let skipped = 0;
  const merged: Record<string, string> = { ...existing };
  for (const [ean, url] of additions) {
    if (merged[ean]) {
      skipped += 1;
      continue;
    }
    merged[ean] = url;
    added += 1;
  }

  // Stable key order for readable diffs.
  const ordered: Record<string, string> = {};
  for (const key of Object.keys(merged).sort()) {
    ordered[key] = merged[key]!;
  }

  writeFileSync(target, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
  log.info(
    `Merged into ${target}: +${added} new, ${skipped} skipped (existing keys preserved), total ${Object.keys(ordered).length}`,
  );
  log.info(
    "Reminder: run a fast/rewrite sync in sillage-core so the storefront picks up the new override URLs.",
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
