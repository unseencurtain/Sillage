/**
 * Headless, credential-driven login.
 *
 * Reads BRASTY_EMAIL / BRASTY_PASSWORD from the environment, dismisses the
 * cookie-consent overlay, discovers the login form at runtime, submits, then
 * verifies an authenticated session and saves Playwright storageState.
 * Works with no X server (headless Chromium).
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright";
import {
  assertBrastyCredentials,
  loadConfig,
  redactSecrets,
  type AppConfig,
} from "./config.js";
import { Logger } from "./logger.js";
import { assertSessionValid } from "./session.js";

export type LoginFailureKind =
  | "missing_credentials"
  | "network"
  | "unexpected_markup"
  | "wrong_credentials"
  | "account_not_approved"
  | "cookie_consent"
  | "auth_check_failed";

export class LoginError extends Error {
  readonly kind: LoginFailureKind;

  constructor(kind: LoginFailureKind, message: string) {
    super(message);
    this.name = "LoginError";
    this.kind = kind;
  }
}

/** Cookie-banner buttons — prefer reject (technical cookies stay active). */
const REJECT_CONSENT_RE =
  /reject\s*all|reject\s*non[- ]essential|only\s*necessary|necessary\s*only|decline|deny/i;
const ACCEPT_CONSENT_RE =
  /accept\s*everything|accept\s*all|allow\s*all|i\s*agree|agree\s*and\s*continue/i;
const CONSENT_ROOT_RE =
  /for the website to work as it should|cookie|consent|privacy/i;

/**
 * Dismiss the cookie-consent overlay before any other interaction.
 * Prefer the privacy-preserving option; fall back to accept if reject is absent
 * or the banner remains after reject. Consent cookies land in storageState.
 */
export async function dismissCookieConsent(
  page: Page,
  log?: Logger,
): Promise<"rejected" | "accepted" | "absent"> {
  const banner = page
    .locator(
      [
        "#CybotCookiebotDialog",
        "#cookiescript_injected",
        '[id*="cookie" i]',
        '[class*="cookie" i]',
        '[id*="consent" i]',
        '[class*="consent" i]',
        '[role="dialog"]',
        'aside:has-text("cookie")',
        'div:has-text("For the website to work as it should")',
      ].join(", "),
    )
    .filter({ hasText: CONSENT_ROOT_RE })
    .first();

  const visible = await banner.isVisible({ timeout: 4_000 }).catch(() => false);
  if (!visible) {
    // Also try bare text match in case the banner is outside those shells.
    const textHit = page.getByText(/For the website to work as it should/i).first();
    const textVisible = await textHit.isVisible({ timeout: 1_000 }).catch(() => false);
    if (!textVisible) return "absent";
  }

  const tryClick = async (re: RegExp): Promise<boolean> => {
    const btn = page
      .locator("button, a, [role='button'], input[type='button'], input[type='submit']")
      .filter({ hasText: re })
      .first();
    const ok = await btn.isVisible({ timeout: 1_500 }).catch(() => false);
    if (!ok) return false;
    await btn.click({ timeout: 5_000 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    return true;
  };

  if (await tryClick(REJECT_CONSENT_RE)) {
    const still = await page
      .getByText(/For the website to work as it should/i)
      .first()
      .isVisible({ timeout: 1_500 })
      .catch(() => false);
    if (!still) {
      log?.info("Cookie consent: rejected non-essential (technical cookies remain).");
      return "rejected";
    }
    log?.warn(
      "Cookie consent: Reject all clicked but banner still visible — falling back to Accept everything.",
    );
  }

  if (await tryClick(ACCEPT_CONSENT_RE)) {
    const still = await page
      .getByText(/For the website to work as it should/i)
      .first()
      .isVisible({ timeout: 1_500 })
      .catch(() => false);
    if (!still) {
      log?.info("Cookie consent: accepted (reject was unavailable or ineffective).");
      return "accepted";
    }
  }

  throw new LoginError(
    "cookie_consent",
    'Cookie-consent banner is blocking interaction ("For the website to work as it should") ' +
      "but neither Reject all nor Accept everything could be clicked. Markup may have changed.",
  );
}

interface LoginFormFields {
  form: Locator;
  email: Locator;
  password: Locator;
  submit: Locator;
  formUrl: string;
}

/**
 * Locate the real login form after opening the header "Log in" entry point.
 * Discovers selectors at runtime — does not hardcode a guessed form URL.
 */
async function discoverLoginForm(page: Page, baseUrl: string): Promise<LoginFormFields> {
  // Prefer header/nav "Log in" so we do not hit footer/legal lookalikes.
  const loginTriggers = [
    page.locator("header a, header button, nav a, nav button").filter({ hasText: /^log\s*in$/i }),
    page.getByRole("link", { name: /^log\s*in$/i }),
    page.getByRole("button", { name: /^log\s*in$/i }),
    page.locator('a[href*="login" i], a[href*="sign-in" i], a[href*="signin" i]'),
  ];

  let clicked = false;
  for (const loc of loginTriggers) {
    const first = loc.first();
    const vis = await first.isVisible({ timeout: 2_000 }).catch(() => false);
    if (!vis) continue;
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => undefined),
      first.click({ timeout: 5_000 }),
    ]).catch(() => undefined);
    clicked = true;
    break;
  }

  if (!clicked) {
    throw new LoginError(
      "unexpected_markup",
      `Could not find a header "Log in" control on ${baseUrl}. ` +
        "Page markup may have changed, or the cookie banner still covers it.",
    );
  }

  // Wait for a password field to appear (navigation or overlay).
  const password = page.locator('input[type="password"]').first();
  const appeared = await password
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    throw new LoginError(
      "unexpected_markup",
      "Clicked Log in but no password field appeared. Expected login form fields are absent.",
    );
  }

  const form = password.locator("xpath=ancestor::form[1]");
  const formCount = await form.count();
  const scope = formCount > 0 ? form : page;

  const emailCandidates = [
    scope.locator('input[type="email"]'),
    scope.locator('input[name*="email" i]'),
    scope.locator('input[id*="email" i]'),
    scope.locator('input[autocomplete="username"]'),
    scope.locator('input[name*="user" i]:not([type="hidden"])'),
    scope.locator('input[type="text"]').first(),
  ];

  let email: Locator | null = null;
  for (const c of emailCandidates) {
    const first = c.first();
    if (await first.isVisible({ timeout: 500 }).catch(() => false)) {
      email = first;
      break;
    }
  }

  if (!email) {
    throw new LoginError(
      "unexpected_markup",
      "Login form is missing an email/username field. Cannot continue.",
    );
  }

  const submitCandidates = [
    scope.locator('button[type="submit"]'),
    scope.locator('input[type="submit"]'),
    scope.getByRole("button", { name: /log\s*in|sign\s*in|submit|continue/i }),
    scope.locator("button").filter({ hasText: /log\s*in|sign\s*in/i }),
  ];

  let submit: Locator | null = null;
  for (const c of submitCandidates) {
    const first = c.first();
    if (await first.isVisible({ timeout: 500 }).catch(() => false)) {
      submit = first;
      break;
    }
  }

  if (!submit) {
    throw new LoginError(
      "unexpected_markup",
      "Login form is missing a submit control. Cannot continue.",
    );
  }

  return {
    form: formCount > 0 ? form : page.locator("body"),
    email,
    password,
    submit,
    formUrl: page.url(),
  };
}

async function fillHiddenTokens(form: Locator, page: Page): Promise<number> {
  // CSRF / authenticity tokens are typically already in the DOM as hidden inputs.
  // Playwright's form fill leaves them alone; we only verify they exist when present
  // so a missing token surface is diagnosable. No values are logged.
  const scope = form;
  const hiddens = scope.locator(
    'input[type="hidden"][name*="csrf" i], input[type="hidden"][name*="token" i], ' +
      'input[type="hidden"][name="_token"], input[type="hidden"][name="authenticity_token"]',
  );
  const n = await hiddens.count().catch(() => 0);
  // Touch the form so any client-side token refresh has a chance to run.
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  return n;
}

async function classifyLoginFailure(page: Page): Promise<LoginError> {
  const bodyText = (await page.locator("body").innerText().catch(() => "")).toLowerCase();
  const url = page.url().toLowerCase();

  if (
    /not\s*approved|pending\s*approval|awaiting\s*approval|account\s*inactive|not\s*activated|waiting\s*for\s*activation/.test(
      bodyText,
    )
  ) {
    return new LoginError(
      "account_not_approved",
      "Login rejected: wholesale account appears not approved / inactive. " +
        "Ask Brasty to activate the account, then retry.",
    );
  }

  if (
    /invalid\s*(email|password|credentials)|wrong\s*password|incorrect\s*(email|password)|authentication\s*failed|login\s*failed|bad\s*credentials|nieprawidłow|błędn/.test(
      bodyText,
    ) ||
    (url.includes("login") &&
      (await page.locator('input[type="password"]').first().isVisible().catch(() => false)))
  ) {
    return new LoginError(
      "wrong_credentials",
      "Login failed: wrong credentials (or the form rejected the submission). " +
        "Check BRASTY_EMAIL / BRASTY_PASSWORD — the password is never logged.",
    );
  }

  return new LoginError(
    "auth_check_failed",
    `Login submitted but authenticated UI was not detected (url=${page.url()}). ` +
      "Credentials may be wrong, the account may be unapproved, or markup changed.",
  );
}

/**
 * Perform a full headless login and persist storageState (including consent cookies).
 * Safe to call from the CLI or from ensureSession() when a session has expired.
 */
export async function performHeadlessLogin(
  cfg: AppConfig,
  log: Logger,
  browser?: Browser,
): Promise<void> {
  try {
    assertBrastyCredentials(cfg);
  } catch (err) {
    throw new LoginError(
      "missing_credentials",
      err instanceof Error ? err.message : String(err),
    );
  }

  mkdirSync(dirname(cfg.storageStatePath), { recursive: true });

  const ownsBrowser = !browser;
  const b =
    browser ??
    (await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage"],
    }));

  let context: BrowserContext | null = null;
  try {
    context = await b.newContext();
    const page = await context.newPage();

    log.info(`Headless login → ${cfg.brastyBaseUrl}`);
    try {
      await page.goto(cfg.brastyBaseUrl, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new LoginError(
        "network",
        `Network error loading ${cfg.brastyBaseUrl}: ${redactSecrets(msg, cfg.brastyPassword)}`,
      );
    }

    await dismissCookieConsent(page, log);

    const fields = await discoverLoginForm(page, cfg.brastyBaseUrl);
    log.info(`Login form discovered at ${fields.formUrl}`);

    const tokenCount = await fillHiddenTokens(fields.form, page);
    if (tokenCount > 0) {
      log.info(`Login form has ${tokenCount} CSRF/hidden token field(s) (left intact).`);
    }

    await fields.email.fill(cfg.brastyEmail);
    await fields.password.fill(cfg.brastyPassword);

    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => undefined),
      fields.submit.click({ timeout: 10_000 }),
    ]).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      throw new LoginError(
        "network",
        `Network/error submitting login form: ${redactSecrets(msg, cfg.brastyPassword)}`,
      );
    });

    // Give the wholesale shell a moment to render after auth.
    await page
      .waitForLoadState("networkidle", { timeout: 15_000 })
      .catch(() => undefined);

    try {
      await assertSessionValid(page, cfg.brastyBaseUrl);
    } catch {
      throw await classifyLoginFailure(page);
    }

    await context.storageState({ path: cfg.storageStatePath });
    log.info(`Saved storageState → ${cfg.storageStatePath}`);
  } finally {
    if (context) await context.close().catch(() => undefined);
    if (ownsBrowser) await b.close().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const log = new Logger(cfg.logPath);

  try {
    await performHeadlessLogin(cfg, log);
    log.info(
      "Session ready. investigate / download will reuse storageState and re-login automatically if it expires.",
    );
  } catch (err) {
    if (err instanceof LoginError) {
      log.error(`[${err.kind}] ${redactSecrets(err.message, cfg.brastyPassword)}`);
      process.exitCode = 1;
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    log.error(redactSecrets(msg, cfg.brastyPassword));
    process.exitCode = 1;
  }
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entry) {
  main();
}
