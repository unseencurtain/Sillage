# Pin WordPress and PHP exactly so image verification and scripted upgrades agree.
# wordpress:latest — a silent WP bump on a new VPS is an untested shop.
FROM wordpress:7.1.3-php8.3-apache

ADD --chmod=755 \
  https://github.com/mlocati/docker-php-extension-installer/releases/latest/download/install-php-extensions \
  /usr/local/bin/install-php-extensions

RUN install-php-extensions redis
