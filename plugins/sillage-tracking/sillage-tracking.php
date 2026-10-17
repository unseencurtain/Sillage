<?php
/**
 * Plugin Name: Sillage Tracking
 * Description: Emails the customer a branded "your parcel has shipped" message with the tracking number, and answers the storefront's public parcel lookup.
 * Version: 1.0.0
 * Requires at least: 5.7
 * Requires PHP: 7.4
 * License: GPL-2.0-or-later
 *
 * Where a tracking number comes from
 * ----------------------------------
 * The Sillage engine polls the two suppliers (BTS and BeautyFort) and POSTs the courier and the
 * tracking code to `/wp-json/sillage/v1/order-update`, served by the `sillage-bridge` plugin. That
 * plugin records every parcel in the `_sillage_tracking` order meta and adds a *customer* note, and
 * a customer note is what fires `woocommerce_new_customer_note`. This plugin listens on that same
 * action and sends its own email instead of WooCommerce's generic "note to customer".
 *
 * The two suppliers differ: BeautyFort also returns a tracking URL we can link, BTS returns only a
 * courier and a code. A parcel is therefore shown as a link only when the supplier gave us one.
 *
 * Why this is a separate plugin
 * -----------------------------
 * It is shop-specific wording and a shop-specific lookup endpoint. Keeping it out of
 * `purelymail-smtp` leaves the SMTP plugin portable, and it can be deactivated on its own without
 * touching the bridge that records the parcels.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! defined( 'SILLAGE_TRACKING_VERSION' ) ) {
	define( 'SILLAGE_TRACKING_VERSION', '1.0.0' );
}

require_once __DIR__ . '/class-sillage-tracking-lookup.php';

/**
 * Every parcel `sillage-bridge` has recorded on an order, normalised.
 *
 * @param WC_Order $order Order to read.
 * @return array<int, array<string, mixed>> Each parcel as vendor, courier, code, url, added.
 */
function sillage_tracking_parcels( WC_Order $order ): array {
	$stored = $order->get_meta( '_sillage_tracking' );
	if ( ! is_array( $stored ) ) {
		return array();
	}

	$parcels = array();
	foreach ( $stored as $entry ) {
		if ( ! is_array( $entry ) || empty( $entry['code'] ) ) {
			continue;
		}
		$parcels[] = array(
			'vendor'  => isset( $entry['vendor'] ) ? (string) $entry['vendor'] : '',
			'courier' => isset( $entry['courier'] ) ? (string) $entry['courier'] : '',
			'code'    => (string) $entry['code'],
			'url'     => isset( $entry['url'] ) ? (string) $entry['url'] : '',
			'added'   => isset( $entry['added'] ) ? (int) $entry['added'] : 0,
		);
	}

	return $parcels;
}

/**
 * Is this customer note the tracking note `sillage-bridge` writes?
 *
 * The note's wording is not a contract, so the test is the tracking code itself: the parcels
 * recorded on the order are the source of truth and the code appears verbatim in the note.
 *
 * @param WC_Order $order Order the note belongs to.
 * @param string   $note  Note text.
 * @return bool
 */
function sillage_tracking_note_is_tracking( WC_Order $order, string $note ): bool {
	if ( '' === trim( $note ) ) {
		return false;
	}

	foreach ( sillage_tracking_parcels( $order ) as $parcel ) {
		$code = (string) $parcel['code'];
		if ( '' !== $code && false !== strpos( $note, $code ) ) {
			return true;
		}
	}

	return false;
}

/**
 * The registered tracking email, or null when WooCommerce is not loaded.
 *
 * @return Sillage_Tracking_Email|null
 */
function sillage_tracking_email(): ?Sillage_Tracking_Email {
	if ( ! function_exists( 'WC' ) || ! WC()->mailer() ) {
		return null;
	}
	$emails = WC()->mailer()->get_emails();
	$email  = $emails['Sillage_Tracking_Email'] ?? null;

	return $email instanceof Sillage_Tracking_Email ? $email : null;
}

/**
 * Register the tracking email so it appears under WooCommerce > Settings > Emails.
 *
 * The class extends `WC_Email`, so its file can only be declared once WooCommerce has loaded.
 * WordPress includes plugin files in activation order, and this plugin is activated before
 * WooCommerce, so the file is loaded here instead of at the top of this one: by the time this
 * filter runs, WooCommerce is loaded whichever order the two were activated in.
 *
 * @param array<string, WC_Email> $emails Registered email classes, keyed by class name.
 * @return array<string, WC_Email>
 */
add_filter(
	'woocommerce_email_classes',
	static function ( array $emails ): array {
		if ( ! class_exists( 'Sillage_Tracking_Email' ) ) {
			require __DIR__ . '/class-sillage-tracking-email.php';
		}

		if ( class_exists( 'Sillage_Tracking_Email' ) ) {
			$emails['Sillage_Tracking_Email'] = new Sillage_Tracking_Email();
		}

		return $emails;
	}
);

/**
 * A parcel has shipped: send the tracking email.
 *
 * `sillage-bridge` adds the tracking note as a *customer* note, so this fires once per new parcel
 * and only when the operator's "notify customer" setting is on.
 *
 * @param array<string, mixed> $args `order_id` and `customer_note`.
 */
function sillage_tracking_on_customer_note( $args ): void {
	if ( ! is_array( $args ) || empty( $args['order_id'] ) ) {
		return;
	}

	$order = wc_get_order( (int) $args['order_id'] );
	if ( ! $order instanceof WC_Order ) {
		return;
	}

	$note = isset( $args['customer_note'] ) ? (string) $args['customer_note'] : '';
	if ( ! sillage_tracking_note_is_tracking( $order, $note ) ) {
		return;
	}

	$email = sillage_tracking_email();
	if ( ! $email ) {
		return;
	}

	$email->trigger( $order );
}
add_action( 'woocommerce_new_customer_note', 'sillage_tracking_on_customer_note', 5 );

/**
 * Skip WooCommerce's own "note to customer" email for a tracking note.
 *
 * The tracking email above carries the same news, and two emails for one parcel is noise. This is
 * skipped when the tracking email is switched off in the settings, so turning it off restores
 * WooCommerce's generic note rather than silencing the customer entirely.
 *
 * @param string        $recipient Billing address WooCommerce would send to.
 * @param mixed         $order     Order the note belongs to.
 * @param WC_Email|null $email     The email being prepared.
 * @return string
 */
function sillage_tracking_filter_customer_note_recipient( $recipient, $order, $email ) {
	if ( ! $order instanceof WC_Order ) {
		return $recipient;
	}
	if ( ! $email instanceof WC_Email_Customer_Note ) {
		return $recipient;
	}

	$tracking_email = sillage_tracking_email();
	if ( ! $tracking_email || ! $tracking_email->is_enabled() ) {
		return $recipient;
	}

	$note = isset( $email->customer_note ) ? (string) $email->customer_note : '';
	if ( sillage_tracking_note_is_tracking( $order, $note ) ) {
		return '';
	}

	return $recipient;
}
add_filter( 'woocommerce_email_recipient_customer_note', 'sillage_tracking_filter_customer_note_recipient', 10, 3 );

Sillage_Tracking_Lookup::register();
