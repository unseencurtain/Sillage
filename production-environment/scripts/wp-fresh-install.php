<?php
/**
 * First boot inside the WordPress image. Plugins and Blocksy are already in the image.
 *
 * Installs the site if needed, activates WooCommerce + redis-cache + sillage-bridge
 * + Blocksy companion, turns on HPOS, EUR, pretty permalinks, Coming soon off.
 *
 * WP_ADMIN_USER must be set and must not be "admin".
 */
define('WP_INSTALLING', true);
error_reporting(E_ALL);
ini_set('display_errors', '1');

$shopDomain = getenv('SHOP_DOMAIN') ?: 'localhost';
$_SERVER['HTTP_HOST'] = $shopDomain;
$_SERVER['SERVER_NAME'] = $shopDomain;
$_SERVER['REQUEST_URI'] = '/';

require '/var/www/html/wp-load.php';
require_once ABSPATH . 'wp-admin/includes/upgrade.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';

$base = getenv('WP_BASE_URL') ?: '';
$base = rtrim($base, '/');
if ($base === '') {
    $scheme = getenv('WP_HOME_SCHEME') ?: 'https';
    $base = $scheme . '://' . $shopDomain;
}

$wpUser = trim((string) getenv('WP_ADMIN_USER'));
if ($wpUser === '' || strcasecmp($wpUser, 'admin') === 0) {
    fwrite(STDERR, "WP_ADMIN_USER must be set and must not be admin\n");
    exit(1);
}

echo 'installed=' . (is_blog_installed() ? 'yes' : 'no') . PHP_EOL;

if (!is_blog_installed()) {
    $pass = getenv('WP_ADMIN_PASS') ?: wp_generate_password(20, false);
    $title = getenv('SHOP_TITLE') ?: 'Shop';
    $email = getenv('WP_ADMIN_EMAIL') ?: ($wpUser . '@' . $shopDomain);
    $r = wp_install($title, $wpUser, $email, true, '', $pass, 'en_US');
    echo 'wp_install_ok user=' . ($r['user_id'] ?? '?') . ' login=' . $wpUser . PHP_EOL;
}

update_option('siteurl', $base);
update_option('home', $base);
update_option('woocommerce_currency', 'EUR');
update_option('permalink_structure', '/%postname%/');
update_option('woocommerce_coming_soon', 'no');
update_option('woocommerce_onboarding_profile', array('skipped' => true));

// Blocksy's companion ships as either the free or the pro directory depending on the
// image; activate whichever one is present rather than guessing one name.
foreach (array(
    array('woocommerce/woocommerce.php'),
    array('redis-cache/redis-cache.php'),
    array('sillage-bridge/sillage-bridge.php'),
    array('blocksy-companion-pro/blocksy-companion.php', 'blocksy-companion/blocksy-companion.php'),
) as $candidates) {
    $found = null;
    foreach ($candidates as $p) {
        if (file_exists(WP_PLUGIN_DIR . '/' . $p)) {
            $found = $p;
            break;
        }
    }
    if ($found === null) {
        echo implode(' | ', $candidates) . " missing\n";
        continue;
    }
    $res = activate_plugin($found);
    echo $found . (is_wp_error($res) ? (' FAIL ' . $res->get_error_message()) : ' ok') . PHP_EOL;
}

if (function_exists('wp_get_theme') && wp_get_theme('blocksy')->exists()) {
    switch_theme('blocksy');
    echo "theme=blocksy\n";
}

// Leave the front page on "latest posts" and WordPress guesses a permalink for "/",
// which on a synced shop lands the homepage on whichever product owns that post ID.
$shopPage = (int) get_option('woocommerce_shop_page_id');
if ($shopPage > 0) {
    update_option('show_on_front', 'page');
    update_option('page_on_front', $shopPage);
    update_option('page_for_posts', 0);
    echo 'front_page=' . $shopPage . PHP_EOL;
}

update_option('woocommerce_custom_orders_table_enabled', 'yes');
update_option('woocommerce_custom_orders_table_data_sync_enabled', 'no');
update_option('woocommerce_feature_custom_order_tables_enabled', 'yes');
if (class_exists(\Automattic\WooCommerce\Internal\Features\FeaturesController::class)) {
    try {
        $features = wc_get_container()->get(\Automattic\WooCommerce\Internal\Features\FeaturesController::class);
        if (method_exists($features, 'change_feature_enabled')) {
            $features->change_feature_enabled('custom_order_tables', true);
        }
    } catch (Throwable $e) {
        echo 'hpos_feature_warn=' . $e->getMessage() . PHP_EOL;
    }
}

flush_rewrite_rules(false);

$secret = getenv('SILLAGE_SHARED_SECRET') ?: '';
$dash = getenv('SILLAGE_DASHBOARD_URL') ?: '';
$core = getenv('SILLAGE_CORE_INTERNAL_URL') ?: 'http://sillage-core:4000';
$sillageDb = getenv('SILLAGE_DB') ?: 'sillage';
if ($secret !== '' && defined('ABSPATH')) {
    $wp = ABSPATH . 'wp-config.php';
    if (is_readable($wp)) {
        $text = file_get_contents($wp);
        if ($text !== false && strpos($text, "SILLAGE_SHARED_SECRET") === false) {
            // WP-CLI loads wp-config.php twice, so bare define() calls warn on every run.
            $block = "\n/* Sillage bridge */\n"
                . "if ( ! defined( 'SILLAGE_SHARED_SECRET' ) ) {\n"
                . "\tdefine( 'SILLAGE_SHARED_SECRET', '" . addcslashes($secret, "'\\") . "' );\n"
                . "\tdefine( 'SILLAGE_CORE_URL', '" . addcslashes($core, "'\\") . "' );\n"
                . "\tdefine( 'SILLAGE_DASHBOARD_URL', '" . addcslashes($dash, "'\\") . "' );\n"
                . "\tdefine( 'SILLAGE_DB', '" . addcslashes($sillageDb, "'\\") . "' );\n"
                . "\tdefine( 'DISABLE_WP_CRON', true );\n"
                // The operator installs the paid Blocksy companion by uploading a zip in
                // wp-admin. Without this, WordPress can decide it cannot write directly and
                // asks for FTP credentials that do not exist on a container host.
                . "\tdefine( 'FS_METHOD', 'direct' );\n"
                . "}\n";
            $marker = "/* That's all, stop editing!";
            $text = strpos($text, $marker) !== false ? str_replace($marker, $block . $marker, $text) : ($text . $block);
            file_put_contents($wp, $text);
            echo "wp_config_sillage_patched\n";
        }
    }
}

echo 'siteurl=' . get_option('siteurl') . PHP_EOL;
echo 'hpos=' . get_option('woocommerce_custom_orders_table_enabled') . PHP_EOL;
echo 'coming_soon=' . get_option('woocommerce_coming_soon') . PHP_EOL;
echo 'currency=' . get_option('woocommerce_currency') . PHP_EOL;
echo 'permalink=' . get_option('permalink_structure') . PHP_EOL;
echo 'WP_FRESH_INSTALL_DONE' . PHP_EOL;
