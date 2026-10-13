# Test WordPress image: official WordPress plus this repo's plugins. Build on the VPS from the
# repo root context: docker build -f ops/test/Dockerfile -t sillage-test-wordpress:latest <root>
FROM wordpress:php8.3-apache

# The official image seeds /var/www/html from /usr/src/wordpress on first start, so plugins
# placed here appear in the test volume without touching the live "ecom" container.
COPY plugins/headless-core /usr/src/wordpress/wp-content/plugins/headless-core
COPY plugins/headless-woocommerce /usr/src/wordpress/wp-content/plugins/headless-woocommerce
COPY plugins/storefront-ean /usr/src/wordpress/wp-content/plugins/storefront-ean
COPY plugins/sillage-warehouses /usr/src/wordpress/wp-content/plugins/sillage-warehouses
COPY plugins/purelymail-smtp /usr/src/wordpress/wp-content/plugins/purelymail-smtp
