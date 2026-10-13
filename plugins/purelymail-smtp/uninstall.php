<?php
/**
 * Remove Purelymail SMTP settings when the plugin is deleted from WordPress.
 */

defined('WP_UNINSTALL_PLUGIN') || exit;

delete_option('purelymail_smtp_settings');
