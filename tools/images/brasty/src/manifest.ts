/**
 * Append-only JSONL manifest keyed by EAN for resumability.
 * An interrupted run reloads successful EANs and skips re-download.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ManifestEntry, ManifestStatus } from "./types.js";

const SUCCESS: ManifestStatus[] = ["downloaded", "already_exists"];

export class Manifest {
  private readonly path: string;
  /** Latest status per EAN (last write wins when reading). */
  private readonly byEan = new Map<string, ManifestEntry>();

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.reload();
  }

  reload(): void {
    this.byEan.clear();
    if (!existsSync(this.path)) return;
    const text = readFileSync(this.path, "utf8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as ManifestEntry;
        if (entry?.ean) this.byEan.set(entry.ean, entry);
      } catch {
        // skip corrupt lines
      }
    }
  }

  get(ean: string): ManifestEntry | undefined {
    return this.byEan.get(ean);
  }

  /** True if this EAN already finished successfully in a prior run. */
  isDone(ean: string): boolean {
    const e = this.byEan.get(ean);
    return Boolean(e && SUCCESS.includes(e.status));
  }

  /** All output paths already claimed (for duplicate EAN filename allocation). */
  claimedPaths(): Set<string> {
    const set = new Set<string>();
    for (const e of this.byEan.values()) {
      if (e.outputPath) set.add(e.outputPath.replace(/\\/g, "/"));
    }
    return set;
  }

  append(entry: Omit<ManifestEntry, "at"> & { at?: string }): void {
    const full: ManifestEntry = {
      ...entry,
      at: entry.at ?? new Date().toISOString(),
    };
    appendFileSync(this.path, `${JSON.stringify(full)}\n`, "utf8");
    this.byEan.set(full.ean, full);
  }
}
