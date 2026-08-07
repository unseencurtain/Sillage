/**
 * Download the original image bytes over HTTP(S). Never screenshots / crops.
 */
import { createWriteStream, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { Logger } from "./logger.js";

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly kind: "network_timeout" | "http_error" | "io_error",
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

export interface DownloadOptions {
  url: string;
  destPath: string;
  retryCount: number;
  retryBackoffMs: number;
  timeoutMs?: number;
  log?: Logger;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function downloadImage(opts: DownloadOptions): Promise<void> {
  const { url, destPath, retryCount, retryBackoffMs, log } = opts;
  const timeoutMs = opts.timeoutMs ?? 60_000;
  mkdirSync(dirname(destPath), { recursive: true });

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    const tmp = `${destPath}.partial`;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(url, {
          signal: controller.signal,
          headers: {
            Accept: "image/*,*/*",
            "User-Agent": "brasty-images/0.1 (Sillage operator tool)",
          },
          redirect: "follow",
        });
      } finally {
        clearTimeout(timer);
      }

      if (!res.ok) {
        throw new DownloadError(
          `HTTP ${res.status} for ${url}`,
          "http_error",
        );
      }
      if (!res.body) {
        throw new DownloadError(`Empty body for ${url}`, "http_error");
      }

      const nodeStream = Readable.fromWeb(res.body as import("stream/web").ReadableStream);
      await pipeline(nodeStream, createWriteStream(tmp));
      renameSync(tmp, destPath);
      return;
    } catch (err) {
      lastErr = err;
      try {
        unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || /aborted|timeout/i.test(err.message));
      const kind = isAbort ? "network_timeout" : "http_error";
      const wrapped =
        err instanceof DownloadError
          ? err
          : new DownloadError(
              err instanceof Error ? err.message : String(err),
              isAbort ? "network_timeout" : "io_error",
            );

      if (attempt < retryCount) {
        const delay = retryBackoffMs * 2 ** attempt;
        log?.warn(
          `download retry ${attempt + 1}/${retryCount} after ${delay}ms (${kind}): ${wrapped.message}`,
        );
        await sleep(delay);
        continue;
      }
      throw wrapped;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Choose a non-colliding output filename for an EAN.
 * First: EAN.jpg; duplicates: EAN-1.jpg, EAN-2.jpg, …
 */
export function allocateOutputPath(
  outputDir: string,
  ean: string,
  existingPaths: Set<string>,
): string {
  const base = `${ean}.jpg`;
  let candidate = `${outputDir}/${base}`.replace(/\\/g, "/");
  if (!existingPaths.has(candidate) && !existingPaths.has(normalize(candidate))) {
    return candidate;
  }
  let i = 1;
  for (;;) {
    candidate = `${outputDir}/${ean}-${i}.jpg`.replace(/\\/g, "/");
    if (!existingPaths.has(candidate) && !existingPaths.has(normalize(candidate))) {
      return candidate;
    }
    i += 1;
  }
}

function normalize(p: string): string {
  return p.replace(/\\/g, "/");
}
