# S5 — Customer emails in the shopper's language

**Status: NOT BUILT — parked.** Written 2026-10-19, after a read-only survey of the live box
(WooCommerce 11.2.1 on `prinscosmetic.eu`). **No code for this exists yet and none of it is
deployed.** It is parked deliberately: it is a real project, not a switch, and it belongs to the
client's quote conversation — the multilingual WordPress plugins that would normally own this
(WPML, Polylang, TranslatePress) either don't touch WooCommerce transactional emails or charge for
the privilege. Do not start it as a favour; price it first.

Everything below is verified against the box on 2026-10-19, so whoever picks this up can skip the
survey. Read [`../CODEBASE-STATE.md`](../CODEBASE-STATE.md) first for the surrounding system.

## Goal

A shopper who checks out to a German address gets their **order-received, processing, completed,
on-hold, refunded, failed, cancelled and customer-note** emails in German — subject, heading, body,
button labels, totals. Same for the shop's own **tracking email** and the **two-parcel notice**.
Today every one of those is English for everyone.

Out of scope on purpose: product names and descriptions (inventory, never translated — the same rule
as the storefront), the engine's operator-facing form notifications (internal, English), Stripe's own
payment receipt (Stripe's account setting), and the WordPress admin.

## Why it is not a small change

Three separate problems, and the middle one is the reason the obvious snippets don't work:

1. **Nothing is remembered per order.** The order knows its country but not its language.
2. **WooCommerce 11 has no `woocommerce_email_locale` filter** (the widely-copied
   `determine_locale` / `woocommerce_email_locale` recipe is for an older WC, or for WooCommerce
   Multilingual, which is a paid product). Its locale handling is `WC_Email::setup_locale()` →
   `wc_switch_to_site_locale()` → `switch_to_locale( get_locale() )`, called as the **first
   statement** of every core customer email's `trigger()` — *before* the order is loaded, so the
   filters that do receive the `$email` object cannot see which order is being emailed.
3. **There are no language packs on the box at all.** `wp-content/languages/` is empty,
   `get_available_languages()` returns nothing, and WooCommerce ships no `.mo` of its own. Even a
   perfect locale switch would produce an English email with a German date format.

## Verified environment (2026-10-19, read-only)

| Fact | Value |
|---|---|
| WooCommerce / WordPress | 11.2.1 / 7.1.3 |
| Site locale | `en_US`, `WPLANG` empty |
| Language packs installed | **none** (`wp-content/languages/` empty; `plugins/*.mo` absent) |
| i18n plugin (WPML / Polylang / TranslatePress) | **none active** |
| Translation API reachable from the container | **yes** — 134 languages offered |
| Customer emails enabled | 15 (new-order/admin set + received, processing, completed, on-hold, refunded, cancelled, failed, customer-note, reset-password, new-account, verify-email; invoice off) |
| Order creation path | Store API `POST /wp-json/wc/store/v1/checkout` (cash path and the Stripe path both), no language signal in the body or headers |
| Locale switcher in WC core | `WC_Email::setup_locale()`, `wc_switch_to_site_locale()`, `wc_restore_locale()` in `includes/wc-core-functions.php:2193+` |
| Filter gates that exist | `woocommerce_allow_switching_email_locale` (`$email`), `woocommerce_email_setup_locale` (bool), `woocommerce_allow_restoring_email_locale` (`$email`), `woocommerce_email_restore_locale` (bool) |
| Filter that does **not** exist | `woocommerce_email_locale` — absent from `includes/` and `src/` |
| Email dispatch choke point | `WC_Emails::send_transactional_email()` fires `current_filter() . '_notification'`; each email class hooks `{status}_notification` at priority 10 |
| Deferred queue | `DeferredEmailQueue.php` present (Action Scheduler); check whether the `deferred_transactional_emails` feature is on before implementing |
| Our own email copy | `__()` with textdomains `sillage-tracking` (~13 strings) and `sillage-warehouses` (1); **no `.mo` files exist** |
| Frontend signal available | `activeLanguage()` (`src/shared/lib/format.js`) and the country→language rule in `src/shared/i18n/countryLanguages.js`; `buildHeaders()` sends no language today |
| Precedent already shipped | `MessageForms.jsx` posts `locale: activeLanguage(i18n)` to the engine, which stores it (`sil_contact_messages.locale`) |

## The design (three layers)

### 1. Remember the shopper's language on the order

Store it as order meta, **not** in a session: emails fire minutes or days later, off a status change,
from cron, from the dashboard, or from the deferred queue.

- The frontend sends it — one line in `buildHeaders()` in `react_store/frontend/src/shared/lib/woo.js`,
  e.g. `X-Sillage-Language: activeLanguage()` (the header rides the Store API checkout with the
  cart token and nonce, and does not disturb CORS since it is same-origin).
- The MU side reads it at order creation. The Store API fires
  `woocommerce_store_api_checkout_update_order_from_request` (available in 11.2.1; the box already
  reports a listener on it) — read the header there and write `_sillage_language`.
- **Fallback for everything that never got a header** (legacy orders, dashboard/phone orders, a
  future checkout path): derive the language from the order's shipping/billing **country** using the
  same map the storefront uses, mirrored into PHP. That is the shop's own rule anyway — the language
  *is* the delivery country's — so the fallback is consistent, not a guess.

Canonical value: a storefront primary code (`de`, `fr`, `nl`, …) — the same vocabulary as
`src/locales/*.json`, so the serverside map only has to translate codes, not names.

### 2. Switch the locale for that order's emails

Because `setup_locale()` runs before the order exists, hook the **dispatch**, not the email object:

```php
// WC_Emails::send_transactional_email() fires "{action}_notification" with the order args,
// and each email class hooks that same action at priority 10.
foreach ( (array) apply_filters( 'woocommerce_email_actions', array() ) as $action ) {
    add_action( $action . '_notification', 'sillage_emails_begin_locale', 1, 10 );  // read order, switch
    add_action( $action . '_notification', 'sillage_emails_end_locale',  20, 10 );  // restore
}
```

`sillage_emails_begin_locale()` takes the order from the args, resolves `_sillage_language` (then
country), and `switch_to_locale()`s; priority 20 pops it after the send. Guard rails:

- Only for customer emails (`is_customer_email()`), never admin ones.
- Only switch to a language whose assets are actually installed, so a missing pack degrades to
  English instead of a half-translated email.
- **Always restore on the same stack.** A missed pop leaks one shopper's language into the next email
  in a batched/cron run — this is the failure mode to test for.
- Our own `Sillage_Tracking_Email` extends `WC_Email`, so it rides the same path (and can additionally
  switch before its own `setup_locale()` for belt and braces).

*Alternative, narrower hook* (recorded for completeness): `woocommerce_email_recipient_{$id}` fires
with `$this->object` before the subject is built in `send_notification()`, so it can carry the order
too. It is tighter but leans on internal ordering, so the dispatch approach above is the one to
build.

### 3. Fill the translation assets — the only real work

| Asset | Effort | Notes |
|---|---|---|
| WooCommerce core packs, 22 of 24 languages | **automatic** | Scriptable on the box (`Language_Pack_Upgrader`, translation API reachable). Covers every core customer email. |
| `ga` (Irish) and `lb` (Luxembourgish) | **manual** | No WordPress locale exists for either. Either hand-write `woocommerce-<locale>.mo` from the storefront copy, or state plainly that those two stay English. |
| Our own strings (`sillage-tracking` ≈13, `sillage-warehouses` 1) × 24 | **translation pass** | Most sentences already exist in `src/locales/*.json` (`track.*`), so a generator can pre-fill `.po` and `MO::export()` can write the binaries — but the result needs a native read before it is trusted. |

## Language table (storefront code → WordPress locale)

`en` needs no switch (the site is already `en_US`). Candidate locales, from the box's own
translation API:

| Storefront | WP locale | Storefront | WP locale |
|---|---|---|---|
| bg | `bg_BG` | lt | `lt_LT` |
| cs | `cs_CZ` | lv | `lv` |
| da | `da_DK` | nl | `nl_NL` (BE: `nl_BE`) |
| de | `de_DE` (AT/CH: `de_AT`/`de_CH`) | pl | `pl_PL` |
| el | `el` | pt | `pt_PT` |
| es | `es_ES` | ro | `ro_RO` |
| et | `et` | sk | `sk_SK` |
| fi | `fi` | sl | `sl_SI` |
| fr | `fr_FR` (BE/CA: `fr_BE`/`fr_CA`) | sv | `sv_SE` |
| hr | `hr` | **ga** | **none** |
| hu | `hu_HU` | **lb** | **none** |
| it | `it_IT` | | |

The storefront carries **24** catalogues (not 27). Every language added from here needs a WP locale
*and* a `.mo` for the shop's own emails, so the count is a real cost driver, not a footnote.

## What translates, and what never does

- **Translates:** every string WooCommerce and our plugins build with `__()` — subjects, headings,
  bodies, buttons, order-status labels, "Track your order", dates via the locale.
- **Never translates:** product names, product descriptions, brand names, skus, order notes typed by
  a human, the engine's operator-facing notifications, the WP admin.

## Phases and rough size

| Phase | Delivers | Size |
|---|---|---|
| **1** | WC packs for the supported languages + language captured on the order (header, country fallback) + per-order locale switch. Core customer emails arrive in the shopper's language. | Small, self-contained. Highest value per hour. |
| **2** | `.mo` for `sillage-tracking` and `sillage-warehouses` in every language, generated from the storefront catalogues then reviewed; decides the `ga`/`lb` question. | The real translation bill. |
| **3** | Optional: reset-password / new-account emails follow the **user's** language (pack-driven); a dashboard control to see/override an order's email language. | Nice-to-have. |

Phase 1 alone is the demoable answer to "the emails should be in my language".

## Rejected options

- **WPML / Polylang / TranslatePress.** Nothing to translate in WordPress (the public shop is
  React), and their free tiers do not cover WooCommerce transactional emails. Paid, and they'd
  translate a backend nobody reads.
- **Per-language email template copies.** 24 copies of every template to maintain by hand; breaks on
  the first template change.
- **A global `determine_locale` filter** (the pasted snippet): fires for admin screens, REST reads and
  the dashboard, and never answers "which order is this email for".
- **Translating product names.** Inventory, not structure.
- **Deriving the language from the country only.** It is the correct *fallback* and nearly the whole
  answer, but it silently drops the storefront's explicit `?lang=` override.

## Risks and the tests that settle them

1. **Locale leak across emails** in a batched run — send two orders with different languages in one
   request/cron window and assert each email's locale independently.
2. **Deferred queue** (`DeferredEmailQueue`) — confirm whether the feature is enabled on the box
   first, then confirm the restore runs in the async path too.
3. **Non-order customer emails** (reset password, new account) — with no order they fall back to the
   site locale; that must be a stated limit, not a surprise.
4. **A language with no pack** — must degrade to clean English, never a half-translated email.
5. **Stripe path** — confirm the header is present on the card checkout request as well as the cash
   one.

## Acceptance criteria (when, and only when, this is built)

- A delivery address in Germany receives order-received, processing and completed emails whose
  subject, heading and body are German; the same order's tracking email and two-parcel notice are
  German too.
- An English order is byte-for-byte the English it is today.
- Two orders in two languages sent in the same cron window each keep their own language.
- An order with no language signal falls back to its country's language, and an unknown country falls
  back to English without error.
- `ga`/`lb` behave exactly as documented above (translated if the packs were made, English if not).

## First steps, in order

1. Get the client's decision and a price for Phases 1 and 2. Nothing below is done before that.
2. Re-run the survey above on the then-current box (WC version drifts; the `woocommerce_email_locale`
   question must be re-checked on every upgrade).
3. Mirror `COUNTRY_LANGUAGES` into PHP beside the locale table, with a test that every storefront
   language maps to a locale we intend to install.
4. Install the packs; script it so the box can re-install after a WooCommerce upgrade.
5. Phase 1 code: the `buildHeaders` line, the checkout hook writing `_sillage_language`, the
   dispatch-based switch. Deploy `plugins` (or a new small plugin) + `mu` + `frontend`, then `verify`.
6. Phase 2: generate and review the `.mo` files, then a live German order end to end.

## Files this would touch

- `react_store/frontend/src/shared/lib/woo.js` — the language header in `buildHeaders()`.
- `react_store/frontend/src/shared/i18n/countryLanguages.js` — the map to mirror server-side.
- `mu-plugins/cereve-storefront-auth.php` — the natural home for the checkout hook (it already owns
  the storefront-facing order routes), **or** a small new `mu-plugins/sillage-email-language.php`.
- `plugins/sillage-tracking/class-sillage-tracking-email.php` — belt-and-braces switch in `trigger()`.
- `wp-content/languages/plugins/` — WC packs + our `.mo` files (server state, not in the repo).
- Docs to update on completion: this file, [`../CODEBASE-STATE.md`](../CODEBASE-STATE.md),
  [`../CLIENT-GUIDE.md`](../CLIENT-GUIDE.md), and the frontend's `docs/I18N-GUIDE.md` §5 (replace the
  "out of scope" line).
