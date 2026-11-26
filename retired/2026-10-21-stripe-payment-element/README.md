# Retired: custom Stripe gateway

Archived 2026-10-22. Removed from the active tree by `06433f3`
("stripe: move the shop to hosted Checkout").

Contents:

- `mu-plugins/sillage-stripe-checkout.php`: the old custom gateway and its
  `/stripe/config`, intent and confirmation routes.

This file is not installed. `tools/sillage-deploy.ts` lists it in
`RETIRED_MU_PLUGINS` and removes it from the box on every `mu` deploy. The active
gateway is `mu-plugins/sillage-stripe-hosted.php`.

The retired Payment Plugins for Stripe WooCommerce options were archived outside
this repo at `/home/ubuntu/retired-plugins/woocommerce-stripe/`.
