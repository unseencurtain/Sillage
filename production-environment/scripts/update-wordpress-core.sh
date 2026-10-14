#!/usr/bin/env bash
# Sync WordPress core from the running pinned image into the data/wp bind mount.
# Run after `docker compose up -d` whenever the image changes.
set -euo pipefail

if ! docker inspect ecom >/dev/null 2>&1; then
  echo "ecom container is not running" >&2
  exit 1
fi

image_version="$(docker exec ecom php -r 'include "/usr/src/wordpress/wp-includes/version.php"; echo $wp_version;')"
data_version="$(docker exec ecom php -r 'include "/var/www/html/wp-includes/version.php"; echo $wp_version;')"
if [[ -z "$image_version" || -z "$data_version" ]]; then
  echo "Could not read the WordPress image and bind-mount versions" >&2
  exit 1
fi

if [[ "$image_version" == "$data_version" ]]; then
  echo "WordPress core already matches image: $image_version"
  exit 0
fi

if ! docker exec ecom php -r 'exit(version_compare($argv[1], $argv[2], ">") ? 0 : 1);' "$image_version" "$data_version"; then
  echo "Refusing to downgrade WordPress bind mount $data_version to image $image_version" >&2
  exit 1
fi

echo "Updating WordPress core $data_version → $image_version from the pinned image"
docker exec ecom sh -ec 'tar -C /usr/src/wordpress --exclude=wp-content --exclude=wp-config.php --exclude=.htaccess -cf - . | tar -C /var/www/html -xf -'
docker exec ecom sh -ec 'chown -R www-data:www-data /var/www/html/wp-admin /var/www/html/wp-includes; find /var/www/html -maxdepth 1 -type f -exec chown www-data:www-data {} +'
docker exec ecom php -r 'require "/var/www/html/wp-load.php"; require_once ABSPATH."wp-admin/includes/upgrade.php"; wp_upgrade();'
echo "WordPress core updated: $image_version"
