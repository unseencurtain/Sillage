<?php
/**
 * Plugin Name: Headless Core
 * Description: Optional headless frontend redirect, strict CORS, and WordPress REST API hardening.
 * Version: 1.2.0
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 *
 * Configure in Settings > Headless Core, or in wp-config.php (above "That's all, stop editing!"):
 *   define('HEADLESS_FRONTEND_URL', 'https://shop.example.com');
 *   define('HEADLESS_ALLOWED_ORIGINS', ['https://shop.example.com', 'http://localhost:3000']);
 */

defined('ABSPATH') || exit;

const HEADLESS_CORE_SETTINGS_OPTION = 'headless_core_settings';

/** Return saved settings, falling back to legacy wp-config.php constants. */
function headless_core_settings(): array {
    $saved = get_option(HEADLESS_CORE_SETTINGS_OPTION, null);
    if (is_array($saved)) {
        return wp_parse_args($saved, [
            'redirect_enabled' => false,
            'frontend_url'     => '',
            'allowed_origins'  => [],
        ]);
    }

    $frontend = defined('HEADLESS_FRONTEND_URL') ? (string) HEADLESS_FRONTEND_URL : '';
    $origins = defined('HEADLESS_ALLOWED_ORIGINS') ? (array) HEADLESS_ALLOWED_ORIGINS : [];
    return [
        // Preserve the old behavior for sites already configured in wp-config.php.
        'redirect_enabled' => $frontend !== '',
        'frontend_url'     => untrailingslashit($frontend),
        'allowed_origins'  => $origins,
    ];
}

/** Frontend base URL, no trailing slash. */
function headless_frontend_url(): string {
    $settings = headless_core_settings();
    return untrailingslashit((string) $settings['frontend_url']);
}

/** Normalize an HTTP(S) origin, rejecting paths and credentials. */
function headless_core_normalize_origin(string $url): string {
    $parts = wp_parse_url(trim($url));
    if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
        return '';
    }

    $scheme = strtolower((string) $parts['scheme']);
    if (!in_array($scheme, ['http', 'https'], true)
        || !empty($parts['user'])
        || !empty($parts['pass'])
        || (isset($parts['path']) && !in_array($parts['path'], ['', '/'], true))
        || isset($parts['query'])
        || isset($parts['fragment'])
    ) {
        return '';
    }

    $host = strtolower((string) $parts['host']);
    $port = isset($parts['port']) ? ':' . (int) $parts['port'] : '';
    return $scheme . '://' . $host . $port;
}

/** Get the origin from a frontend base URL, which may include a path. */
function headless_core_frontend_origin(string $url): string {
    $parts = wp_parse_url(trim($url));
    if (!is_array($parts) || empty($parts['scheme']) || empty($parts['host'])) {
        return '';
    }

    $origin = strtolower((string) $parts['scheme']) . '://' . $parts['host'];
    if (isset($parts['port'])) {
        $origin .= ':' . (int) $parts['port'];
    }
    return headless_core_normalize_origin($origin);
}

/** Origins allowed to call the API from a browser. */
function headless_allowed_origins(): array {
    $settings = headless_core_settings();
    $origins = array_filter(array_map('headless_core_normalize_origin', (array) $settings['allowed_origins']));
    if (!$origins && headless_frontend_url()) {
        $frontend_origin = headless_core_frontend_origin(headless_frontend_url());
        if ($frontend_origin) {
            $origins = [$frontend_origin];
        }
    }
    return array_values(array_unique($origins));
}

/** Add the settings page under Settings in wp-admin. */
add_action('admin_menu', function () {
    add_options_page(
        __('Headless Core', 'headless-core'),
        __('Headless Core', 'headless-core'),
        'manage_options',
        'headless-core',
        'headless_core_render_settings_page'
    );
});

add_action('admin_init', function () {
    register_setting(
        'headless_core_settings_group',
        HEADLESS_CORE_SETTINGS_OPTION,
        ['sanitize_callback' => 'headless_core_sanitize_settings']
    );
});

/** Validate and sanitize settings submitted from wp-admin. */
function headless_core_sanitize_settings($input): array {
    $input = is_array($input) ? $input : [];
    $frontend_value = isset($input['frontend_url']) && is_string($input['frontend_url']) ? $input['frontend_url'] : '';
    $frontend_url = esc_url_raw(trim($frontend_value));
    $frontend_parts = $frontend_url ? wp_parse_url($frontend_url) : false;
    if ($frontend_url && (
        !is_array($frontend_parts)
        || empty($frontend_parts['scheme'])
        || empty($frontend_parts['host'])
        || !in_array(strtolower((string) $frontend_parts['scheme']), ['http', 'https'], true)
        || isset($frontend_parts['query'])
        || isset($frontend_parts['fragment'])
        || isset($frontend_parts['user'])
        || isset($frontend_parts['pass'])
    )) {
        add_settings_error(
            HEADLESS_CORE_SETTINGS_OPTION,
            'invalid_frontend_url',
            __('Enter a complete http:// or https:// frontend URL with no query string or fragment.', 'headless-core')
        );
        $frontend_url = '';
    }

    $origin_text = isset($input['allowed_origins']) && is_string($input['allowed_origins']) ? $input['allowed_origins'] : '';
    $origin_lines = preg_split('/[\r\n,]+/', $origin_text, -1, PREG_SPLIT_NO_EMPTY);
    $origins = [];
    foreach ($origin_lines as $origin_line) {
        $origin = headless_core_normalize_origin(esc_url_raw(trim($origin_line)));
        if ($origin) {
            $origins[] = $origin;
        } else {
            add_settings_error(
                HEADLESS_CORE_SETTINGS_OPTION,
                'invalid_origin_' . count($origins),
                sprintf(__('Skipped invalid browser origin: %s', 'headless-core'), esc_html(trim($origin_line)))
            );
        }
    }

    return [
        'redirect_enabled' => !empty($input['redirect_enabled']),
        'frontend_url'     => untrailingslashit($frontend_url),
        'allowed_origins'  => array_values(array_unique($origins)),
    ];
}

/** Render Settings > Headless Core. */
function headless_core_render_settings_page(): void {
    if (!current_user_can('manage_options')) {
        return;
    }
    $settings = headless_core_settings();
    ?>
    <div class="wrap">
        <h1><?php esc_html_e('Headless Core', 'headless-core'); ?></h1>
        <p><?php esc_html_e('This plugin keeps WordPress available for editing and API requests. It does not build or serve your React site; your web server (Caddy) does that.', 'headless-core'); ?></p>
        <?php settings_errors(HEADLESS_CORE_SETTINGS_OPTION); ?>
        <form action="options.php" method="post">
            <?php settings_fields('headless_core_settings_group'); ?>
            <table class="form-table" role="presentation">
                <tr>
                    <th scope="row"><?php esc_html_e('Public-site redirect', 'headless-core'); ?></th>
                    <td>
                        <label for="headless-core-redirect-enabled">
                            <input id="headless-core-redirect-enabled" type="checkbox" name="<?php echo esc_attr(HEADLESS_CORE_SETTINGS_OPTION); ?>[redirect_enabled]" value="1" <?php checked(!empty($settings['redirect_enabled'])); ?> />
                            <?php esc_html_e('Redirect public WordPress pages to the frontend', 'headless-core'); ?>
                        </label>
                        <p class="description"><?php esc_html_e('For a normal WordPress site, leave this off. If Caddy already sends visitors straight to React, leave it off there too. Turn it on only when public requests still reach WordPress and should be forwarded to a different frontend URL.', 'headless-core'); ?></p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="headless-core-frontend-url"><?php esc_html_e('Frontend URL', 'headless-core'); ?></label></th>
                    <td>
                        <input id="headless-core-frontend-url" class="regular-text code" type="url" name="<?php echo esc_attr(HEADLESS_CORE_SETTINGS_OPTION); ?>[frontend_url]" value="<?php echo esc_attr((string) $settings['frontend_url']); ?>" placeholder="https://aiyuco.com" />
                        <p class="description"><?php esc_html_e('Leave blank when React and WordPress use the same public domain. Enter the React URL only when its domain differs from the WordPress site; this is used for optional redirects, cross-domain API access, and links.', 'headless-core'); ?></p>
                    </td>
                </tr>
                <tr>
                    <th scope="row"><label for="headless-core-allowed-origins"><?php esc_html_e('Allowed browser origins', 'headless-core'); ?></label></th>
                    <td>
                        <textarea id="headless-core-allowed-origins" class="large-text code" rows="5" name="<?php echo esc_attr(HEADLESS_CORE_SETTINGS_OPTION); ?>[allowed_origins]" placeholder="https://aiyuco.com&#10;http://localhost:3000"><?php echo esc_textarea(implode("\n", (array) $settings['allowed_origins'])); ?></textarea>
                        <p class="description"><?php esc_html_e('Enter one origin per line: scheme + hostname + optional port, with no path. If left blank, the frontend URL origin is allowed automatically.', 'headless-core'); ?></p>
                    </td>
                </tr>
            </table>
            <?php submit_button(); ?>
        </form>
        <hr />
        <p><strong><?php esc_html_e('Dashboard access:', 'headless-core'); ?></strong> <?php esc_html_e('Keep using this WordPress site’s /wp-admin/ and /wp-login.php URLs. These paths are not redirected by this plugin.', 'headless-core'); ?></p>
        <p class="description"><?php esc_html_e('Once you save this page, these settings take precedence over the legacy HEADLESS_FRONTEND_URL and HEADLESS_ALLOWED_ORIGINS constants in wp-config.php.', 'headless-core'); ?></p>
    </div>
    <?php
}

/* ------------------------------------------------------------------
 * 1. Optionally redirect public WordPress pages to the frontend.
 *    wp-admin, wp-login.php, /wp-json, admin-ajax and cron never reach
 *    template_redirect, so they keep working.
 * ----------------------------------------------------------------*/
add_action('template_redirect', function () {
    $settings = headless_core_settings();
    $frontend = headless_frontend_url();
    if (empty($settings['redirect_enabled']) || !$frontend) {
        return; // not configured: do nothing instead of breaking the site
    }
    // Let payment gateway callbacks and robots through.
    if (isset($_GET['wc-api']) || is_robots()) {
        return;
    }
    $uri = isset($_SERVER['REQUEST_URI']) ? (string) wp_unslash($_SERVER['REQUEST_URI']) : '/';
    // Block open-redirect tricks like //evil.com or /\evil.com
    if ($uri === '' || $uri[0] !== '/' || preg_match('#^/[/\\\\]#', $uri)) {
        $uri = '/';
    }
    // Use a temporary redirect so changing the destination does not get stuck in browser caches.
    wp_redirect($frontend . $uri, 302, 'Headless');
    exit;
}, 1);

/* ------------------------------------------------------------------
 * 2. Make links WordPress generates point at the frontend
 *    (previews, "View post", emails).
 * ----------------------------------------------------------------*/
add_filter('post_link', function ($url, $post) {
    $f = headless_frontend_url();
    return $f ? $f . '/blog/' . $post->post_name : $url;
}, 10, 2);

add_filter('page_link', function ($url, $post_id) {
    $f = headless_frontend_url();
    if (!$f) {
        return $url;
    }
    $path = get_page_uri($post_id);
    return $f . '/' . ltrim((string) $path, '/');
}, 10, 2);

/* ------------------------------------------------------------------
 * 3. CORS: exact-match allowlist, never "*", credentials only for
 *    allowed origins.
 * ----------------------------------------------------------------*/
add_action('rest_api_init', function () {
    remove_filter('rest_pre_serve_request', 'rest_send_cors_headers');
    add_filter('rest_pre_serve_request', function ($served) {
        header('Vary: Origin', false);
        $origin = isset($_SERVER['HTTP_ORIGIN']) ? headless_core_normalize_origin((string) $_SERVER['HTTP_ORIGIN']) : '';
        if ($origin && in_array($origin, headless_allowed_origins(), true)) {
            header('Access-Control-Allow-Origin: ' . esc_url_raw($origin));
            header('Access-Control-Allow-Credentials: true');
            header('Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS');
            header('Access-Control-Allow-Headers: Authorization, Content-Type, X-WP-Nonce, Nonce, Cart-Token');
            header('Access-Control-Expose-Headers: X-WP-Total, X-WP-TotalPages, Nonce, Cart-Token');
            header('Access-Control-Max-Age: 600');
        }
        return $served;
    });
}, 15);

/* ------------------------------------------------------------------
 * 4. API hardening
 * ----------------------------------------------------------------*/

// Hide the user list from anonymous visitors (stops username enumeration).
add_filter('rest_endpoints', function ($endpoints) {
    if (!is_user_logged_in()) {
        foreach (array_keys($endpoints) as $route) {
            if (strpos($route, '/wp/v2/users') === 0) {
                unset($endpoints[$route]);
            }
        }
    }
    return $endpoints;
});

// Security headers on API responses.
add_filter('rest_post_dispatch', function ($response) {
    $response->header('X-Content-Type-Options', 'nosniff');
    $response->header('Referrer-Policy', 'no-referrer');
    return $response;
});

// Disable XML-RPC (brute-force target, not needed headless).
add_filter('xmlrpc_enabled', '__return_false');

// Remove version/discovery noise.
remove_action('wp_head', 'wp_generator');
add_filter('the_generator', '__return_empty_string');
remove_action('wp_head', 'wp_oembed_add_discovery_links');

// Stop ?author=1 username leaks.
add_action('init', function () {
    if (!is_admin() && isset($_GET['author'])) {
        wp_safe_redirect(home_url('/'), 301);
        exit;
    }
});

// Application Passwords only over HTTPS.
add_filter('wp_is_application_passwords_available', function ($available) {
    return is_ssl() ? $available : false;
});
