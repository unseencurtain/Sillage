/**
 * Headed login helper.
 *
 * Opens Chromium at wholesale.brasty.com, waits for the operator to log in
 * manually, then persists Playwright storageState for reuse by every later run.
 * Never forces a re-login on subsequent commands — they load storageState.json.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { chromium } from "playwright";
import { loadConfig } from "./config.js";
import { Logger } from "./logger.js";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger(cfg.logPath);

  mkdirSync(dirname(cfg.storageStatePath), { recursive: true });

  log.info(`Opening headed Chromium → ${cfg.brastyBaseUrl}`);
  log.info("Log in manually in the browser window.");
  log.info(
    "When the wholesale UI is fully loaded (you can see products / search), return here and press Enter.",
  );

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(cfg.brastyBaseUrl, { waitUntil: "domcontentloaded" });

  await waitForEnter("Press Enter after successful login to save the session…");

  // Soft check: warn if a password field is still visible.
  const passwordVisible = await page
    .locator('input[type="password"]')
    .first()
    .isVisible()
    .catch(() => false);
  if (passwordVisible) {
    log.warn(
      "A password field is still visible — session may be incomplete. Saving anyway; re-run login if later commands fail.",
    );
  }

  await context.storageState({ path: cfg.storageStatePath });
  log.info(`Saved storageState → ${cfg.storageStatePath}`);
  log.info("Later runs reuse this file. If a run reports session expired, run: npm run login");

  await browser.close();
}

function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdout.write(`${prompt}\n`);
    const onData = (): void => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve();
    };
    process.stdin.on("data", onData);
  });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
