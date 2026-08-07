import { existsSync } from "node:fs";
import type { Browser, BrowserContext, Page } from "playwright";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";

export class SessionExpiredError extends Error {
  constructor(detail: string) {
    super(
      `Brasty session expired or invalid (${detail}). Will re-login automatically if credentials are set.`,
    );
    this.name = "SessionExpiredError";
  }
}

/**
 * Heuristics to detect a logged-out wholesale.brasty.com page.
 * Conservative: if we clearly see a login form / login URL, fail loud.
 * Positive markers must be things only an authenticated session shows.
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

/** Serialize headless re-login so concurrent workers do not race. */
let loginInFlight: Promise<void> | null = null;

async function refreshStorageState(
  browser: Browser,
  cfg: AppConfig,
  log: Logger,
): Promise<void> {
  if (!loginInFlight) {
    loginInFlight = (async () => {
      // Dynamic import avoids a static cycle with login.ts (which imports assertSessionValid).
      const { performHeadlessLogin } = await import("./login.js");
      await performHeadlessLogin(cfg, log, browser);
    })().finally(() => {
      loginInFlight = null;
    });
  }
  await loginInFlight;
}

/**
 * Load storageState, cheaply verify it is still authenticated, and transparently
 * re-run headless login when missing or expired. No caller should fail merely
 * because a session went stale — credentials must be in the environment.
 */
export async function ensureSession(
  browser: Browser,
  cfg: AppConfig,
  log: Logger,
): Promise<BrowserContext> {
  if (existsSync(cfg.storageStatePath)) {
    const context = await browser.newContext({
      storageState: cfg.storageStatePath,
    });
    const page = await context.newPage();
    try {
      await assertSessionValid(page, cfg.brastyBaseUrl);
      await page.close().catch(() => undefined);
      return context;
    } catch (err) {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      if (!(err instanceof SessionExpiredError)) throw err;
      log.warn(`${err.message} Re-running headless login…`);
    }
  } else {
    log.warn(
      `No storageState at ${cfg.storageStatePath}. Running headless login…`,
    );
  }

  await refreshStorageState(browser, cfg, log);

  if (!existsSync(cfg.storageStatePath)) {
    throw new SessionExpiredError(
      `login finished but storageState missing at ${cfg.storageStatePath}`,
    );
  }

  const context = await browser.newContext({
    storageState: cfg.storageStatePath,
  });
  const page = await context.newPage();
  try {
    await assertSessionValid(page, cfg.brastyBaseUrl);
  } catch (err) {
    await context.close().catch(() => undefined);
    throw err;
  } finally {
    await page.close().catch(() => undefined);
  }
  return context;
}

/** @deprecated Prefer ensureSession() — kept for call sites that already hold a fresh state. */
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
