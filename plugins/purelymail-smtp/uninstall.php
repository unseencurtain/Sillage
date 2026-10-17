<?php
/**
 * Remove Purelymail SMTP settings when the plugin is deleted from WordPress.
 */

defined('WP_UNINSTALL_PLUGIN') || exit;

delete_option('purelymail_smtp_settings');
// Send history was removed in 1.1.1; delete the option an older version may have left.
delete_option('purelymail_smtp_log');
delete_option('purelymail_smtp_db_version');
