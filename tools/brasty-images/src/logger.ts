import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { LogCategory } from "./types.js";

const CATEGORIES: LogCategory[] = [
  "downloaded",
  "already_exists",
  "missing_image",
  "search_failed",
  "hover_failed",
  "network_timeout",
  "unexpected_page_structure",
];

export class Logger {
  private readonly counts = new Map<LogCategory, number>();
  private readonly logPath: string | null;

  constructor(logPath: string | null = null) {
    this.logPath = logPath;
    for (const c of CATEGORIES) this.counts.set(c, 0);
    if (logPath) {
      mkdirSync(dirname(logPath), { recursive: true });
    }
  }

  info(message: string): void {
    this.write("INFO", message);
  }

  warn(message: string): void {
    this.write("WARN", message);
  }

  error(message: string): void {
    this.write("ERROR", message);
  }

  /** Record a categorised outcome and increment the end-of-run counter. */
  category(cat: LogCategory, message: string, extra?: Record<string, unknown>): void {
    this.counts.set(cat, (this.counts.get(cat) ?? 0) + 1);
    const suffix = extra ? ` ${JSON.stringify(extra)}` : "";
    this.write("CAT", `[${cat}] ${message}${suffix}`);
  }

  summary(): Record<LogCategory, number> {
    const out = {} as Record<LogCategory, number>;
    for (const c of CATEGORIES) out[c] = this.counts.get(c) ?? 0;
    return out;
  }

  printSummary(): void {
    const s = this.summary();
    this.info("── end-of-run summary ──");
    for (const c of CATEGORIES) {
      this.info(`  ${c}: ${s[c]}`);
    }
  }

  private write(level: string, message: string): void {
    const line = `${new Date().toISOString()} ${level} ${message}`;
    if (level === "ERROR") console.error(line);
    else if (level === "WARN") console.warn(line);
    else console.log(line);
    if (this.logPath) {
      appendFileSync(this.logPath, `${line}\n`, "utf8");
    }
  }
}
