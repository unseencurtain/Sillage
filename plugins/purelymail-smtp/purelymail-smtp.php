<?php
/**
 * Plugin Name: Purelymail SMTP
 * Description: Send WordPress and WooCommerce email through encrypted Purelymail SMTP connections.
 * Version: 1.0.0
 * Requires at least: 5.7
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 */

defined('ABSPATH') || exit;

const PURELYMAIL_SMTP_OPTION = 'purelymail_smtp_settings';

/** Return the saved SMTP profiles and selected profile. */
function purelymail_smtp_settings(): array {
    $settings = get_option(PURELYMAIL_SMTP_OPTION, []);
    if (!is_array($settings)) {
        $settings = [];
    }

    $connections = isset($settings['connections']) && is_array($settings['connections'])
        ? $settings['connections']
        : [];

    return [
        'connections'      => $connections,
        'active_connection' => isset($settings['active_connection']) ? (string) $settings['active_connection'] : '',
    ];
}

/** Encrypt SMTP passwords at rest using the site's WordPress secret salts. */
function purelymail_smtp_encrypt_password(string $password) {
    if (!function_exists('openssl_encrypt') || !function_exists('random_bytes')) {
        return false;
    }

    try {
        $iv = random_bytes(12);
    } catch (Throwable $error) {
        return false;
    }

    $key = hash('sha256', wp_salt('auth') . '|' . wp_salt('secure_auth'), true);
    $tag = '';
    $ciphertext = openssl_encrypt($password, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    if ($ciphertext === false || $tag === '') {
        return false;
    }

    return 'v1:' . base64_encode($iv . $tag . $ciphertext);
}

/** Decrypt a stored SMTP password. */
function purelymail_smtp_decrypt_password(string $encrypted) {
    if (strpos($encrypted, 'v1:') !== 0 || !function_exists('openssl_decrypt')) {
        return false;
    }

    $payload = base64_decode(substr($encrypted, 3), true);
    if ($payload === false || strlen($payload) < 29) {
        return false;
    }

    $iv = substr($payload, 0, 12);
    $tag = substr($payload, 12, 16);
    $ciphertext = substr($payload, 28);
    $key = hash('sha256', wp_salt('auth') . '|' . wp_salt('secure_auth'), true);

    return openssl_decrypt($ciphertext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
}

/** Register the Settings page and option. */
add_action('admin_menu', function () {
    add_options_page(
        __('Purelymail SMTP', 'purelymail-smtp'),
        __('Purelymail SMTP', 'purelymail-smtp'),
        'manage_options',
        'purelymail-smtp',
        'purelymail_smtp_render_settings_page'
    );
});

add_action('admin_init', function () {
    register_setting(
        'purelymail_smtp_settings_group',
        PURELYMAIL_SMTP_OPTION,
        ['sanitize_callback' => 'purelymail_smtp_sanitize_settings']
    );
});

/** Validate submitted profiles and store passwords only as authenticated ciphertext. */
function purelymail_smtp_sanitize_settings($input): array {
    $input = is_array($input) ? $input : [];
    $current = purelymail_smtp_settings();
    $submitted = isset($input['connections']) && is_array($input['connections']) ? $input['connections'] : [];
    // Settings may be saved from either the account editor (one profile) or
    // the compact account list (active profile only); retain everything else.
    $connections = $current['connections'];

    foreach ($submitted as $raw_id => $raw_connection) {
        if (!is_array($raw_connection)) {
            continue;
        }

        $id = sanitize_key((string) $raw_id);
        if ($id === '') {
            continue;
        }

        $name = isset($raw_connection['name']) ? sanitize_text_field((string) $raw_connection['name']) : '';
        $from_email = isset($raw_connection['from_email']) ? sanitize_email((string) $raw_connection['from_email']) : '';
        $from_name = isset($raw_connection['from_name']) ? sanitize_text_field((string) $raw_connection['from_name']) : '';
        $reply_to = isset($raw_connection['reply_to']) ? sanitize_email((string) $raw_connection['reply_to']) : '';
        $username = isset($raw_connection['username']) ? sanitize_text_field((string) $raw_connection['username']) : '';
        $security = isset($raw_connection['security']) && $raw_connection['security'] === 'ssl' ? 'ssl' : 'tls';

        if ($name === '' || !is_email($from_email) || $username === '') {
            add_settings_error(
                PURELYMAIL_SMTP_OPTION,
                'invalid_connection_' . $id,
                __('Each connection needs a name, valid From Email, and SMTP username. Incomplete connections were not saved.', 'purelymail-smtp')
            );
            continue;
        }

        $password = isset($raw_connection['password']) && is_string($raw_connection['password'])
            ? str_replace("\0", '', $raw_connection['password'])
            : '';

        if ($password !== '') {
            $stored_password = purelymail_smtp_encrypt_password($password);
            if ($stored_password === false) {
                add_settings_error(
                    PURELYMAIL_SMTP_OPTION,
                    'password_encryption_failed_' . $id,
                    __('The password could not be encrypted. Enable PHP OpenSSL and try again; the password was not saved.', 'purelymail-smtp')
                );
                $stored_password = isset($current['connections'][$id]['password'])
                    ? (string) $current['connections'][$id]['password']
                    : '';
            }
        } else {
            $stored_password = isset($current['connections'][$id]['password'])
                ? (string) $current['connections'][$id]['password']
                : '';
        }

        if ($stored_password === '') {
            add_settings_error(
                PURELYMAIL_SMTP_OPTION,
                'missing_password_' . $id,
                sprintf(__('A password is required for “%s”. This connection was not saved.', 'purelymail-smtp'), $name)
            );
            continue;
        }

        $connections[$id] = [
            'name'       => $name,
            'from_email' => $from_email,
            'from_name'  => $from_name,
            // Optional. Customers who hit "reply" reach this address.
            'reply_to'   => is_email($reply_to) ? $reply_to : '',
            'username'   => $username,
            'password'   => $stored_password,
            // TLS and SSL are the only supported modes; the host is fixed to Purelymail.
            'security'   => $security,
        ];
    }

    $active = isset($input['active_connection'])
        ? sanitize_key((string) $input['active_connection'])
        : $current['active_connection'];
    if (!isset($connections[$active])) {
        $active = $connections ? (string) array_key_first($connections) : '';
    }

    return [
        'connections'       => $connections,
        'active_connection' => $active,
    ];
}

/** Remove a sender account from the compact accounts list. */
add_action('admin_post_purelymail_smtp_delete_connection', 'purelymail_smtp_delete_connection');

function purelymail_smtp_delete_connection(): void {
    if (!current_user_can('manage_options')) {
        wp_die(esc_html__('You are not allowed to manage SMTP connections.', 'purelymail-smtp'));
    }

    $id = isset($_GET['id']) ? sanitize_key((string) wp_unslash($_GET['id'])) : '';
    check_admin_referer('purelymail_smtp_delete_' . $id);

    $settings = purelymail_smtp_settings();
    unset($settings['connections'][$id]);
    if ($settings['active_connection'] === $id) {
        $settings['active_connection'] = $settings['connections']
            ? (string) array_key_first($settings['connections'])
            : '';
    }
    update_option(PURELYMAIL_SMTP_OPTION, $settings);

    wp_safe_redirect(add_query_arg(
        ['page' => 'purelymail-smtp', 'removed' => '1'],
        admin_url('options-general.php')
    ));
    exit;
}

/** Render Settings > Purelymail SMTP. */
function purelymail_smtp_render_settings_page_legacy(): void {
    if (!current_user_can('manage_options')) {
        return;
    }

    $settings = purelymail_smtp_settings();
    $active_connection = isset($settings['connections'][$settings['active_connection']])
        ? $settings['connections'][$settings['active_connection']]
        : null;
    $active_label = $active_connection
        ? trim((string) $active_connection['name'] . ' — ' . (string) $active_connection['from_email'])
        : __('No active sender selected', 'purelymail-smtp');
    ?>
    <div class="wrap purelymail-dashboard">
        <style>
            .purelymail-dashboard { max-width: 1180px; margin: 24px 24px 40px 0; color: #182230; }
            .purelymail-heading { display: flex; align-items: center; gap: 14px; margin: 16px 0 8px; }
            .purelymail-heading__icon { display: grid; place-items: center; width: 46px; height: 46px; flex: 0 0 46px; border-radius: 14px; color: #fff; background: linear-gradient(145deg, #4263eb, #7048e8); box-shadow: 0 5px 14px rgba(66, 99, 235, .2); }
            .purelymail-heading h1 { margin: 0; padding: 0; color: #182230; font-size: 25px; line-height: 1.25; font-weight: 650; }
            .purelymail-heading p { margin: 5px 0 0; color: #667085; font-size: 13px; }
            .purelymail-heading__action { margin-left: auto; }
            .purelymail-overview { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin: 24px 0 28px; padding: 18px 22px; border: 1px solid #dce4f0; border-radius: 12px; background: linear-gradient(110deg, #f7f9ff, #fff); }
            .purelymail-overview__status { display: flex; align-items: center; gap: 12px; }
            .purelymail-status-dot { width: 11px; height: 11px; flex: 0 0 11px; border-radius: 50%; background: #98a2b3; box-shadow: 0 0 0 4px #eaecf0; }
            .purelymail-overview.is-ready .purelymail-status-dot { background: #12b76a; box-shadow: 0 0 0 4px #d1fadf; }
            .purelymail-overview strong { display: block; color: #182230; font-size: 14px; }
            .purelymail-overview small { display: block; margin-top: 3px; color: #667085; font-size: 12px; }
            .purelymail-encryption-badge { display: inline-flex; align-items: center; gap: 7px; padding: 7px 11px; border: 1px solid #d0d5dd; border-radius: 999px; color: #344054; background: #fff; font-size: 12px; font-weight: 600; white-space: nowrap; }
            .purelymail-section-heading { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin: 0 0 12px; }
            .purelymail-section-heading h2 { margin: 0; color: #182230; font-size: 17px; font-weight: 650; }
            .purelymail-section-heading p { margin: 4px 0 0; color: #667085; font-size: 12px; }
            .purelymail-connections { display: grid; gap: 14px; }
            .purelymail-connection-card { overflow: hidden; border: 1px solid #dfe3eb; border-radius: 12px; background: #fff; box-shadow: 0 2px 7px rgba(16, 24, 40, .04); transition: border-color .15s ease, box-shadow .15s ease; }
            .purelymail-connection-card.is-active { border-color: #8098f9; box-shadow: 0 0 0 2px rgba(66, 99, 235, .11), 0 4px 12px rgba(16, 24, 40, .05); }
            .purelymail-connection-card__header { display: flex; align-items: center; gap: 12px; padding: 16px 19px; border-bottom: 1px solid #eaecf0; background: #fcfcfd; }
            .purelymail-select-active { display: flex; align-items: center; gap: 10px; min-width: 0; cursor: pointer; }
            .purelymail-select-active input { margin: 0; }
            .purelymail-card-title { min-width: 0; }
            .purelymail-card-title strong { display: block; overflow: hidden; color: #182230; font-size: 14px; text-overflow: ellipsis; white-space: nowrap; }
            .purelymail-card-title small { display: block; overflow: hidden; margin-top: 3px; color: #667085; font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
            .purelymail-current-badge { display: none; margin-left: 4px; padding: 4px 8px; border-radius: 999px; color: #175cd3; background: #eff8ff; font-size: 11px; font-weight: 600; white-space: nowrap; }
            .is-active .purelymail-current-badge { display: inline-flex; }
            .purelymail-remove { margin-left: auto !important; color: #b42318 !important; }
            .purelymail-connection-card__body { padding: 18px 19px 20px; }
            .purelymail-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 20px; }
            .purelymail-field { min-width: 0; }
            .purelymail-field label { display: block; margin: 0 0 6px; color: #344054; font-size: 12px; font-weight: 600; }
            .purelymail-field input, .purelymail-field select { box-sizing: border-box; width: 100%; max-width: none; min-height: 40px; border: 1px solid #d0d5dd; border-radius: 7px; padding: 8px 11px; color: #182230; background-color: #fff; box-shadow: 0 1px 2px rgba(16, 24, 40, .04); }
            .purelymail-field input:focus, .purelymail-field select:focus { border-color: #8098f9; box-shadow: 0 0 0 3px rgba(66, 99, 235, .13); outline: none; }
            .purelymail-field__help { display: block; margin-top: 6px; color: #667085; font-size: 11px; line-height: 1.45; }
            .purelymail-secure-field { display: flex; align-items: center; gap: 8px; min-height: 40px; box-sizing: border-box; padding: 8px 11px; border: 1px solid #eaecf0; border-radius: 7px; color: #475467; background: #f9fafb; font-size: 12px; }
            .purelymail-secure-field strong { color: #344054; font-weight: 600; }
            .purelymail-empty { padding: 34px 20px; border: 1px dashed #cfd6e4; border-radius: 12px; text-align: center; background: #fff; }
            .purelymail-empty strong { display: block; margin-bottom: 5px; color: #344054; font-size: 14px; }
            .purelymail-empty p { margin: 0 0 15px; color: #667085; font-size: 12px; }
            .purelymail-footer { display: flex; align-items: center; justify-content: space-between; gap: 18px; margin-top: 18px; padding: 15px 18px; border: 1px solid #dfe3eb; border-radius: 10px; background: #fff; }
            .purelymail-footer p { margin: 0; color: #667085; font-size: 12px; }
            .purelymail-footer .button { min-height: 38px; padding: 0 17px; }
            .purelymail-dashboard .notice { margin: 14px 0; border-radius: 7px; }
            @media (max-width: 782px) {
                .purelymail-dashboard { margin-right: 12px; }
                .purelymail-heading { align-items: flex-start; }
                .purelymail-heading__action { display: none; }
                .purelymail-overview { align-items: flex-start; flex-direction: column; }
                .purelymail-section-heading { align-items: flex-start; }
                .purelymail-section-heading > .button { display: none; }
            }
            @media (max-width: 600px) {
                .purelymail-fields { grid-template-columns: 1fr; }
                .purelymail-connection-card__header { align-items: flex-start; flex-wrap: wrap; }
                .purelymail-current-badge { margin-left: 0; }
                .purelymail-remove { align-self: center; }
                .purelymail-footer { align-items: stretch; flex-direction: column; }
                .purelymail-footer .button { width: 100%; }
            }
        </style>

        <header class="purelymail-heading">
            <div class="purelymail-heading__icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3.75 6.75h16.5v10.5H3.75V6.75Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="m4.5 7.5 7.5 6 7.5-6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </div>
            <div>
                <h1><?php esc_html_e('Purelymail SMTP', 'purelymail-smtp'); ?></h1>
                <p><?php esc_html_e('Manage the sender accounts WordPress and WooCommerce use for outgoing email.', 'purelymail-smtp'); ?></p>
            </div>
            <div class="purelymail-heading__action">
                <button type="button" class="button" data-purelymail-add><?php esc_html_e('＋ Add sender', 'purelymail-smtp'); ?></button>
            </div>
        </header>

        <?php settings_errors(PURELYMAIL_SMTP_OPTION); ?>

        <section class="purelymail-overview <?php echo $active_connection ? 'is-ready' : ''; ?>" id="purelymail-overview" aria-live="polite">
            <div class="purelymail-overview__status">
                <span class="purelymail-status-dot" aria-hidden="true"></span>
                <div>
                    <strong id="purelymail-active-label"><?php echo esc_html($active_label); ?></strong>
                    <small><?php esc_html_e('Default sender for WordPress and WooCommerce email', 'purelymail-smtp'); ?></small>
                </div>
            </div>
            <span class="purelymail-encryption-badge"><span aria-hidden="true">🔒</span> <?php esc_html_e('Encrypted SMTP only', 'purelymail-smtp'); ?></span>
        </section>

        <form action="options.php" method="post" id="purelymail-smtp-form">
            <?php settings_fields('purelymail_smtp_settings_group'); ?>

            <div class="purelymail-section-heading">
                <div>
                    <h2><?php esc_html_e('Sender accounts', 'purelymail-smtp'); ?></h2>
                    <p><?php esc_html_e('Choose the default sender, or add separate accounts for different email addresses.', 'purelymail-smtp'); ?></p>
                </div>
                <button type="button" class="button" data-purelymail-add><?php esc_html_e('＋ Add sender', 'purelymail-smtp'); ?></button>
            </div>

            <div id="purelymail-smtp-connections" class="purelymail-connections">
                <?php foreach ($settings['connections'] as $id => $connection) : ?>
                    <?php purelymail_smtp_render_connection((string) $id, $connection); ?>
                <?php endforeach; ?>
            </div>

            <?php if (!$settings['connections']) : ?>
                <div class="purelymail-empty" id="purelymail-empty">
                    <strong><?php esc_html_e('No sender accounts yet', 'purelymail-smtp'); ?></strong>
                    <p><?php esc_html_e('Add your Purelymail email and SMTP credentials to get started.', 'purelymail-smtp'); ?></p>
                    <button type="button" class="button button-primary" data-purelymail-add><?php esc_html_e('Add your first sender', 'purelymail-smtp'); ?></button>
                </div>
            <?php endif; ?>

            <div class="purelymail-footer">
                <p><?php esc_html_e('Server: smtp.purelymail.com · TLS on port 587 or SSL on port 465. Passwords are encrypted in the database.', 'purelymail-smtp'); ?></p>
                <button type="submit" class="button button-primary"><?php esc_html_e('Save changes', 'purelymail-smtp'); ?></button>
            </div>
        </form>
    </div>
    <template id="purelymail-smtp-template">
        <?php purelymail_smtp_render_connection('__INDEX__', []); ?>
    </template>
    <script>
    (function () {
        var list = document.getElementById('purelymail-smtp-connections');
        var template = document.getElementById('purelymail-smtp-template');
        var overview = document.getElementById('purelymail-overview');
        var activeLabel = document.getElementById('purelymail-active-label');
        var empty = document.getElementById('purelymail-empty');
        if (!list || !template || !overview || !activeLabel) return;

        function refreshActive() {
            var selected = list.querySelector('input[name="<?php echo esc_js(PURELYMAIL_SMTP_OPTION); ?>[active_connection]"]:checked');
            var cards = list.querySelectorAll('.purelymail-connection-card');
            cards.forEach(function (card) {
                var checked = card.querySelector('input[name="<?php echo esc_js(PURELYMAIL_SMTP_OPTION); ?>[active_connection]"]').checked;
                card.classList.toggle('is-active', checked);
            });
            if (selected) {
                var current = selected.closest('.purelymail-connection-card');
                var name = current.querySelector('[data-field="name"]').value || 'Purelymail sender';
                var email = current.querySelector('[data-field="from_email"]').value;
                activeLabel.textContent = name + (email ? ' — ' + email : '');
                overview.classList.add('is-ready');
            } else {
                activeLabel.textContent = '<?php echo esc_js(__('No active sender selected', 'purelymail-smtp')); ?>';
                overview.classList.remove('is-ready');
            }
        }

        document.querySelectorAll('[data-purelymail-add]').forEach(function (button) {
            button.addEventListener('click', function () {
            var id = 'new_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
            var html = template.innerHTML.replace(/__INDEX__/g, id);
            var wrapper = document.createElement('div');
            wrapper.innerHTML = html;
            var panel = wrapper.firstElementChild;
            list.appendChild(panel);
            if (empty) empty.hidden = true;
            panel.querySelector('input[name*="[active_connection]"]').checked = true;
            refreshActive();
            panel.querySelector('[data-field="name"]').focus();
            });
        });

        list.addEventListener('click', function (event) {
            var button = event.target.closest('.purelymail-smtp-remove');
            if (!button) return;
            var panel = button.closest('.purelymail-smtp-connection');
            var wasActive = panel.querySelector('input[name*="[active_connection]"]').checked;
            if (!window.confirm('<?php echo esc_js(__('Remove this sender account? Save changes to apply the removal.', 'purelymail-smtp')); ?>')) return;
            panel.remove();
            if (wasActive) {
                var next = list.querySelector('.purelymail-connection-card input[name*="[active_connection]"]');
                if (next) next.checked = true;
            }
            if (empty && !list.querySelector('.purelymail-connection-card')) empty.hidden = false;
            refreshActive();
        });

        list.addEventListener('input', function (event) {
            if (!event.target.matches('[data-field="name"], [data-field="from_email"]')) return;
            var panel = event.target.closest('.purelymail-smtp-connection');
            panel.querySelector('.purelymail-card-title strong').textContent = panel.querySelector('[data-field="name"]').value || 'New sender';
            panel.querySelector('.purelymail-card-title small').textContent = panel.querySelector('[data-field="from_email"]').value || 'Add a sender email address';
            refreshActive();
        });

        list.addEventListener('change', function (event) {
            if (event.target.matches('input[name*="[active_connection]"]')) refreshActive();
        });
        refreshActive();
    }());
    </script>
    <?php
}

/** Output one editable SMTP connection panel. */
function purelymail_smtp_render_connection_legacy(string $id, array $connection): void {
    $prefix = PURELYMAIL_SMTP_OPTION . '[connections][' . $id . ']';
    $security = isset($connection['security']) && $connection['security'] === 'ssl' ? 'ssl' : 'tls';
    $has_password = !empty($connection['password']);
    $name = isset($connection['name']) ? (string) $connection['name'] : '';
    $email = isset($connection['from_email']) ? (string) $connection['from_email'] : '';
    $active = purelymail_smtp_settings()['active_connection'] === $id;
    ?>
    <section class="purelymail-connection-card purelymail-smtp-connection<?php echo $active ? ' is-active' : ''; ?>" data-id="<?php echo esc_attr($id); ?>">
        <div class="purelymail-connection-card__header">
            <label class="purelymail-select-active">
                <input type="radio" name="<?php echo esc_attr(PURELYMAIL_SMTP_OPTION); ?>[active_connection]" value="<?php echo esc_attr($id); ?>" <?php checked($active); ?> aria-label="<?php echo esc_attr(sprintf(__('Use %s for outgoing email', 'purelymail-smtp'), $name ?: __('this sender', 'purelymail-smtp'))); ?>" />
                <span class="purelymail-card-title">
                    <strong><?php echo esc_html($name ?: __('New sender', 'purelymail-smtp')); ?></strong>
                    <small><?php echo esc_html($email ?: __('Add a sender email address', 'purelymail-smtp')); ?></small>
                </span>
                <span class="purelymail-current-badge"><?php esc_html_e('Default sender', 'purelymail-smtp'); ?></span>
            </label>
            <button type="button" class="button-link purelymail-remove purelymail-smtp-remove"><?php esc_html_e('Remove', 'purelymail-smtp'); ?></button>
        </div>
        <div class="purelymail-connection-card__body">
            <div class="purelymail-fields">
                <div class="purelymail-field">
                    <label><?php esc_html_e('Account name', 'purelymail-smtp'); ?></label>
                    <input data-field="name" type="text" name="<?php echo esc_attr($prefix); ?>[name]" value="<?php echo esc_attr($name); ?>" placeholder="<?php echo esc_attr__('e.g. Store support', 'purelymail-smtp'); ?>" required />
                </div>
                <div class="purelymail-field">
                    <label><?php esc_html_e('From email', 'purelymail-smtp'); ?></label>
                    <input data-field="from_email" type="email" name="<?php echo esc_attr($prefix); ?>[from_email]" value="<?php echo esc_attr($email); ?>" placeholder="hello@example.com" required />
                </div>
                <div class="purelymail-field">
                    <label><?php esc_html_e('From name', 'purelymail-smtp'); ?></label>
                    <input type="text" name="<?php echo esc_attr($prefix); ?>[from_name]" value="<?php echo esc_attr(isset($connection['from_name']) ? $connection['from_name'] : ''); ?>" placeholder="Your store name" />
                </div>
                <div class="purelymail-field">
                    <label><?php esc_html_e('SMTP username', 'purelymail-smtp'); ?></label>
                    <input type="text" name="<?php echo esc_attr($prefix); ?>[username]" value="<?php echo esc_attr(isset($connection['username']) ? $connection['username'] : ''); ?>" autocomplete="username" required />
                </div>
                <div class="purelymail-field">
                    <label><?php esc_html_e('SMTP password', 'purelymail-smtp'); ?></label>
                    <input type="password" name="<?php echo esc_attr($prefix); ?>[password]" value="" autocomplete="new-password" placeholder="<?php echo esc_attr($has_password ? __('Leave blank to keep saved password', 'purelymail-smtp') : __('Enter SMTP password', 'purelymail-smtp')); ?>" <?php echo $has_password ? '' : 'required'; ?> />
                    <span class="purelymail-field__help"><?php echo $has_password ? esc_html__('Password is saved encrypted. Enter a new value only to replace it.', 'purelymail-smtp') : esc_html__('It will be encrypted in the database and never shown again.', 'purelymail-smtp'); ?></span>
                </div>
                <div class="purelymail-field">
                    <label><?php esc_html_e('Connection security', 'purelymail-smtp'); ?></label>
                    <select name="<?php echo esc_attr($prefix); ?>[security]">
                        <option value="tls" <?php selected($security, 'tls'); ?>><?php esc_html_e('TLS (STARTTLS) · port 587', 'purelymail-smtp'); ?></option>
                        <option value="ssl" <?php selected($security, 'ssl'); ?>><?php esc_html_e('SSL · port 465', 'purelymail-smtp'); ?></option>
                    </select>
                    <span class="purelymail-field__help"><?php esc_html_e('Encryption is always enabled.', 'purelymail-smtp'); ?></span>
                </div>
                <div class="purelymail-field">
                    <label><?php esc_html_e('SMTP server', 'purelymail-smtp'); ?></label>
                    <div class="purelymail-secure-field"><strong>smtp.purelymail.com</strong><span>·</span><?php esc_html_e('Purelymail server', 'purelymail-smtp'); ?></div>
                </div>
            </div>
        </div>
    </section>
    <?php
}

/** Render the compact account list and single-account editor. */
function purelymail_smtp_render_settings_page(): void {
    if (!current_user_can('manage_options')) {
        return;
    }

    $settings = purelymail_smtp_settings();
    $page_url = admin_url('options-general.php?page=purelymail-smtp');
    $screen = isset($_GET['action']) ? sanitize_key((string) wp_unslash($_GET['action'])) : 'list';
    $id = isset($_GET['id']) ? sanitize_key((string) wp_unslash($_GET['id'])) : '';
    $is_editor = $screen === 'add' || $screen === 'edit';
    $is_existing = $screen === 'edit' && $id !== '' && isset($settings['connections'][$id]);
    if ($screen === 'add' && $id === '') {
        $id = 'pm_' . str_replace('-', '', wp_generate_uuid4());
    }
    $new_id = 'pm_' . str_replace('-', '', wp_generate_uuid4());

    ?>
    <div class="wrap pm-wrap">
        <style>
            .pm-wrap { max-width: 1050px; margin-top: 22px; }
            .pm-head { display: flex; align-items: center; justify-content: space-between; gap: 20px; margin: 0 0 18px; }
            .pm-head h1 { margin: 0; padding: 0; font-size: 23px; font-weight: 600; }
            .pm-head p { margin: 5px 0 0; color: #646970; }
            .pm-mail-status { margin: 18px 0; padding: 10px 14px; border: 1px solid #c3c4c7; border-left: 4px solid #2271b1; background: #fff; }
            .pm-mail-status strong { font-weight: 600; }
            .pm-table { margin-top: 14px; }
            .pm-table .pm-default-col { width: 72px; text-align: center; }
            .pm-table .pm-transport-col { width: 145px; }
            .pm-table .pm-actions-col { width: 140px; white-space: nowrap; }
            .pm-sender-name { display: block; font-weight: 600; }
            .pm-sender-email { display: block; margin-top: 3px; color: #646970; }
            .pm-table input[type="radio"] { margin: 0; }
            .pm-empty { padding: 24px; border: 1px solid #c3c4c7; background: #fff; }
            .pm-empty p { margin: 0 0 14px; }
            .pm-editor { max-width: 760px; padding: 18px 22px; border: 1px solid #c3c4c7; background: #fff; }
            .pm-editor h2 { margin: 0 0 5px; font-size: 18px; }
            .pm-editor > p { margin: 0 0 12px; color: #646970; }
            .pm-editor .form-table { margin-top: 8px; }
            .pm-editor .form-table th { width: 190px; padding: 14px 10px 14px 0; }
            .pm-editor .form-table td { padding: 10px; }
            .pm-editor .regular-text { width: 100%; max-width: 420px; }
            .pm-editor .description { margin-top: 5px; }
            .pm-editor-actions { display: flex; align-items: center; gap: 14px; padding-top: 12px; border-top: 1px solid #dcdcde; }
            .pm-editor-actions .submit { margin: 0; padding: 0; }
            .pm-back { display: inline-block; margin: 0 0 14px; text-decoration: none; }
            @media (max-width: 782px) {
                .pm-head { align-items: flex-start; }
                .pm-table .pm-transport-col { width: auto; }
                .pm-editor .form-table th, .pm-editor .form-table td { display: block; width: auto; padding: 8px 0; }
                .pm-editor .form-table th { padding-bottom: 0; }
            }
        </style>

        <header class="pm-head">
            <div>
                <h1><?php esc_html_e('Purelymail SMTP', 'purelymail-smtp'); ?></h1>
                <p><?php esc_html_e('Sender accounts used by WordPress and WooCommerce email.', 'purelymail-smtp'); ?></p>
            </div>
            <?php if ($is_editor) : ?>
                <a class="button" href="<?php echo esc_url($page_url); ?>"><?php esc_html_e('Back to sender accounts', 'purelymail-smtp'); ?></a>
            <?php else : ?>
                <a class="button button-primary" href="<?php echo esc_url(add_query_arg(['page' => 'purelymail-smtp', 'action' => 'add', 'id' => $new_id], admin_url('options-general.php'))); ?>"><?php esc_html_e('Add sender', 'purelymail-smtp'); ?></a>
            <?php endif; ?>
        </header>

        <?php settings_errors(PURELYMAIL_SMTP_OPTION); ?>

        <?php if (isset($_GET['removed']) && $_GET['removed'] === '1') : ?>
            <div class="notice notice-success is-dismissible"><p><?php esc_html_e('Sender account removed.', 'purelymail-smtp'); ?></p></div>
        <?php endif; ?>

        <?php if ($is_editor) : ?>
            <?php if ($screen === 'edit' && !$is_existing) : ?>
                <div class="notice notice-error"><p><?php esc_html_e('That sender account could not be found.', 'purelymail-smtp'); ?></p></div>
            <?php else : ?>
                <a class="pm-back" href="<?php echo esc_url($page_url); ?>">← <?php esc_html_e('All sender accounts', 'purelymail-smtp'); ?></a>
                <section class="pm-editor">
                    <h2><?php echo $screen === 'edit' ? esc_html__('Edit sender', 'purelymail-smtp') : esc_html__('Add sender', 'purelymail-smtp'); ?></h2>
                    <p><?php esc_html_e('Enter the sender identity and Purelymail SMTP login for this account.', 'purelymail-smtp'); ?></p>
                    <form action="options.php" method="post">
                        <?php settings_fields('purelymail_smtp_settings_group'); ?>
                        <?php
                        $connection = $is_existing ? $settings['connections'][$id] : [];
                        purelymail_smtp_render_connection($id, $connection);
                        ?>
                        <div class="pm-editor-actions">
                            <?php submit_button(__('Save sender', 'purelymail-smtp'), 'primary', 'submit', false); ?>
                            <a href="<?php echo esc_url($page_url); ?>"><?php esc_html_e('Cancel', 'purelymail-smtp'); ?></a>
                        </div>
                    </form>
                </section>
            <?php endif; ?>
        <?php else : ?>
            <?php
            $active = isset($settings['connections'][$settings['active_connection']])
                ? $settings['connections'][$settings['active_connection']]
                : null;
            ?>
            <div class="pm-mail-status">
                <?php if ($active) : ?>
                    <strong><?php esc_html_e('Default sender:', 'purelymail-smtp'); ?></strong>
                    <?php echo esc_html($active['name'] . ' — ' . $active['from_email']); ?>
                <?php else : ?>
                    <strong><?php esc_html_e('No default sender selected.', 'purelymail-smtp'); ?></strong>
                    <?php esc_html_e('Add a sender account to enable WordPress and WooCommerce email.', 'purelymail-smtp'); ?>
                <?php endif; ?>
                <span> · <?php esc_html_e('Encrypted SMTP only', 'purelymail-smtp'); ?></span>
            </div>

            <?php if ($settings['connections']) : ?>
                <form action="options.php" method="post">
                    <?php settings_fields('purelymail_smtp_settings_group'); ?>
                    <table class="widefat striped pm-table">
                        <thead>
                            <tr>
                                <th class="pm-default-col"><?php esc_html_e('Default', 'purelymail-smtp'); ?></th>
                                <th><?php esc_html_e('Sender account', 'purelymail-smtp'); ?></th>
                                <th class="pm-transport-col"><?php esc_html_e('Encrypted connection', 'purelymail-smtp'); ?></th>
                                <th class="pm-actions-col"><?php esc_html_e('Actions', 'purelymail-smtp'); ?></th>
                            </tr>
                        </thead>
                        <tbody>
                            <?php foreach ($settings['connections'] as $connection_id => $connection) : ?>
                                <?php
                                $connection_id = (string) $connection_id;
                                $edit_url = add_query_arg(
                                    ['page' => 'purelymail-smtp', 'action' => 'edit', 'id' => $connection_id],
                                    admin_url('options-general.php')
                                );
                                $delete_url = wp_nonce_url(
                                    add_query_arg(
                                        ['action' => 'purelymail_smtp_delete_connection', 'id' => $connection_id],
                                        admin_url('admin-post.php')
                                    ),
                                    'purelymail_smtp_delete_' . $connection_id
                                );
                                $is_active = $settings['active_connection'] === $connection_id;
                                ?>
                                <tr>
                                    <td class="pm-default-col">
                                        <input type="radio" name="<?php echo esc_attr(PURELYMAIL_SMTP_OPTION); ?>[active_connection]" value="<?php echo esc_attr($connection_id); ?>" <?php checked($is_active); ?> aria-label="<?php echo esc_attr(sprintf(__('Make %s the default sender', 'purelymail-smtp'), $connection['name'])); ?>" />
                                    </td>
                                    <td>
                                        <span class="pm-sender-name"><?php echo esc_html($connection['name']); ?></span>
                                        <span class="pm-sender-email"><?php echo esc_html($connection['from_email']); ?></span>
                                    </td>
                                    <td><?php echo $connection['security'] === 'ssl' ? esc_html__('SSL · port 465', 'purelymail-smtp') : esc_html__('TLS · port 587', 'purelymail-smtp'); ?></td>
                                    <td class="pm-actions-col">
                                        <a href="<?php echo esc_url($edit_url); ?>"><?php esc_html_e('Edit', 'purelymail-smtp'); ?></a>
                                        <span aria-hidden="true"> | </span>
                                        <a href="<?php echo esc_url($delete_url); ?>" class="submitdelete"><?php esc_html_e('Remove', 'purelymail-smtp'); ?></a>
                                    </td>
                                </tr>
                            <?php endforeach; ?>
                        </tbody>
                    </table>
                    <p class="submit"><button type="submit" class="button button-primary"><?php esc_html_e('Save default sender', 'purelymail-smtp'); ?></button></p>
                </form>
            <?php else : ?>
                <div class="pm-empty">
                    <p><?php esc_html_e('No sender accounts have been added yet.', 'purelymail-smtp'); ?></p>
                    <a class="button button-primary" href="<?php echo esc_url(add_query_arg(['page' => 'purelymail-smtp', 'action' => 'add', 'id' => $new_id], admin_url('options-general.php'))); ?>"><?php esc_html_e('Add your first sender', 'purelymail-smtp'); ?></a>
                </div>
            <?php endif; ?>
            <p class="description"><?php esc_html_e('Purelymail server: smtp.purelymail.com. TLS uses port 587; SSL uses port 465. Passwords are encrypted in the database.', 'purelymail-smtp'); ?></p>

            <?php
            $test_state = isset($_GET['pm_test']) ? sanitize_key((string) wp_unslash($_GET['pm_test'])) : '';
            $test_error = (string) get_transient('purelymail_smtp_test_error');
            if ($test_state !== '') {
                delete_transient('purelymail_smtp_test_error');
                $messages = [
                    'ok'        => ['notice-success', __('Test email sent. Check the inbox of the address you entered (and spam).', 'purelymail-smtp')],
                    'error'     => ['notice-error', __('The test email failed.', 'purelymail-smtp') . ($test_error !== '' ? ' ' . $test_error : '')],
                    'invalid'   => ['notice-error', __('Enter a valid email address to send the test to.', 'purelymail-smtp')],
                    'no_sender' => ['notice-error', __('Choose a default sender with a saved password first.', 'purelymail-smtp')],
                ];
                if (isset($messages[$test_state])) {
                    printf('<div class="notice %s inline"><p>%s</p></div>', esc_attr($messages[$test_state][0]), esc_html($messages[$test_state][1]));
                }
            }
            ?>
            <h2><?php esc_html_e('Send a test email', 'purelymail-smtp'); ?></h2>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" style="max-width:1050px">
                <input type="hidden" name="action" value="purelymail_smtp_send_test" />
                <?php wp_nonce_field('purelymail_smtp_send_test'); ?>
                <label for="pm-test-to"><?php esc_html_e('Send to', 'purelymail-smtp'); ?></label>
                <input id="pm-test-to" type="email" name="to" class="regular-text" value="<?php echo esc_attr(wp_get_current_user()->user_email); ?>" required />
                <?php submit_button(__('Send test email', 'purelymail-smtp'), 'secondary', 'submit', false); ?>
                <p class="description"><?php esc_html_e('Uses the default sender above, exactly like order and account emails.', 'purelymail-smtp'); ?></p>
            </form>

            <?php purelymail_smtp_render_log(); ?>
        <?php endif; ?>
    </div>
    <?php
}

/** Render one sender's editable fields. */
function purelymail_smtp_render_connection(string $id, array $connection): void {
    $prefix = PURELYMAIL_SMTP_OPTION . '[connections][' . $id . ']';
    $security = isset($connection['security']) && $connection['security'] === 'ssl' ? 'ssl' : 'tls';
    $has_password = !empty($connection['password']);
    $is_default = purelymail_smtp_settings()['active_connection'] === $id;
    ?>
    <table class="form-table" role="presentation">
        <tr>
            <th scope="row"><label for="pm-account-name"><?php esc_html_e('Account name', 'purelymail-smtp'); ?></label></th>
            <td><input id="pm-account-name" class="regular-text" type="text" name="<?php echo esc_attr($prefix); ?>[name]" value="<?php echo esc_attr(isset($connection['name']) ? $connection['name'] : ''); ?>" placeholder="<?php echo esc_attr__('e.g. Store support', 'purelymail-smtp'); ?>" required /></td>
        </tr>
        <tr>
            <th scope="row"><label for="pm-from-email"><?php esc_html_e('From email', 'purelymail-smtp'); ?></label></th>
            <td><input id="pm-from-email" class="regular-text" type="email" name="<?php echo esc_attr($prefix); ?>[from_email]" value="<?php echo esc_attr(isset($connection['from_email']) ? $connection['from_email'] : ''); ?>" placeholder="hello@example.com" required /></td>
        </tr>
        <tr>
            <th scope="row"><label for="pm-from-name"><?php esc_html_e('From name', 'purelymail-smtp'); ?></label></th>
            <td><input id="pm-from-name" class="regular-text" type="text" name="<?php echo esc_attr($prefix); ?>[from_name]" value="<?php echo esc_attr(isset($connection['from_name']) ? $connection['from_name'] : ''); ?>" /></td>
        </tr>
        <tr>
            <th scope="row"><label for="pm-reply-to"><?php esc_html_e('Reply-to email', 'purelymail-smtp'); ?></label></th>
            <td>
                <input id="pm-reply-to" class="regular-text" type="email" name="<?php echo esc_attr($prefix); ?>[reply_to]" value="<?php echo esc_attr(isset($connection['reply_to']) ? $connection['reply_to'] : ''); ?>" placeholder="<?php echo esc_attr__('Optional, defaults to the From email', 'purelymail-smtp'); ?>" />
            </td>
        </tr>
        <tr>
            <th scope="row"><label for="pm-smtp-username"><?php esc_html_e('SMTP username', 'purelymail-smtp'); ?></label></th>
            <td><input id="pm-smtp-username" class="regular-text" type="text" name="<?php echo esc_attr($prefix); ?>[username]" value="<?php echo esc_attr(isset($connection['username']) ? $connection['username'] : ''); ?>" autocomplete="username" required /></td>
        </tr>
        <tr>
            <th scope="row"><label for="pm-smtp-password"><?php esc_html_e('SMTP password', 'purelymail-smtp'); ?></label></th>
            <td>
                <input id="pm-smtp-password" class="regular-text" type="password" name="<?php echo esc_attr($prefix); ?>[password]" value="" autocomplete="new-password" placeholder="<?php echo esc_attr($has_password ? __('Leave blank to keep saved password', 'purelymail-smtp') : __('Enter SMTP password', 'purelymail-smtp')); ?>" <?php echo $has_password ? '' : 'required'; ?> />
                <p class="description"><?php echo $has_password ? esc_html__('Password is saved encrypted. Enter a new value only to replace it.', 'purelymail-smtp') : esc_html__('The password will be encrypted in the database and never shown again.', 'purelymail-smtp'); ?></p>
            </td>
        </tr>
        <tr>
            <th scope="row"><label for="pm-security"><?php esc_html_e('Encryption', 'purelymail-smtp'); ?></label></th>
            <td>
                <select id="pm-security" name="<?php echo esc_attr($prefix); ?>[security]">
                    <option value="tls" <?php selected($security, 'tls'); ?>><?php esc_html_e('TLS (STARTTLS) — port 587', 'purelymail-smtp'); ?></option>
                    <option value="ssl" <?php selected($security, 'ssl'); ?>><?php esc_html_e('SSL — port 465', 'purelymail-smtp'); ?></option>
                </select>
                <p class="description"><?php esc_html_e('Encryption is required for every connection.', 'purelymail-smtp'); ?></p>
            </td>
        </tr>
        <tr>
            <th scope="row"><?php esc_html_e('SMTP server', 'purelymail-smtp'); ?></th>
            <td><code>smtp.purelymail.com</code> <span class="description"><?php esc_html_e('Purelymail server; fixed to keep the connection secure.', 'purelymail-smtp'); ?></span></td>
        </tr>
        <tr>
            <th scope="row"><?php esc_html_e('Default sender', 'purelymail-smtp'); ?></th>
            <td>
                <label><input type="checkbox" name="<?php echo esc_attr(PURELYMAIL_SMTP_OPTION); ?>[active_connection]" value="<?php echo esc_attr($id); ?>" <?php checked($is_default || !purelymail_smtp_settings()['connections']); ?> /> <?php esc_html_e('Use this account for outgoing WordPress and WooCommerce email', 'purelymail-smtp'); ?></label>
            </td>
        </tr>
    </table>
    <?php
}

/** Get the selected, usable SMTP profile including its decrypted password. */
function purelymail_smtp_active_connection(): ?array {
    $settings = purelymail_smtp_settings();
    $id = $settings['active_connection'];
    if ($id === '' || !isset($settings['connections'][$id]) || !is_array($settings['connections'][$id])) {
        return null;
    }

    $connection = $settings['connections'][$id];
    $password = isset($connection['password']) ? purelymail_smtp_decrypt_password((string) $connection['password']) : false;
    if ($password === false || $password === '') {
        return null;
    }

    $connection['decrypted_password'] = $password;
    return $connection;
}

/** Fail closed rather than letting WordPress fall back to unencrypted PHP mail. */
add_filter('pre_wp_mail', function ($pre, $atts) {
    return purelymail_smtp_active_connection() ? $pre : false;
}, 1, 2);

/** WordPress sets the sender after phpmailer_init, so the sender must also come from these filters. */
add_filter('wp_mail_from', function ($from) {
    $connection = purelymail_smtp_active_connection();
    return $connection && is_email($connection['from_email']) ? $connection['from_email'] : $from;
}, 99);

add_filter('wp_mail_from_name', function ($name) {
    $connection = purelymail_smtp_active_connection();
    return $connection && $connection['from_name'] !== '' ? $connection['from_name'] : $name;
}, 99);

/** Configure WordPress's PHPMailer instance to use the active encrypted SMTP profile. */
add_action('phpmailer_init', function ($mailer) {
    $connection = purelymail_smtp_active_connection();
    if (!$connection) {
        return;
    }

    $is_ssl = $connection['security'] === 'ssl';
    $mailer->isSMTP();
    $mailer->Host = 'smtp.purelymail.com';
    $mailer->Port = $is_ssl ? 465 : 587;
    $mailer->SMTPSecure = $is_ssl ? 'ssl' : 'tls';
    $mailer->SMTPAutoTLS = !$is_ssl;
    $mailer->SMTPAuth = true;
    $mailer->Username = $connection['username'];
    $mailer->Password = $connection['decrypted_password'];
    $mailer->From = $connection['from_email'];
    $mailer->FromName = $connection['from_name'];
    $mailer->Sender = $connection['from_email'];
    if (!empty($connection['reply_to']) && is_email($connection['reply_to'])) {
        $mailer->clearReplyTos();
        $mailer->addReplyTo($connection['reply_to'], $connection['from_name']);
    }
}, 20);

/* -------------------------------------------------------------------------
 * Send log and test email
 * ---------------------------------------------------------------------- */

const PURELYMAIL_SMTP_LOG_OPTION = 'purelymail_smtp_log';
const PURELYMAIL_SMTP_LOG_MAX = 30;

/** Record one send attempt. Only metadata is stored, never the message body. */
function purelymail_smtp_log_add(string $status, array $data, string $error = ''): void {
    $recipients = isset($data['to']) ? (array) $data['to'] : [];
    $log = get_option(PURELYMAIL_SMTP_LOG_OPTION, []);
    $log = is_array($log) ? $log : [];

    array_unshift($log, [
        'time'    => time(),
        'status'  => $status,
        'to'      => sanitize_text_field(implode(', ', array_map('strval', $recipients))),
        'subject' => sanitize_text_field((string) ($data['subject'] ?? '')),
        'error'   => sanitize_text_field($error),
    ]);

    update_option(PURELYMAIL_SMTP_LOG_OPTION, array_slice($log, 0, PURELYMAIL_SMTP_LOG_MAX), false);
}

add_action('wp_mail_succeeded', function ($data) {
    purelymail_smtp_log_add('sent', (array) $data);
});

add_action('wp_mail_failed', function ($error) {
    $data = is_object($error) && method_exists($error, 'get_error_data') ? (array) ($error->get_error_data() ?: []) : [];
    $message = is_object($error) && method_exists($error, 'get_error_message') ? $error->get_error_message() : '';
    purelymail_smtp_log_add('failed', $data, $message);
    // Kept briefly so the test form can show the real SMTP reason.
    set_transient('purelymail_smtp_last_error', $message, 120);
});

/** Send a test message through the active sender and report the result on the settings page. */
add_action('admin_post_purelymail_smtp_send_test', 'purelymail_smtp_send_test');
function purelymail_smtp_send_test(): void {
    if (!current_user_can('manage_options')) {
        wp_die(esc_html__('You are not allowed to do this.', 'purelymail-smtp'));
    }
    check_admin_referer('purelymail_smtp_send_test');

    $to = isset($_POST['to']) ? sanitize_email((string) wp_unslash($_POST['to'])) : '';
    $back = admin_url('options-general.php?page=purelymail-smtp');

    if (!is_email($to)) {
        wp_safe_redirect(add_query_arg('pm_test', 'invalid', $back));
        exit;
    }
    if (!purelymail_smtp_active_connection()) {
        wp_safe_redirect(add_query_arg('pm_test', 'no_sender', $back));
        exit;
    }

    delete_transient('purelymail_smtp_last_error');
    $sent = wp_mail(
        $to,
        sprintf(__('Test email from %s', 'purelymail-smtp'), get_bloginfo('name')),
        sprintf(__("This is a test of the outgoing email settings.\n\nSent at: %s", 'purelymail-smtp'), wp_date('Y-m-d H:i:s T'))
    );

    $result = $sent ? 'ok' : 'error';
    if (!$sent) {
        set_transient('purelymail_smtp_test_error', (string) get_transient('purelymail_smtp_last_error'), 120);
    }
    wp_safe_redirect(add_query_arg('pm_test', $result, $back));
    exit;
}

/** Show the most recent send attempts on the settings page. */
function purelymail_smtp_render_log(): void {
    $log = get_option(PURELYMAIL_SMTP_LOG_OPTION, []);
    $log = is_array($log) ? $log : [];
    ?>
    <h2><?php esc_html_e('Recent email', 'purelymail-smtp'); ?></h2>
    <?php if (!$log) : ?>
        <p class="description"><?php esc_html_e('No email has been sent through this plugin yet.', 'purelymail-smtp'); ?></p>
    <?php else : ?>
        <table class="widefat striped" style="max-width:1050px">
            <thead><tr>
                <th><?php esc_html_e('Time', 'purelymail-smtp'); ?></th>
                <th><?php esc_html_e('Result', 'purelymail-smtp'); ?></th>
                <th><?php esc_html_e('To', 'purelymail-smtp'); ?></th>
                <th><?php esc_html_e('Subject', 'purelymail-smtp'); ?></th>
                <th><?php esc_html_e('SMTP message', 'purelymail-smtp'); ?></th>
            </tr></thead>
            <tbody>
            <?php foreach ($log as $entry) : ?>
                <tr>
                    <td><?php echo esc_html(wp_date('Y-m-d H:i:s', (int) $entry['time'])); ?></td>
                    <td><?php echo $entry['status'] === 'sent' ? esc_html__('Sent', 'purelymail-smtp') : '<strong>' . esc_html__('Failed', 'purelymail-smtp') . '</strong>'; ?></td>
                    <td><?php echo esc_html($entry['to']); ?></td>
                    <td><?php echo esc_html($entry['subject']); ?></td>
                    <td><?php echo esc_html($entry['error']); ?></td>
                </tr>
            <?php endforeach; ?>
            </tbody>
        </table>
    <?php endif; ?>
    <?php
}
