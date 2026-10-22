<?php
/**
 * Plugin Name: Sillage Stripe hosted checkout
 * Description: A WooCommerce payment gateway that hands the shopper to Stripe's own
 *              Checkout page and marks the order paid from the Stripe webhook.
 * Version:     1.0.0
 *
 * Why this exists
 * ---------------
 * The storefront is headless, and mounting Stripe's Payment Element in our own checkout
 * means owning every payment method's state machine: redirects, vouchers, QR codes,
 * 3-D-Secure, delayed debits. Stripe's hosted Checkout does all of that itself, on one
 * page, in the shopper's language, and returns here.
 *
 * The order is created first, exactly as for any other WooCommerce gateway, so prices,
 * stock, shipping and the delivery country stay WooCommerce's answer. The gateway then
 * creates a Checkout Session for that order's own total and returns its URL. The order
 * is marked paid by the webhook (`?wc-api=sillage_checkout`), or immediately when the
 * shopper comes back through `/hosted/complete`.
 *
 * Routes (namespace sillage/v1):
 *   POST /hosted/complete -> { paid, intent_status, order_id, ... }
 *
 * Webhook:
 *   https://<shop>/?wc-api=sillage_checkout
 *
 * Authorisation
 * -------------
 * `/hosted/complete` needs the order key, the same 60-character secret WooCommerce puts
 * in an order-pay URL. The webhook needs a valid Stripe signature. Neither route returns
 * a secret key, an intent id or a client secret.
 */

defined( 'ABSPATH' ) || exit;

const SILLAGE_HOSTED_GATEWAY_ID      = 'sillage_checkout';
const SILLAGE_HOSTED_SETTINGS_OPTION = 'woocommerce_sillage_checkout_settings';
const SILLAGE_HOSTED_SESSION_META    = '_sillage_checkout_session_id';
const SILLAGE_HOSTED_INTENT_META     = '_sillage_checkout_payment_intent';
const SILLAGE_HOSTED_REST_NS         = 'sillage/v1';
const SILLAGE_HOSTED_ATTEMPT_KEY     = 'sillage_hosted_attempts_';
const SILLAGE_HOSTED_MAX_ATTEMPTS    = 60;
const SILLAGE_HOSTED_ATTEMPT_WINDOW  = 600;
const SILLAGE_HOSTED_WEBHOOK_OPTION  = 'sillage_hosted_webhook_endpoints';
const SILLAGE_HOSTED_WEBHOOK_API_VERSION = '2026-03-25.dahlia';

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** The official Stripe plugin's settings, which is where this shop keeps its API keys. */
function sillage_hosted_stripe_settings() {
	$settings = get_option( 'woocommerce_stripe_settings', array() );
	return is_array( $settings ) ? $settings : array();
}

/** 'test' or 'live', as the Stripe plugin is configured. */
function sillage_hosted_mode() {
	$settings = sillage_hosted_stripe_settings();
	return ( ! empty( $settings['testmode'] ) && 'yes' === $settings['testmode'] ) ? 'test' : 'live';
}

/** The secret key for the configured mode. Never leaves the server. */
function sillage_hosted_secret_key( $mode = null ) {
	$settings = sillage_hosted_stripe_settings();
	$mode     = 'test' === $mode || 'live' === $mode ? $mode : sillage_hosted_mode();
	$key      = 'test' === $mode ? 'test_secret_key' : 'secret_key';
	return isset( $settings[ $key ] ) ? trim( (string) $settings[ $key ] ) : '';
}

/**
 * The payment-method configuration the shop has chosen in the Stripe dashboard.
 *
 * Same ids as the card form uses: the account's own default configuration cannot be
 * written by this app, and these two belong to the account. An empty answer lets Stripe
 * fall back to the dashboard's dynamic methods, which is a safe answer, not a broken one.
 */
function sillage_hosted_payment_method_configuration() {
	$settings = sillage_hosted_stripe_settings();
	$key      = 'test' === sillage_hosted_mode() ? 'test_pmc_id' : 'pmc_id';
	if ( ! empty( $settings[ $key ] ) ) {
		return (string) $settings[ $key ];
	}
	return 'test' === sillage_hosted_mode() ? 'pmc_1UT29jGRoCUt5YKCvkWc49eS' : 'pmc_1UT2DZGRoCUt5YKCWHeOtWUH';
}

/**
 * One call to the Stripe API with the shop's own key.
 *
 * Kept independent of the Stripe plugin's classes: this gateway has to keep working when
 * that plugin is updated, deactivated or replaced.
 */
function sillage_hosted_api( $path, $method = 'POST', $data = array(), $query = array(), $mode = null ) {
	$key = sillage_hosted_secret_key( $mode );
	if ( '' === $key ) {
		return new WP_Error( 'sillage_hosted_no_key', 'Stripe is not configured.', array( 'status' => 503 ) );
	}

	$url = 'https://api.stripe.com/v1/' . ltrim( (string) $path, '/' );
	if ( $query ) {
		$url .= ( false === strpos( $url, '?' ) ? '?' : '&' ) . http_build_query( $query );
	}

	$args = array(
		'method'  => $method,
		'timeout' => 25,
		'headers' => array(
			'Authorization' => 'Bearer ' . $key,
		),
	);

	if ( 'POST' === $method ) {
		$args['headers']['Content-Type'] = 'application/x-www-form-urlencoded';
		$args['body']                    = http_build_query( $data );
	}

	$response = wp_remote_request( $url, $args );
	if ( is_wp_error( $response ) ) {
		return new WP_Error( 'sillage_hosted_stripe_unreachable', $response->get_error_message(), array( 'status' => 502 ) );
	}

	$status = (int) wp_remote_retrieve_response_code( $response );
	$body   = json_decode( (string) wp_remote_retrieve_body( $response ), true );

	if ( ! is_array( $body ) ) {
		return new WP_Error( 'sillage_hosted_stripe_bad_response', 'Stripe returned an unreadable response.', array( 'status' => 502 ) );
	}

	if ( $status >= 400 || isset( $body['error'] ) ) {
		$message = isset( $body['error']['message'] ) ? (string) $body['error']['message'] : 'Stripe refused the request.';
		return new WP_Error( 'sillage_hosted_stripe_error', $message, array( 'status' => 502 ) );
	}

	return $body;
}

/** The public address of a storefront route (no trailing slash, query kept verbatim). */
function sillage_hosted_storefront_url( $path ) {
	return untrailingslashit( home_url() ) . '/' . ltrim( (string) $path, '/' );
}

/**
 * The checkout page's language, passed by the storefront with the order.
 *
 * Stripe Checkout speaks most of the shop's languages but not Irish or Luxembourgish;
 * those two fall back to the browser's own language, which is the best available answer.
 */
function sillage_hosted_locale() {
	// The Store API forwards `payment_data` into $_POST before calling the gateway.
	// phpcs:ignore WordPress.Security.NonceVerification.Missing -- order key is checked by the Store API route.
	$lang = isset( $_POST['sillage_lang'] ) ? sanitize_text_field( wp_unslash( (string) $_POST['sillage_lang'] ) ) : '';
	$lang = strtolower( substr( $lang, 0, 2 ) );

	$supported = array( 'bg', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr', 'hr', 'hu', 'it', 'lt', 'lv', 'nl', 'pl', 'pt', 'ro', 'sk', 'sl', 'sv' );

	return in_array( $lang, $supported, true ) ? $lang : 'auto';
}

/** The order total in the currency's minor units, the way Stripe counts. */
function sillage_hosted_minor( $amount, $order ) {
	$factor = 10 ** wc_get_price_decimals();
	return (int) round( ( (float) $amount ) * $factor );
}

/**
 * The Checkout Session's line items.
 *
 * Each order line becomes one line on Stripe's page, priced at what the shopper was
 * actually charged for it (tax included). Quantity is folded into the name so every
 * line can carry an exact total in minor units; WooCommerce's own quantity cannot
 * represent a per-unit price that does not divide evenly. Shipping, fees and any
 * discount are then absorbed by the largest line, which keeps the session total equal
 * to the order total to the cent.
 */
function sillage_hosted_line_items( $order ) {
	$lines = array();

	foreach ( $order->get_items() as $item ) {
		$quantity = max( 1, (int) $item->get_quantity() );
		$amount   = sillage_hosted_minor( (float) $item->get_total() + (float) $item->get_total_tax(), $order );
		if ( $amount <= 0 ) {
			continue;
		}
		$name = (string) $item->get_name();
		if ( $quantity > 1 ) {
			/* translators: %1$s: product name, %2$d: quantity. */
			$name = sprintf( '%1$s x %2$d', $name, $quantity );
		}
		$lines[] = array(
			'name'   => $name,
			'amount' => $amount,
		);
	}

	$shipping = sillage_hosted_minor( (float) $order->get_shipping_total() + (float) $order->get_shipping_tax(), $order );
	if ( $shipping > 0 ) {
		$lines[] = array(
			'name'   => 'Shipping',
			'amount' => $shipping,
		);
	}

	foreach ( $order->get_fees() as $fee ) {
		$amount = sillage_hosted_minor( (float) $fee->get_total() + (float) $fee->get_total_tax(), $order );
		if ( $amount > 0 ) {
			$lines[] = array(
				'name'   => (string) $fee->get_name(),
				'amount' => $amount,
			);
		}
	}

	$target = sillage_hosted_minor( $order->get_total(), $order );
	if ( ! $lines || $target <= 0 ) {
		return new WP_Error( 'sillage_hosted_empty_order', 'This order has nothing to pay.', array( 'status' => 400 ) );
	}

	$sum   = array_sum( wp_list_pluck( $lines, 'amount' ) );
	$delta = $target - $sum;

	if ( 0 !== $delta ) {
		// Largest line first, so a discount never leaves a one-cent line behind.
		usort(
			$lines,
			static function ( $a, $b ) {
				return $b['amount'] <=> $a['amount'];
			}
		);

		foreach ( $lines as &$line ) {
			if ( 0 === $delta ) {
				break;
			}
			if ( $delta > 0 ) {
				$line['amount'] += $delta;
				$delta           = 0;
				continue;
			}
			$room = $line['amount'] - 1;
			if ( $room <= 0 ) {
				continue;
			}
			$take           = min( $room, -$delta );
			$line['amount'] -= $take;
			$delta          += $take;
		}
		unset( $line );
	}

	if ( 0 !== $delta ) {
		return new WP_Error( 'sillage_hosted_amount_mismatch', 'The order total could not be matched to its lines.', array( 'status' => 500 ) );
	}

	$items = array();
	foreach ( $lines as $line ) {
		$items[] = array(
			'quantity'   => 1,
			'price_data' => array(
				'currency'     => strtolower( (string) $order->get_currency() ),
				'unit_amount'  => (int) $line['amount'],
				'product_data' => array(
					'name' => (string) $line['name'],
				),
			),
		);
	}

	return $items;
}

/** Create a Checkout Session for one order, priced from that order. */
function sillage_hosted_create_session( $order ) {
	$items = sillage_hosted_line_items( $order );
	if ( is_wp_error( $items ) ) {
		return $items;
	}

	$order_id = $order->get_id();
	$success  = sillage_hosted_storefront_url( 'order-received/' . $order_id )
		. '?key=' . rawurlencode( (string) $order->get_order_key() )
		. '&session_id={CHECKOUT_SESSION_ID}';

	$data = array(
		'mode'                 => 'payment',
		'success_url'          => $success,
		'cancel_url'           => sillage_hosted_storefront_url( 'checkout/' ),
		'client_reference_id'  => (string) $order_id,
		'customer_email'       => (string) $order->get_billing_email(),
		'locale'               => sillage_hosted_locale(),
		'expires_at'           => time() + ( 30 * MINUTE_IN_SECONDS ),
		'line_items'           => $items,
		'metadata'             => array( 'order_id' => (string) $order_id ),
		'payment_intent_data'  => array(
			'metadata'    => array( 'order_id' => (string) $order_id ),
			'description' => 'Order ' . $order->get_order_number(),
		),
	);

	$configuration = sillage_hosted_payment_method_configuration();
	if ( '' !== $configuration ) {
		$data['payment_method_configuration'] = $configuration;
	}

	$session = sillage_hosted_api( 'checkout/sessions', 'POST', $data );

	// An account that cannot use the pinned configuration still has the dashboard's own
	// methods; losing the pin is better than losing the sale.
	if ( is_wp_error( $session ) && false !== stripos( $session->get_error_message(), 'payment_method_configuration' ) ) {
		unset( $data['payment_method_configuration'] );
		$session = sillage_hosted_api( 'checkout/sessions', 'POST', $data );
	}

	if ( is_wp_error( $session ) ) {
		return $session;
	}
	if ( empty( $session['id'] ) || empty( $session['url'] ) ) {
		return new WP_Error( 'sillage_hosted_no_session', 'Stripe did not return a checkout address.', array( 'status' => 502 ) );
	}

	return $session;
}

/**
 * The Checkout address for an order, reusing the open session when there is one.
 *
 * A shopper who reloads or presses Pay twice must land on the same Stripe page, not
 * create a second session for one order.
 */
function sillage_hosted_session_url( $order ) {
	$existing = (string) $order->get_meta( SILLAGE_HOSTED_SESSION_META );

	if ( '' !== $existing ) {
		$session = sillage_hosted_api( 'checkout/sessions/' . rawurlencode( $existing ), 'GET' );
		if ( ! is_wp_error( $session ) && 'open' === ( $session['status'] ?? '' ) && ! empty( $session['url'] ) ) {
			return (string) $session['url'];
		}
	}

	$session = sillage_hosted_create_session( $order );
	if ( is_wp_error( $session ) ) {
		return $session;
	}

	$order->update_meta_data( SILLAGE_HOSTED_SESSION_META, (string) $session['id'] );
	$order->add_order_note( 'Awaiting payment on Stripe Checkout.' );
	$order->save();

	return (string) $session['url'];
}

/** How the shopper actually paid, from the charge Stripe recorded. */
function sillage_hosted_label( $session ) {
	$details = null;
	$intent  = $session['payment_intent'] ?? null;

	if ( is_array( $intent ) ) {
		$charge = $intent['latest_charge'] ?? null;
		if ( is_array( $charge ) ) {
			$details = $charge['payment_method_details'] ?? null;
		}
	}

	if ( ! is_array( $details ) ) {
		return '';
	}

	$type = (string) ( $details['type'] ?? '' );

	if ( 'card' === $type ) {
		$brand = (string) ( $details['card']['brand'] ?? '' );
		return '' !== $brand ? ucfirst( $brand ) : 'Card';
	}

	$names = array(
		'ideal'         => 'iDEAL',
		'bancontact'    => 'Bancontact',
		'eps'           => 'EPS',
		'p24'           => 'Przelewy24',
		'klarna'        => 'Klarna',
		'alipay'        => 'Alipay',
		'multibanco'    => 'Multibanco',
		'wechat_pay'    => 'WeChat Pay',
		'sepa_debit'    => 'SEPA Direct Debit',
		'wero'          => 'Wero',
		'link'          => 'Link',
		'twint'         => 'Twint',
		'paypal'        => 'PayPal',
	);

	return $names[ $type ] ?? ucfirst( str_replace( '_', ' ', $type ) );
}

/**
 * Mark the order paid, once.
 *
 * The amount and currency are checked against the session before anything is completed:
 * a signed webhook is trusted for *what happened*, but the order is still the authority
 * on what it was supposed to cost.
 */
function sillage_hosted_mark_paid( $order, $session ) {
	if ( ! $order instanceof WC_Order ) {
		return new WP_Error( 'sillage_hosted_no_order', 'Order not found.', array( 'status' => 404 ) );
	}

	if ( $order->get_date_paid() ) {
		return true;
	}

	$expected = sillage_hosted_minor( $order->get_total(), $order );
	$actual   = (int) ( $session['amount_total'] ?? 0 );

	if ( $actual !== $expected ) {
		$order->add_order_note(
			sprintf( 'Stripe reported %1$d but the order total is %2$d. The order was not completed automatically.', $actual, $expected )
		);
		return new WP_Error( 'sillage_hosted_amount_mismatch', 'The paid amount does not match the order.', array( 'status' => 409 ) );
	}

	$currency = strtoupper( (string) ( $session['currency'] ?? '' ) );
	if ( '' !== $currency && $currency !== strtoupper( (string) $order->get_currency() ) ) {
		$order->add_order_note(
			sprintf( 'Stripe reported %1$s but the order is in %2$s. The order was not completed automatically.', $currency, $order->get_currency() )
		);
		return new WP_Error( 'sillage_hosted_currency_mismatch', 'The paid currency does not match the order.', array( 'status' => 409 ) );
	}

	$intent = $session['payment_intent'] ?? '';
	if ( is_array( $intent ) ) {
		$intent = (string) ( $intent['id'] ?? '' );
	}
	$intent = (string) $intent;

	$label = sillage_hosted_label( $session );
	if ( '' === $label && ! empty( $session['id'] ) ) {
		$full = sillage_hosted_api(
			'checkout/sessions/' . rawurlencode( (string) $session['id'] ),
			'GET',
			array(),
			array( 'expand' => array( 'payment_intent.latest_charge' ) )
		);
		if ( ! is_wp_error( $full ) ) {
			$label = sillage_hosted_label( $full );
		}
	}

	$order->update_meta_data( SILLAGE_HOSTED_SESSION_META, (string) ( $session['id'] ?? '' ) );
	if ( '' !== $intent ) {
		$order->update_meta_data( SILLAGE_HOSTED_INTENT_META, $intent );
	}
	if ( '' !== $label ) {
		$order->set_payment_method_title( $label );
	}
	$order->save();

	// `payment_complete` marks it paid, records the transaction and reduces stock, exactly
	// as it would for a gateway that charged on the site.
	$order->payment_complete( $intent );

	return true;
}

/** The payload the confirmation screen reads, in the shape it already knows. */
function sillage_hosted_order_payload( $order ) {
	$unit = wc_get_price_decimals();

	return array(
		'order_id'      => $order->get_id(),
		'order_number'  => $order->get_order_number(),
		'status'        => $order->get_status(),
		'paid'          => (bool) $order->get_date_paid(),
		'total'         => $order->get_total(),
		'currency'      => array(
			'currency_code'               => $order->get_currency(),
			'currency_minor_unit'         => $unit,
			'currency_prefix'             => html_entity_decode( get_woocommerce_currency_symbol( $order->get_currency() ), ENT_QUOTES, 'UTF-8' ),
			'currency_suffix'             => '',
			'currency_thousand_separator' => wc_get_price_thousand_separator(),
			'currency_decimal_separator'  => wc_get_price_decimal_separator(),
			'total_price'                 => (int) round( (float) $order->get_total() * ( 10 ** $unit ) ),
		),
		'payment_label' => $order->get_payment_method_title(),
	);
}

/** Failed login attempts on the completion route, per order. */
function sillage_hosted_throttle( $order_id, $bump = false ) {
	$key      = SILLAGE_HOSTED_ATTEMPT_KEY . absint( $order_id );
	$attempts = (int) get_transient( $key );

	if ( $bump ) {
		set_transient( $key, $attempts + 1, SILLAGE_HOSTED_ATTEMPT_WINDOW );
		return $attempts + 1 > SILLAGE_HOSTED_MAX_ATTEMPTS;
	}

	return $attempts >= SILLAGE_HOSTED_MAX_ATTEMPTS;
}

/* ------------------------------------------------------------------ *
 * POST /hosted/complete
 *
 * Called by the confirmation screen when Stripe sends the shopper back. It reads the
 * session from Stripe (never from the browser), completes the order when the money is
 * there, and reports "still processing" for a delayed method. Safe to call repeatedly:
 * a paid order is returned as paid and is never charged twice.
 * ------------------------------------------------------------------ */

function sillage_hosted_complete_route( WP_REST_Request $request ) {
	$order_id  = absint( $request->get_param( 'order_id' ) );
	$order_key = sanitize_text_field( (string) $request->get_param( 'order_key' ) );
	$order     = $order_id ? wc_get_order( $order_id ) : false;

	if ( ! $order || '' === $order_key || ! $order->key_is_valid( $order_key ) ) {
		return new WP_Error( 'sillage_hosted_bad_order', 'Order not found.', array( 'status' => 404 ) );
	}

	if ( SILLAGE_HOSTED_GATEWAY_ID !== $order->get_payment_method() ) {
		return new WP_Error( 'sillage_hosted_wrong_gateway', 'Order was not placed with Stripe Checkout.', array( 'status' => 400 ) );
	}

	if ( sillage_hosted_throttle( $order_id ) ) {
		return new WP_Error( 'sillage_hosted_throttled', 'Too many attempts for this order. Please try again shortly.', array( 'status' => 429 ) );
	}

	if ( $order->get_date_paid() ) {
		return sillage_hosted_order_payload( $order );
	}

	$session_id = sanitize_text_field( (string) $request->get_param( 'session_id' ) );
	$stored     = (string) $order->get_meta( SILLAGE_HOSTED_SESSION_META );

	if ( '' === $session_id ) {
		$session_id = $stored;
	}

	if ( '' === $session_id ) {
		return new WP_Error( 'sillage_hosted_no_session', 'No payment is attached to this order.', array( 'status' => 400 ) );
	}

	// The session is bound to the order; a session id from another order is refused.
	if ( '' !== $stored && ! hash_equals( $stored, $session_id ) ) {
		sillage_hosted_throttle( $order_id, true );
		return new WP_Error( 'sillage_hosted_session_mismatch', 'That payment does not belong to this order.', array( 'status' => 403 ) );
	}

	$session = sillage_hosted_api(
		'checkout/sessions/' . rawurlencode( $session_id ),
		'GET',
		array(),
		array( 'expand' => array( 'payment_intent.latest_charge' ) )
	);
	if ( is_wp_error( $session ) ) {
		return $session;
	}

	$bound = (int) ( $session['metadata']['order_id'] ?? $session['client_reference_id'] ?? 0 );
	if ( $bound !== $order_id ) {
		sillage_hosted_throttle( $order_id, true );
		return new WP_Error( 'sillage_hosted_session_mismatch', 'That payment does not belong to this order.', array( 'status' => 403 ) );
	}

	$status        = (string) ( $session['status'] ?? '' );
	$payment_state = (string) ( $session['payment_status'] ?? '' );

	if ( 'paid' === $payment_state || 'no_payment_required' === $payment_state ) {
		$paid = sillage_hosted_mark_paid( $order, $session );
		if ( is_wp_error( $paid ) ) {
			return $paid;
		}
		$order = wc_get_order( $order_id );
	} else {
		// Store the session id even while unpaid, so a later webhook can find the order
		// and a reload of this page does not need the browser's query string.
		if ( '' === $stored ) {
			$order->update_meta_data( SILLAGE_HOSTED_SESSION_META, $session_id );
			$order->save();
		}
	}

	return array_merge(
		sillage_hosted_order_payload( $order ),
		array(
			'session_status' => $status,
			'payment_status' => $payment_state,
			'completed'      => (bool) $order->get_date_paid(),
			// `processing` is what the confirmation screen shows as "the bank is still
			// collecting it": complete on Stripe's side, money not in yet.
			'intent_status'  => $order->get_date_paid() ? 'succeeded' : ( 'complete' === $status ? 'processing' : 'requires_payment_method' ),
		)
	);
}

/* ------------------------------------------------------------------ *
 * Webhook verification
 * ------------------------------------------------------------------ */

/** Verify a Stripe `Stripe-Signature` header against the raw body and the endpoint secret. */
function sillage_hosted_verify_signature( $payload, $header, $secret ) {
	if ( '' === $secret || '' === $header ) {
		return false;
	}

	$timestamp  = 0;
	$signatures = array();

	foreach ( explode( ',', $header ) as $part ) {
		$bits = explode( '=', trim( $part ), 2 );
		if ( 2 !== count( $bits ) ) {
			continue;
		}
		if ( 't' === $bits[0] ) {
			$timestamp = (int) $bits[1];
		} elseif ( 'v1' === $bits[0] ) {
			$signatures[] = $bits[1];
		}
	}

	if ( ! $timestamp || ! $signatures ) {
		return false;
	}

	if ( abs( time() - $timestamp ) > 300 ) {
		return false;
	}

	$expected = hash_hmac( 'sha256', $timestamp . '.' . $payload, $secret );

	foreach ( $signatures as $signature ) {
		if ( hash_equals( $expected, $signature ) ) {
			return true;
		}
	}

	return false;
}

/* ------------------------------------------------------------------ *
 * The Stripe webhook endpoint
 *
 * Stripe signs every delivery with a secret that belongs to one endpoint in one mode.
 * Turning test mode on or off, or replacing the API keys, therefore needs a different
 * endpoint and a different secret. Doing that by hand every time is the kind of setup a
 * shop should not inherit, so the gateway creates the endpoint itself with whichever key
 * is configured, stores the secret per mode, and redoes it when the mode or the key
 * changes. The two settings fields below are only an override for a restricted key.
 * ------------------------------------------------------------------ */

/** Where Stripe should report what it charged. */
function sillage_hosted_webhook_url() {
	return home_url( '/?wc-api=' . SILLAGE_HOSTED_GATEWAY_ID );
}

/** The events the gateway acts on: a completed payment, a delayed one, and its failure. */
function sillage_hosted_webhook_events() {
	return array(
		'checkout.session.completed',
		'checkout.session.async_payment_succeeded',
		'checkout.session.async_payment_failed',
		'checkout.session.expired',
	);
}

/** A short fingerprint of the API key, so a replaced key is never mistaken for the old one. */
function sillage_hosted_key_fingerprint( $mode = null ) {
	$key = sillage_hosted_secret_key( $mode );
	return '' === $key ? '' : substr( hash( 'sha256', $key ), 0, 16 );
}

/** The endpoints this shop created, one per mode. */
function sillage_hosted_webhook_state() {
	$state = get_option( SILLAGE_HOSTED_WEBHOOK_OPTION, array() );
	return is_array( $state ) ? $state : array();
}

function sillage_hosted_webhook_save_state( $state ) {
	if ( false === get_option( SILLAGE_HOSTED_WEBHOOK_OPTION, false ) ) {
		add_option( SILLAGE_HOSTED_WEBHOOK_OPTION, $state, '', 'no' );
		return;
	}
	// Never autoload a signing secret.
	update_option( SILLAGE_HOSTED_WEBHOOK_OPTION, $state, 'no' );
}

/** The endpoint this shop created for a mode, when it still belongs to the configured key. */
function sillage_hosted_stored_webhook( $mode = null ) {
	$mode  = 'test' === $mode || 'live' === $mode ? $mode : sillage_hosted_mode();
	$state = sillage_hosted_webhook_state();
	$entry = isset( $state[ $mode ] ) ? $state[ $mode ] : null;

	if ( ! is_array( $entry ) || empty( $entry['id'] ) || empty( $entry['secret'] ) ) {
		return null;
	}

	if ( (string) ( $entry['fingerprint'] ?? '' ) !== sillage_hosted_key_fingerprint( $mode ) ) {
		return null;
	}

	return $entry;
}

/**
 * Create or repair the endpoint for one mode and remember its secret.
 *
 * Reused until the mode or the API key changes. A stored endpoint that still exists only
 * needs re-enabling, which keeps its secret. An endpoint the shop did not create cannot
 * surrender its secret through the API, so it is replaced by one whose secret we hold.
 */
function sillage_hosted_sync_webhook( $force = false, $mode = null ) {
	$mode   = 'test' === $mode || 'live' === $mode ? $mode : sillage_hosted_mode();
	$stored = sillage_hosted_stored_webhook( $mode );

	if ( $stored && ! $force && ( time() - (int) ( $stored['checked'] ?? 0 ) ) < 15 * MINUTE_IN_SECONDS ) {
		return $stored;
	}

	if ( '' === sillage_hosted_secret_key( $mode ) ) {
		return new WP_Error( 'sillage_hosted_no_key', 'No Stripe key is configured for ' . $mode . ' mode.', array( 'status' => 503 ) );
	}

	$lock = 'sillage_hosted_webhook_lock_' . $mode;
	if ( ! $force && get_transient( $lock ) ) {
		return new WP_Error( 'sillage_hosted_webhook_busy', 'The Stripe webhook is already being checked.', array( 'status' => 503 ) );
	}
	set_transient( $lock, 1, 5 * MINUTE_IN_SECONDS );

	$url    = sillage_hosted_webhook_url();
	$state  = sillage_hosted_webhook_state();
	$retire = array();

	if ( $stored ) {
		$existing = sillage_hosted_api( 'webhook_endpoints/' . rawurlencode( (string) $stored['id'] ), 'GET', array(), array(), $mode );

		if ( ! is_wp_error( $existing ) && (string) ( $existing['url'] ?? '' ) === $url ) {
			$enabled = 'enabled' === (string) ( $existing['status'] ?? '' );

			if ( ! $enabled ) {
				$enabled = ! is_wp_error(
					sillage_hosted_api(
						'webhook_endpoints/' . rawurlencode( (string) $stored['id'] ),
						'POST',
						array(
							'disabled'       => 'false',
							'enabled_events' => array_values( sillage_hosted_webhook_events() ),
						),
						array(),
						$mode
					)
				);
			}

			if ( $enabled ) {
				$stored['checked'] = time();
				$stored['error']   = '';
				$state[ $mode ]    = $stored;
				sillage_hosted_webhook_save_state( $state );
				delete_transient( $lock );
				delete_transient( 'sillage_hosted_webhook_error_' . $mode );
				return $stored;
			}
		}

		$retire[] = (string) $stored['id'];
	}

	// Same address, no secret we can read: replace it rather than leave a gap.
	$list = sillage_hosted_api( 'webhook_endpoints', 'GET', array(), array( 'limit' => 100 ), $mode );
	if ( ! is_wp_error( $list ) ) {
		foreach ( (array) ( $list['data'] ?? array() ) as $endpoint ) {
			$id = (string) ( $endpoint['id'] ?? '' );
			if ( '' === $id || (string) ( $endpoint['url'] ?? '' ) !== $url ) {
				continue;
			}
			$retire[] = $id;
		}
	}

	$data = array(
		'url'            => $url,
		'enabled_events' => array_values( sillage_hosted_webhook_events() ),
		'description'    => 'Sillage storefront (created automatically by the shop)',
		'metadata'       => array( 'managed_by' => 'sillage_stripe_hosted' ),
		'api_version'    => SILLAGE_HOSTED_WEBHOOK_API_VERSION,
	);

	$created = sillage_hosted_api( 'webhook_endpoints', 'POST', $data, array(), $mode );

	// An account that pins a different API version still gets its endpoint.
	if ( is_wp_error( $created ) && false !== stripos( $created->get_error_message(), 'api_version' ) ) {
		unset( $data['api_version'] );
		$created = sillage_hosted_api( 'webhook_endpoints', 'POST', $data, array(), $mode );
	}

	if ( is_wp_error( $created ) || empty( $created['id'] ) || empty( $created['secret'] ) ) {
		$message = is_wp_error( $created ) ? $created->get_error_message() : 'Stripe did not return a webhook secret.';
		set_transient( 'sillage_hosted_webhook_error_' . $mode, $message, DAY_IN_SECONDS );
		return new WP_Error( 'sillage_hosted_webhook_failed', $message, array( 'status' => 502 ) );
	}

	$entry = array(
		'id'          => (string) $created['id'],
		'secret'      => (string) $created['secret'],
		'url'         => $url,
		'mode'        => $mode,
		'fingerprint' => sillage_hosted_key_fingerprint( $mode ),
		'checked'     => time(),
		'error'       => '',
	);

	$state[ $mode ] = $entry;
	sillage_hosted_webhook_save_state( $state );

	foreach ( array_unique( array_filter( $retire ) ) as $id ) {
		if ( $id === $entry['id'] ) {
			continue;
		}
		// Best effort: the new endpoint already receives the events. A failed delete only
		// leaves a duplicate, and Stripe disables an endpoint whose deliveries keep failing.
		sillage_hosted_api( 'webhook_endpoints/' . rawurlencode( $id ), 'DELETE', array(), array(), $mode );
	}

	delete_transient( $lock );
	delete_transient( 'sillage_hosted_webhook_error_' . $mode );

	return $entry;
}

/** Every secret a delivery may be signed with: both managed endpoints, then any override. */
function sillage_hosted_webhook_secrets() {
	$secrets = array();

	if ( defined( 'SILLAGE_HOSTED_WEBHOOK_SECRET' ) ) {
		$secrets[] = (string) SILLAGE_HOSTED_WEBHOOK_SECRET;
	}

	$settings = get_option( SILLAGE_HOSTED_SETTINGS_OPTION, array() );
	$settings = is_array( $settings ) ? $settings : array();

	foreach ( array( 'webhook_secret', 'webhook_secret_live' ) as $key ) {
		if ( ! empty( $settings[ $key ] ) ) {
			$secrets[] = trim( (string) $settings[ $key ] );
		}
	}

	// Both modes: a payment that started before test mode was switched still settles.
	foreach ( sillage_hosted_webhook_state() as $entry_mode => $entry ) {
		if ( ! in_array( $entry_mode, array( 'test', 'live' ), true ) || ! is_array( $entry ) || empty( $entry['secret'] ) ) {
			continue;
		}
		if ( (string) ( $entry['fingerprint'] ?? '' ) !== sillage_hosted_key_fingerprint( $entry_mode ) ) {
			continue;
		}
		$secrets[] = (string) $entry['secret'];
	}

	return array_values( array_unique( array_filter( $secrets ) ) );
}

/** Verify a delivery against every known secret for the current mode. */
function sillage_hosted_verify_any_signature( $payload, $header ) {
	foreach ( sillage_hosted_webhook_secrets() as $secret ) {
		if ( sillage_hosted_verify_signature( $payload, $header, $secret ) ) {
			return true;
		}
	}

	return false;
}

/** What the gateway's settings screen says about the endpoint. Never makes an API call. */
function sillage_hosted_webhook_status_text() {
	$mode  = sillage_hosted_mode();
	$label = 'test' === $mode ? 'test mode' : 'live mode';
	$entry = sillage_hosted_stored_webhook( $mode );

	if ( $entry ) {
		return sprintf(
			'Connected in %1$s: %2$s (endpoint %3$s). Checked again whenever this page is saved.',
			$label,
			sillage_hosted_webhook_url(),
			(string) $entry['id']
		);
	}

	$error = get_transient( 'sillage_hosted_webhook_error_' . $mode );
	if ( $error ) {
		return sprintf( 'Not connected in %1$s. Stripe said: %2$s', $label, (string) $error );
	}

	return sprintf(
		'Not created yet in %1$s. It is created automatically with the configured key on the next checkout, or when this page is saved.',
		$label
	);
}

/* ------------------------------------------------------------------ *
 * REST route
 * ------------------------------------------------------------------ */

add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			SILLAGE_HOSTED_REST_NS,
			'/hosted/complete',
			array(
				'methods'             => 'POST',
				'permission_callback' => '__return_true',
				'callback'            => 'sillage_hosted_complete_route',
			)
		);
	}
);

/* ------------------------------------------------------------------ *
 * The gateway
 *
 * Declared on `plugins_loaded` because a MU plugin is loaded before WooCommerce, so
 * WC_Payment_Gateway does not exist yet when this file is first read.
 * ------------------------------------------------------------------ */

add_action( 'plugins_loaded', 'sillage_hosted_boot', 20 );

function sillage_hosted_boot() {
	if ( ! class_exists( 'WC_Payment_Gateway' ) || class_exists( 'Sillage_Stripe_Hosted_Checkout' ) ) {
		return;
	}

	/**
	 * Hand the shopper to Stripe's hosted Checkout page.
	 *
	 * The order exists before this gateway is called, which is what keeps prices, stock
	 * and shipping WooCommerce's answer. The gateway only creates the session and returns
	 * its address; Stripe does everything else.
	 */
	class Sillage_Stripe_Hosted_Checkout extends WC_Payment_Gateway {

		public function __construct() {
			$this->id                 = SILLAGE_HOSTED_GATEWAY_ID;
			$this->method_title       = 'Stripe Checkout';
			$this->method_description = 'Pays on Stripe\'s own checkout page. Supports every method the Stripe account offers, including cards, wallets and local methods.';
			$this->has_fields         = false;
			$this->supports           = array( 'products', 'refunds' );

			$this->init_form_fields();
			$this->init_settings();

			$this->title       = (string) $this->get_option( 'title', 'Card or local payment' );
			$this->description = (string) $this->get_option( 'description', '' );
			$this->enabled     = (string) $this->get_option( 'enabled', 'yes' );

			add_action( 'woocommerce_update_options_payment_gateways_' . $this->id, array( $this, 'process_admin_options' ) );
			add_action( 'woocommerce_api_' . $this->id, array( $this, 'webhook' ) );
		}

		public function init_form_fields() {
			$this->form_fields = array(
				'enabled'        => array(
					'title'   => 'Enable/Disable',
					'type'    => 'checkbox',
					'label'   => 'Enable Stripe Checkout',
					'default' => 'yes',
				),
				'title'          => array(
					'title'   => 'Title',
					'type'    => 'text',
					'default' => 'Card or local payment',
				),
				'description'    => array(
					'title'   => 'Description',
					'type'    => 'textarea',
					'default' => '',
				),
				'webhook_status' => array(
					'title'       => 'Stripe webhook',
					'type'        => 'title',
					'description' => is_admin() ? sillage_hosted_webhook_status_text() : '',
				),
				'webhook_secret' => array(
					'title'       => 'Webhook secret override',
					'type'        => 'password',
					'description' => 'Only needed when the Stripe key cannot create webhooks. The endpoint at /?wc-api=sillage_checkout is created and kept automatically for the configured mode, so this can stay empty.',
					'default'     => '',
				),
				'webhook_secret_live' => array(
					'title'       => 'Live webhook secret override',
					'type'        => 'password',
					'description' => 'Only needed when the live Stripe key cannot create webhooks. Otherwise the live endpoint is created and kept automatically when test mode is off.',
					'default'     => '',
				),
			);
		}

		/** Save, then make sure Stripe is pointing at this shop for the configured mode. */
		public function process_admin_options() {
			$saved = parent::process_admin_options();

			if ( $saved ) {
				$synced = sillage_hosted_sync_webhook( true );

				if ( is_wp_error( $synced ) && class_exists( 'WC_Admin_Settings' ) ) {
					WC_Admin_Settings::add_error( 'Stripe webhook: ' . $synced->get_error_message() );
				}
			}

			return $saved;
		}

		public function is_available() {
			if ( 'yes' !== $this->enabled ) {
				return false;
			}
			return '' !== sillage_hosted_secret_key();
		}

		public function process_payment( $order_id ) {
			$order = wc_get_order( $order_id );
			if ( ! $order ) {
				return array(
					'result'  => 'failure',
					'message' => 'Order not found.',
				);
			}

			// Make sure Stripe has somewhere to report this payment before the shopper
			// leaves. A failure here is not fatal: the return trip still settles the order.
			sillage_hosted_sync_webhook();

			$url = sillage_hosted_session_url( $order );
			if ( is_wp_error( $url ) ) {
				$message = $url->get_error_message();
				wc_add_notice( $message, 'error' );
				return array(
					'result'  => 'failure',
					'message' => $message,
				);
			}

			// `pending` rather than `success`: the order exists and is not paid, and the
			// Store API hands `redirect` to the storefront, which follows it.
			return array(
				'result'   => 'pending',
				'redirect' => $url,
			);
		}

		/**
		 * `?wc-api=sillage_checkout`: the authoritative word on what Stripe charged.
		 *
		 * Card payments arrive as `checkout.session.completed` with `payment_status=paid`.
		 * Delayed methods complete the session first and report the money later through
		 * `checkout.session.async_payment_succeeded` (or `..._failed`).
		 */
		public function webhook() {
			$payload = (string) file_get_contents( 'php://input' );
			$header  = isset( $_SERVER['HTTP_STRIPE_SIGNATURE'] ) ? (string) $_SERVER['HTTP_STRIPE_SIGNATURE'] : '';

			$verified = sillage_hosted_verify_any_signature( $payload, $header );

			if ( ! $verified ) {
				// A first delivery in a new mode, or one after the keys were replaced, can
				// arrive before the endpoint is known here. Ask Stripe once and check again.
				// The sync's lock keeps forged requests from turning this into an amplifier.
				if ( ! is_wp_error( sillage_hosted_sync_webhook() ) ) {
					$verified = sillage_hosted_verify_any_signature( $payload, $header );
				}
			}

			if ( ! $verified ) {
				status_header( 400 );
				echo 'invalid signature';
				exit;
			}

			$event = json_decode( $payload, true );
			if ( ! is_array( $event ) || empty( $event['type'] ) || empty( $event['data']['object'] ) ) {
				status_header( 400 );
				echo 'bad event';
				exit;
			}

			$type    = (string) $event['type'];
			$session = (array) $event['data']['object'];

			$order_id = (int) ( $session['metadata']['order_id'] ?? $session['client_reference_id'] ?? 0 );
			$order    = $order_id ? wc_get_order( $order_id ) : false;

			if ( $order instanceof WC_Order && SILLAGE_HOSTED_GATEWAY_ID === $order->get_payment_method() ) {
				/*
				 * An old session can expire after the order has moved to a newer one (a
				 * shopper retries, or a creation response is lost). A failure or expiry
				 * event is only about the session the order currently points at; an
				 * orphan session must not cancel a live one.
				 */
				$current_session = (string) $order->get_meta( SILLAGE_HOSTED_SESSION_META );
				$event_session   = (string) ( $session['id'] ?? '' );
				$is_current      = '' === $current_session || '' === $event_session || $event_session === $current_session;

				switch ( $type ) {
					case 'checkout.session.completed':
					case 'checkout.session.async_payment_succeeded':
						$state = (string) ( $session['payment_status'] ?? '' );
						if ( 'paid' === $state || 'no_payment_required' === $state ) {
							sillage_hosted_mark_paid( $order, $session );
						}
						break;

					case 'checkout.session.async_payment_failed':
						if ( $is_current && ! $order->get_date_paid() ) {
							$order->update_status( 'failed', 'Stripe reported that the delayed payment failed.' );
						}
						break;

					case 'checkout.session.expired':
						if ( $is_current && ! $order->get_date_paid() ) {
							$order->update_status( 'cancelled', 'The Stripe Checkout session expired before payment.' );
						}
						break;
				}
			}

			status_header( 200 );
			echo 'ok';
			exit;
		}

		/** Refund through Stripe, so the WooCommerce refund button works for this gateway. */
		public function process_refund( $order_id, $amount = null, $reason = '' ) {
			$order = wc_get_order( $order_id );
			if ( ! $order ) {
				return new WP_Error( 'sillage_hosted_no_order', 'Order not found.' );
			}

			$intent = (string) $order->get_meta( SILLAGE_HOSTED_INTENT_META );
			if ( '' === $intent ) {
				return new WP_Error( 'sillage_hosted_no_intent', 'No Stripe payment is attached to this order.' );
			}

			$data = array( 'payment_intent' => $intent );
			if ( null !== $amount ) {
				$data['amount'] = sillage_hosted_minor( $amount, $order );
			}

			$refund = sillage_hosted_api( 'refunds', 'POST', $data );
			if ( is_wp_error( $refund ) ) {
				return $refund;
			}

			return true;
		}
	}

	add_filter(
		'woocommerce_payment_gateways',
		static function ( $gateways ) {
			$gateways[] = 'Sillage_Stripe_Hosted_Checkout';
			return $gateways;
		}
	);
}
