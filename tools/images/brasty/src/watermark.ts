/**
 * Composite the client's LPS logo onto downloaded images using sharp.
 * Writes to WATERMARKED_DIR — originals in OUTPUT_DIR are never modified.
 * If LOGO_PATH is empty / missing, no-ops with a clear message.
 */
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import sharp from "sharp";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";
import type { LogoPosition } from "./types.js";

const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

function positionOffsets(
  position: LogoPosition,
  canvasW: number,
  canvasH: number,
  logoW: number,
  logoH: number,
  margin: number,
): { left: number; top: number } {
  switch (position) {
    case "bottom-left":
      return { left: margin, top: canvasH - logoH - margin };
    case "top-right":
      return { left: canvasW - logoW - margin, top: margin };
    case "top-left":
      return { left: margin, top: margin };
    case "center":
      return {
        left: Math.max(0, Math.round((canvasW - logoW) / 2)),
        top: Math.max(0, Math.round((canvasH - logoH) / 2)),
      };
    case "bottom-right":
    default:
      return {
        left: canvasW - logoW - margin,
        top: canvasH - logoH - margin,
      };
  }
}

async function watermarkOne(
  inputPath: string,
  outputPath: string,
  logoPath: string,
  position: LogoPosition,
  scale: number,
  opacity: number,
): Promise<void> {
  const base = sharp(inputPath);
  const meta = await base.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) {
    throw new Error(`Cannot read dimensions: ${inputPath}`);
  }

  const targetW = Math.max(1, Math.round(width * scale));
  const logoBuf = await sharp(logoPath)
    .resize({ width: targetW, withoutEnlargement: true })
    .ensureAlpha()
    .modulate({ brightness: 1 })
    .toBuffer({ resolveWithObject: true });

  // Apply opacity via raw alpha multiply.
  const { data, info } = await sharp(logoBuf.data, {
    raw: {
      width: logoBuf.info.width,
      height: logoBuf.info.height,
      channels: logoBuf.info.channels,
    },
  })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const out = Buffer.from(data);
  for (let i = channels - 1; i < out.length; i += channels) {
    out[i] = Math.round((out[i] ?? 0) * opacity);
  }

  const logoW = info.width;
  const logoH = info.height;
  const margin = Math.max(8, Math.round(Math.min(width, height) * 0.02));
  const { left, top } = positionOffsets(
    position,
    width,
    height,
    logoW,
    logoH,
    margin,
  );

  await sharp(inputPath)
    .composite([
      {
        input: out,
        raw: { width: logoW, height: logoH, channels: 4 },
        left: Math.max(0, left),
        top: Math.max(0, top),
      },
    ])
    .jpeg({ quality: 92 })
    .toFile(outputPath);
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger(cfg.logPath);

  if (!cfg.logoPath) {
    log.info(
      "LOGO_PATH is empty — watermark step no-ops. Set LOGO_PATH in .env to enable LPS logo compositing.",
    );
    return;
  }
  if (!existsSync(cfg.logoPath)) {
    log.info(
      `Logo file not found at ${cfg.logoPath} — watermark step no-ops. Place the LPS logo there or update LOGO_PATH.`,
    );
    return;
  }
  if (!existsSync(cfg.outputDir)) {
    log.warn(`OUTPUT_DIR does not exist: ${cfg.outputDir}`);
    return;
  }

  mkdirSync(cfg.watermarkedDir, { recursive: true });
  const files = readdirSync(cfg.outputDir).filter((f) =>
    IMAGE_EXT.has(extname(f).toLowerCase()),
  );
  log.info(
    `Watermarking ${files.length} image(s) → ${cfg.watermarkedDir} (logo=${cfg.logoPath}, pos=${cfg.logoPosition}, scale=${cfg.logoScale}, opacity=${cfg.logoOpacity})`,
  );

  let ok = 0;
  let fail = 0;
  for (const file of files) {
    const src = join(cfg.outputDir, file);
    const dest = join(cfg.watermarkedDir, file.replace(/\.\w+$/i, ".jpg"));
    try {
      await watermarkOne(
        src,
        dest,
        cfg.logoPath,
        cfg.logoPosition,
        cfg.logoScale,
        cfg.logoOpacity,
      );
      ok += 1;
    } catch (err) {
      fail += 1;
      log.error(
        `${file}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  log.info(`Watermark done: ${ok} ok, ${fail} failed`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exitCode = 1;
});
