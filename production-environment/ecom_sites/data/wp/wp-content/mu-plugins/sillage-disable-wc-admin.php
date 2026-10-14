<?php
/**
 * Plugin Name: Sillage - Disable WooCommerce Admin app
 * Description: Turns off the WooCommerce Admin React app (Analytics, Home, notes polling). Its background requests
 *              loop when the page cannot reach its REST endpoints, which pinned the server at 100% CPU.
 *              Orders, the REST API used by the dashboard, and the storefront are not affected.
 *              To restore the WooCommerce Admin app, delete this file.
 */
defined('ABSPATH') || exit;
add_filter('woocommerce_admin_disabled', '__return_true');
