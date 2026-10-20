/**
 * Who holds the WordPress session cookie on a storefront request.
 *
 * The engine cannot verify a WP auth cookie on its own (it lacks the salts), so it forwards the
 * cookie to the store's own session route — the same one the storefront uses — over the internal
 * URL. A guest, a timeout or an error all read as guest: the caller decides whether that matters.
 * A signed-in claim is never taken from the browser.
 *
 * Shared by the public forms (`routes/forms.ts`) and the product reviews (`routes/reviews.ts`).
 */
import type { Context } from "hono";
import { env } from "../config/env.ts";
import { logger } from "../lib/log.ts";

const log = logger("session");

/** The storefront's session-read route (mu-plugin `cereve-storefront-auth`). 401 means guest. */
const SESSION_PATH = "/wp-json/wc/store/v1/customer";

export interface Session {
  signedIn: boolean;
  customerId: number | null;
  email: string;
  name: string;
}

export const GUEST: Session = { signedIn: false, customerId: null, email: "", name: "" };

export async function sessionFor(c: Context): Promise<Session> {
  const cookie = c.req.header("cookie");
  const base = env.wordpress.internalUrl || env.wordpress.baseUrl;
  if (!cookie || !base) return GUEST;

  try {
    const response = await fetch(`${base}${SESSION_PATH}`, {
      headers: { Cookie: cookie, Accept: "application/json" },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return GUEST;

    const data = (await response.json()) as Record<string, unknown>;
    const id = Number(data?.id) || 0;
    if (!id) return GUEST;

    const name =
      [data.first_name, data.last_name].map((part) => String(part ?? "").trim()).filter(Boolean).join(" ") ||
      String(data.display_name ?? "").trim();

    return { signedIn: true, customerId: id, email: String(data.email ?? "").trim(), name };
  } catch (err) {
    // Deliberately does not include the cookie.
    log.warn("session probe failed; treating submitter as guest", String(err));
    return GUEST;
  }
}
