<?php
/**
 * Plugin Name: Storefront Legal Guarantee Notice
 * Description: Adds the EU legal-guarantee (two-year conformity) notice to customer order emails.
 * Version: 1.0.0
 * Requires at least: 5.7
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 *
 * Why this is a separate plugin
 * -----------------------------
 * This is EU consumer-law wording that belongs only on shops that sell to EU customers. It is kept
 * out of `purelymail-smtp` so that the SMTP plugin stays portable: copy `purelymail-smtp` to another
 * WordPress site and no such notice appears there. Install and activate this plugin only where the
 * notice is wanted; where it is not installed, nothing is shown and nothing else changes.
 *
 * How it renders
 * --------------
 * The block is appended to the customer order emails with inline styles only, because most mail
 * clients strip <style> blocks. The illustration and the "official notice" link are built from the
 * shop's own origin (`home_url`), never a hard-coded host, so the same code is correct on every
 * deployment. The plain-text alternative is emitted when the email is sent as text.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action( 'woocommerce_email_after_order_table', 'storefront_legal_notice_email', 15, 4 );

/**
 * Append the legal-guarantee notice to customer order emails.
 *
 * @param mixed $order         Order being emailed. A WC_Order on WooCommerce order emails.
 * @param bool  $sent_to_admin Whether this copy goes to a shop administrator.
 * @param bool  $plain_text    Whether this is the plain-text alternative of the email.
 * @param mixed $email         The WC_Email instance handling the send.
 */
function storefront_legal_notice_email( $order, $sent_to_admin, $plain_text, $email ): void {
	// Consumer information: never send it to shop staff, and only ever alongside a real order.
	if ( $sent_to_admin || ! ( $order instanceof WC_Order ) ) {
		return;
	}

	// Customer-facing lifecycle emails only. New-order (admin), cancelled, refunded and failed
	// emails are intentionally left without the notice.
	$email_id = is_object( $email ) && isset( $email->id ) ? (string) $email->id : '';
	if ( ! in_array( $email_id, array( 'customer_processing_order', 'customer_on_hold_order', 'customer_completed_order' ), true ) ) {
		return;
	}

	// Both links point at the running shop, so the notice survives a domain change with no code edit.
	$notice_url = home_url( '/legal-pages/eu-legal-guarantee-notice-en.svg' );
	$more_url   = 'https://europa.eu/youreurope/guarantees';

	if ( $plain_text ) {
		echo "\n";
		echo "YOUR LEGAL GUARANTEE RIGHTS\n";
		echo "Goods bought in the EU have a minimum two-year legal guarantee of conformity; national law may provide a longer period.\n";
		echo 'Official EU notice: ' . esc_url( $notice_url ) . "\n";
		echo 'More information: ' . esc_url( $more_url ) . "\n";
		return;
	}

	echo '<div style="margin:24px 0;padding:18px;background:#f1f5fb;border-left:4px solid #164194;">';
	echo '<p style="margin:0 0 8px;"><strong>Your legal guarantee rights</strong></p>';
	echo '<p style="margin:0 0 12px;">Goods bought in the EU have a minimum two-year legal guarantee of conformity; national law may provide a longer period.</p>';
	echo '<p style="margin:0 0 12px;"><a href="' . esc_url( $notice_url ) . '">View the official EU harmonised notice</a> · <a href="' . esc_url( $more_url ) . '">Read more on Your Europe</a></p>';
	echo '<a href="' . esc_url( $notice_url ) . '"><img src="' . esc_url( $notice_url ) . '" width="420" alt="Official EU harmonised notice on the legal guarantee of conformity" style="display:block;width:100%;max-width:420px;height:auto;border:0;" /></a>';
	echo '</div>';
}
