# Must-use (MU) plugins

Files here are **must-use** WordPress plugins: they sit in the live container's
`wp-content/mu-plugins/`, load automatically, and cannot be deactivated from the
admin Plugins screen. That is deliberate for code that must always run.

**The live/production copy is the reference.** These files mirror what is actually
running on the shop. Keep the repo copy byte-for-byte identical to production;
when they differ, production wins.

## `cereve-storefront-auth.php`

Session-authentication routes for the headless storefront (`/wc/store/v1/customer`
register/login/logout/profile/orders). It is the only code on the site that
establishes a customer session, which is why it is must-use and not switchable off.

### Deploying

The storefront deploy tool from `react_store/frontend` installs this file into the
live `ecom` container (it runs `php -l` and backs up the previous copy under
`~/backups/`):

```bash
SILLAGE_SSH_HOST=<ssh-alias> bun tools/sillage-deploy.ts mu
```

### Verifying local matches production

```bash
ssh <ssh-alias> 'cat ~/sillage/data/wp/wp-content/mu-plugins/cereve-storefront-auth.php' \
  | diff - mu-plugins/cereve-storefront-auth.php
```

### No second copy

There is no local WordPress / dev docroot. Never keep a stray copy anywhere — a
stray untracked copy is exactly how this file went missing before.

### Why not an ordinary plugin?

An ordinary plugin can be deactivated and login would fail silently. A mu-plugin
always loads, needs no activation step, and loads before regular plugins. It is
uniquely responsible for the auth surface: no other plugin registers `/customer`
routes or the WP auth cookie, `headless-core` only filters `/wp/v2/users` and CORS,
and `headless-woocommerce`'s admin-API guard (`^/wc/v\d+`) does not match
`/wc/store/v1`.
