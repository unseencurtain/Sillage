# Must-use (MU) plugins

Files here are **must-use** WordPress plugins: they sit in the live container's
`wp-content/mu-plugins/`, load automatically, and cannot be deactivated from the
admin Plugins screen. That is deliberate for code that must always run.

**The repo copy is the source of truth.** `tools/sillage-deploy.ts mu` installs these files into
the live `ecom` container, runs `php -l`, and backs up the previous copy under `~/backups/`.
Never edit only the live copy: the next deploy overwrites it. After a deploy, verify the live
copy matches this repo.

## `cereve-storefront-auth.php`

Session-authentication routes for the headless storefront (`/wc/store/v1/customer`
register/login/logout/profile/orders). It is the only code on the site that
establishes a customer session, which is why it is must-use and not switchable off.

### Why not an ordinary plugin?

An ordinary plugin can be deactivated and login would fail silently. A mu-plugin
always loads, needs no activation step, and loads before regular plugins. It is
uniquely responsible for the auth surface: no other plugin registers `/customer`
routes or the WP auth cookie, `headless-core` only filters `/wp/v2/users` and CORS,
and `headless-woocommerce`'s admin-API guard (`^/wc/v\d+`) does not match
`/wc/store/v1`.

## `sillage-stripe-hosted.php`

The shop's only payment path. It registers the `sillage_checkout` gateway, opens a Stripe
**hosted Checkout** Session for the WooCommerce order, verifies the signed webhook at
`/?wc-api=sillage_checkout`, exposes the return route `POST /sillage/v1/hosted/complete`, and
handles refunds. There is no card form and no Stripe key in the browser.

It reads the API keys from the official WooCommerce Stripe Gateway option
(`woocommerce_stripe_settings`), so that plugin stays active as the key store. Its own
`stripe*` gateways are filtered out of checkout; only `sillage_checkout` is offered. Do not
delete the official plugin or its option.

The gateway creates and keeps its own webhook endpoint for **each mode** (`test` and `live`) and
stores the signing secret in `sillage_hosted_webhook_endpoints` (autoload off). The official
plugin's `testmode` flag is the only switch: flipping it needs no webhook, key or settings setup,
because the next checkout creates or reuses the endpoint for that mode. Orders record their own
mode, so an in-flight test order can never settle as live, or the reverse.

Full flow, security properties, test cards and open items:
`react_store/frontend/docs/CARD-PAYMENTS.md`.

## Deploying

Run the storefront deploy tool from `react_store/frontend`; it installs both files:

```bash
SILLAGE_SSH_HOST=<ssh-alias> bun tools/sillage-deploy.ts mu
```

## Verifying local matches production

```bash
for f in cereve-storefront-auth.php sillage-stripe-hosted.php; do
  ssh <ssh-alias> "docker exec ecom cat /var/www/html/wp-content/mu-plugins/$f" \
    | diff - "mu-plugins/$f"
done
```

## No second copy

There is no local WordPress / dev docroot. Never keep a stray copy anywhere. A
stray untracked copy is exactly how a file went missing before.
