<?php
/**
 * Plugin Name: Headless WooCommerce
 * Description: WooCommerce protections and frontend links for headless sites. Keep WooCommerce API keys on the server.
 * Version: 1.2.0
 * Requires PHP: 7.4
 * Requires Plugins: woocommerce
 * License: GPL-2.0-or-later
 *
 * Optional wp-config.php constants:
 *   define('HEADLESS_FRONTEND_URL', 'https://shop.example.com');   // same as Headless Core
 *   define('HEADLESS_WOO_REWRITE_URLS', true);                     // default true
 *   define('HEADLESS_WOO_PATHS', ['cart' => '/cart', 'checkout' => '/checkout', 'order' => '/order-received']);
 *   define('HEADLESS_WOO_RATE_LIMIT', 120);                        // requests per 10s per IP (storefront makes many Store API calls)
 */

defined('ABSPATH') || exit;

/** Use the Headless Core dashboard URL when available, with constant fallback. */
function headless_woo_frontend_url(): string {
    if (function_exists('headless_frontend_url')) {
        $frontend = headless_frontend_url();
        return $frontend !== '' ? $frontend : untrailingslashit(home_url('/'));
    }
    if (defined('HEADLESS_FRONTEND_URL') && (string) HEADLESS_FRONTEND_URL !== '') {
        return untrailingslashit((string) HEADLESS_FRONTEND_URL);
    }
    // Same-domain Caddy setups need no separate frontend URL setting.
    return untrailingslashit(home_url('/'));
}

add_action('plugins_loaded', function () {
    if (!class_exists('WooCommerce')) {
        return;
    }

    $frontend = headless_woo_frontend_url();

    /* --------------------------------------------------------------
     * 1. Reject browser-origin requests to the WooCommerce admin API.
     *    Never put WooCommerce API keys in React/browser code. The
     *    public Store API remains available for browser cart/checkout.
     * ------------------------------------------------------------*/
    add_filter('rest_pre_dispatch', function ($result, $server, $request) {
        $route = $request->get_route();
        $is_admin_api = (bool) preg_match('#^/wc/v\d+(/|$)#', $route);
        if ($is_admin_api && !empty($_SERVER['HTTP_ORIGIN'])) {
            return new WP_Error(
                'headless_forbidden',
                'The WooCommerce admin API cannot be called from a browser.',
                ['status' => 403]
            );
        }
        return $result;
    }, 10, 3);

    /* --------------------------------------------------------------
     * 2. Rate-limit the public Store API (cart/checkout abuse).
     *    proxy_support = true because you run behind a reverse proxy.
     * ------------------------------------------------------------*/
    add_filter('woocommerce_store_api_rate_limit_options', function () {
        return [
            'enabled'       => true,
            'proxy_support' => true,
            // The storefront sends bursts of Store API calls (catalogue lists, category previews, cart
            // state). 120 per 10 seconds leaves room for that and still limits scripted cart abuse.
            'limit'         => defined('HEADLESS_WOO_RATE_LIMIT') ? (int) HEADLESS_WOO_RATE_LIMIT : 120,
            'seconds'       => 10,
        ];
    });

    /* --------------------------------------------------------------
     * 3. Send cart / checkout / thank-you links to the frontend
     * ------------------------------------------------------------*/
    $rewrite = !defined('HEADLESS_WOO_REWRITE_URLS') || HEADLESS_WOO_REWRITE_URLS;
    if ($frontend && $rewrite) {
        $paths = wp_parse_args(
            defined('HEADLESS_WOO_PATHS') ? (array) HEADLESS_WOO_PATHS : [],
            ['cart' => '/cart', 'checkout' => '/checkout', 'order' => '/order-received']
        );

        add_filter('woocommerce_get_cart_url', function () use ($frontend, $paths) {
            return $frontend . $paths['cart'];
        });
        add_filter('woocommerce_get_checkout_url', function () use ($frontend, $paths) {
            return $frontend . $paths['checkout'];
        });
        add_filter('woocommerce_get_checkout_order_received_url', function ($url, $order) use ($frontend, $paths) {
            return add_query_arg(
                'key',
                $order->get_order_key(),
                $frontend . $paths['order'] . '/' . $order->get_id()
            );
        }, 10, 2);
        add_filter('post_type_link', function ($url, $post) use ($frontend) {
            return $post->post_type === 'product' ? $frontend . '/product/' . $post->post_name : $url;
        }, 10, 2);
    }

    /* --------------------------------------------------------------
     * 4. Smaller hardening
     * ------------------------------------------------------------*/
    // Never expose private order notes to non-admins via the Store API cache headers.
    add_filter('woocommerce_store_api_disable_nonce_check', '__return_false');

    // No WooCommerce front-end assets needed (the frontend is elsewhere).
    add_filter('woocommerce_enqueue_styles', '__return_empty_array');
}, 20);
