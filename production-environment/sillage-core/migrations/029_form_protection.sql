-- Storefront form protection settings.
--
-- No schema change: the honeypot, the per-IP rate limit, the spam filter and the time-trap all live
-- in the code and need no row. What is added here is only the row the operator edits — the public
-- Cloudflare Turnstile site key the storefront renders the widget with. Its matching *secret* is a
-- Secrets-page value (TURNSTILE_SECRET), because that one must never reach a browser.
--
-- An empty site key means the widget is not shown; an empty secret means no challenge is asked for.
-- Setting both turns Turnstile on.
INSERT IGNORE INTO sil_settings (setting_key, setting_value) VALUES
  ('contact_turnstile_site_key', '');
