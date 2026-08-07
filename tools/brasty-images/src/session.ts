import { existsSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright";
import type { AppConfig } from "./config.js";

export class SessionExpiredError extends Error {
  constructor(detail: string) {
    super(
      `Brasty session expired or invalid (${detail}). Run: npm run login again`,
    );
    this.name = "SessionExpiredError";
  }
}

/**
 * Heuristics to detect a logged-out wholesale.brasty.com page.
 * Conservative: if we clearly see a login form / login URL, fail loud.
 * Exact authenticated markers are refined after investigation.
 */
export async function assertSessionValid(page: Page, baseUrl: string): Promise<void> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {
    /* networkidle can hang on long-polling; DOM ready is enough for auth check */
  });

  const url = page.url().toLowerCase();
  if (
    url.includes("login") ||
    url.includes("signin") ||
    url.includes("sign-in") ||
    url.includes("auth")
  ) {
    throw new SessionExpiredError(`redirected to ${page.url()}`);
  }

  const loginForm = page.locator(
    'form[action*="login"], form[action*="signin"], input[type="password"], input[name="password"]',
  );
  const passwordVisible = await loginForm
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (passwordVisible) {
    throw new SessionExpiredError("login form visible on landing page");
  }

  // Soft positive signal: any of these suggest an authenticated shell.
  const authHints = page.locator(
    [
      'a[href*="logout"]',
      'a[href*="log-out"]',
      'button:has-text("Log out")',
      'button:has-text("Logout")',
      'a:has-text("Log out")',
      'a:has-text("Logout")',
      '[class*="product"]',
      'input[type="search"]',
      'input[name*="search" i]',
      'input[placeholder*="search" i]',
      'input[placeholder*="EAN" i]',
    ].join(", "),
  );
  const hintCount = await authHints.count();
  if (hintCount === 0) {
    throw new SessionExpiredError(
      "no authenticated UI markers found — page may be logged out or structure changed",
    );
  }
}

export async function openAuthenticatedContext(
  browser: Browser,
  cfg: AppConfig,
): Promise<BrowserContext> {
  if (!existsSync(cfg.storageStatePath)) {
    throw new SessionExpiredError(`missing storageState at ${cfg.storageStatePath}`);
  }

  const context = await browser.newContext({
    storageState: cfg.storageStatePath,
  });
  const page = await context.newPage();
  try {
    await assertSessionValid(page, cfg.brastyBaseUrl);
  } catch (err) {
    await context.close();
    throw err;
  } finally {
    await page.close().catch(() => undefined);
  }
  return context;
}
