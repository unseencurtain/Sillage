<?php
/**
 * Plugin Name: Sillage Stripe checkout
 * Description: Completes a WooCommerce order once its Stripe PaymentIntent has succeeded
 *              on the storefront. Used by the headless React checkout, which mounts
 *              Stripe.js itself and therefore never returns to a WordPress page.
 * Version:     1.0.0
 *
 * Why this exists
 * ---------------
 * The storefront is headless. The shopper confirms the card form on our own domain, so
 * there is no WordPress request in which the Stripe gateway can finish the order the way
 * WC_Stripe_Redirect_Handler would. This endpoint is that finishing step, and nothing else:
 * it never creates or confirms an intent, and it never talks to the card. The Stripe plugin
 * remains the only thing that charges anyone.
 *
 * Routes (namespace sillage/v1):
 *   GET  /stripe/config   -> { mode, publishable_key, card_gateway }   (public facts only)
 *   POST /stripe/complete -> { paid, status, order_id, ... }
 *   GET  /order           -> ?order_id=&order_key= -> { paid, status, order_id, ... }
 *
 * Authorisation
 * -------------
 * The order key is the credential — the same secret WooCommerce puts in an order-pay URL,
 * 60 random characters, compared in constant time by WC_Order::key_is_valid(). No route
 * returns anything about an order without it. Nothing sensitive is ever echoed back: no
 * secret key, no intent id, no client secret.
 */

defined( 'ABSPATH' ) || exit;

const SILLAGE_STRIPE_NS = 'sillage/v1';

/** The card gateway this integration drives. Everything else keeps the plain Store API path. */
const SILLAGE_STRIPE_CARD_GATEWAY = 'stripe_cc';

/** Failed completion attempts allowed per order inside the window below. */
const SILLAGE_STRIPE_MAX_ATTEMPTS = 30;
const SILLAGE_STRIPE_ATTEMPT_WINDOW = 600;

add_action(
	'rest_api_init',
	function () {
		register_rest_route(
			SILLAGE_STRIPE_NS,
			'/stripe/config',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'callback'            => 'sillage_stripe_config',
			)
		);

		register_rest_route(
			SILLAGE_STRIPE_NS,
			'/stripe/complete',
			array(
				'methods'             => 'POST',
				'permission_callback' => '__return_true',
				'callback'            => 'sillage_stripe_complete',
			)
		);

		register_rest_route(
			SILLAGE_STRIPE_NS,
			'/order',
			array(
				'methods'             => 'GET',
				'permission_callback' => '__return_true',
				'callback'            => 'sillage_stripe_order',
			)
		);
	}
);

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** The plugin's settings array (mode + per-mode keys). */
function sillage_stripe_settings() {
	$settings = get_option( 'woocommerce_stripe_api_settings', array() );
	return is_array( $settings ) ? $settings : array();
}

/** 'test' or 'live' — whatever the Stripe plugin is configured for. */
function sillage_stripe_mode() {
	$settings = sillage_stripe_settings();
	$mode     = isset( $settings['mode'] ) ? (string) $settings['mode'] : 'test';
	return 'live' === $mode ? 'live' : 'test';
}

/**
 * The publishable key for the configured mode. Publishable keys are public by design —
 * this is the same string the browser would send to Stripe either way — but serving it
 * means switching test -> live in the plugin needs no frontend rebuild.
 */
function sillage_stripe_publishable_key() {
	$settings = sillage_stripe_settings();
	$key      = 'live' === sillage_stripe_mode() ? 'publishable_key_live' : 'publishable_key_test';
	return isset( $settings[ $key ] ) ? (string) $settings[ $key ] : '';
}

/** The Stripe client for an order's mode, or null when the plugin is not loaded. */
function sillage_stripe_client( $order = null ) {
	if ( ! function_exists( 'wc_stripe_get_container' ) || ! class_exists( '\PaymentPlugins\Stripe\Client\StripeClient' ) ) {
		return null;
	}
	$client = wc_stripe_get_container()->get( \PaymentPlugins\Stripe\Client\StripeClient::class );
	return $order && method_exists( $client, 'mode' ) ? $client->mode( $order ) : $client;
}

/**
 * Look an order up from the request, or fail. The key comparison happens inside
 * key_is_valid() and is constant time; a wrong key and a missing order look identical
 * so the endpoint cannot be used to probe which order ids exist.
 */
function sillage_stripe_order_from_request( WP_REST_Request $request ) {
	$order_id  = absint( $request->get_param( 'order_id' ) );
	$order_key = sanitize_text_field( (string) $request->get_param( 'order_key' ) );
	$order     = $order_id ? wc_get_order( $order_id ) : false;

	if ( ! $order || ! $order_key || ! $order->key_is_valid( $order_key ) ) {
		return new WP_Error( 'sillage_stripe_bad_order', 'Order not found.', array( 'status' => 404 ) );
	}

	return $order;
}

/**
 * The order's currency in the shape the Store API uses, so the confirmation screen can
 * format the total with the same helper whether the order came back through the Store API
 * or through a card payment that needed a 3-D-Secure round trip.
 */
function sillage_stripe_currency_meta( $order ) {
	$unit = wc_get_price_decimals();

	return array(
		'currency_code'               => $order->get_currency(),
		'currency_minor_unit'         => $unit,
		'currency_prefix'             => html_entity_decode( get_woocommerce_currency_symbol( $order->get_currency() ), ENT_QUOTES, 'UTF-8' ),
		'currency_suffix'             => '',
		'currency_thousand_separator' => wc_get_price_thousand_separator(),
		'currency_decimal_separator'  => wc_get_price_decimal_separator(),
		'total_price'                 => (int) round( (float) $order->get_total() * ( 10 ** $unit ) ),
	);
}

/** What the storefront is allowed to know about an order. No ids, no keys, no intent. */
function sillage_stripe_order_payload( $order ) {
	return array(
		'order_id'     => $order->get_id(),
		'order_number' => $order->get_order_number(),
		'status'       => $order->get_status(),
		'paid'         => (bool) $order->get_date_paid(),
		'total'        => $order->get_total(),
		'currency'     => sillage_stripe_currency_meta( $order ),
		// Display title of the gateway used ("Credit / debit card"), for the confirmation screen.
		'payment_label' => $order->get_payment_method_title(),
	);
}

/**
 * Blunt brute force against the completion route. Counts only failures, so a shopper
 * refreshing a slow order status page is never locked out of their own order.
 */
function sillage_stripe_throttle( $order_id, $hit = false ) {
	$key = 'sillage_stripe_attempts_' . $order_id;

	if ( $hit ) {
		$count = (int) get_transient( $key );
		set_transient( $key, $count + 1, SILLAGE_STRIPE_ATTEMPT_WINDOW );
		return false;
	}

	return (int) get_transient( $key ) >= SILLAGE_STRIPE_MAX_ATTEMPTS;
}

/** Read a value off a Stripe object or array without assuming which it is. */
function sillage_stripe_field( $source, $key ) {
	if ( is_array( $source ) ) {
		return $source[ $key ] ?? null;
	}
	if ( is_object( $source ) ) {
		return $source->{$key} ?? null;
	}
	return null;
}

/* ------------------------------------------------------------------ *
 * GET /stripe/config
 * ------------------------------------------------------------------ */

function sillage_stripe_config() {
	$key = sillage_stripe_publishable_key();

	return array(
		'mode'            => sillage_stripe_mode(),
		'publishable_key' => $key,
		'card_gateway'    => SILLAGE_STRIPE_CARD_GATEWAY,
		'ready'           => '' !== $key,
	);
}

/* ------------------------------------------------------------------ *
 * GET /order
 * ------------------------------------------------------------------ */

function sillage_stripe_order( WP_REST_Request $request ) {
	$order = sillage_stripe_order_from_request( $request );
	if ( is_wp_error( $order ) ) {
		return $order;
	}

	return sillage_stripe_order_payload( $order );
}

/* ------------------------------------------------------------------ *
 * POST /stripe/complete
 *
 * Mirrors WC_Stripe_Redirect_Handler::process_redirect(): the intent has already been
 * confirmed by Stripe.js in the shopper's browser, so we only have to let the gateway
 * settle the order. Safe to call repeatedly — the order lock and date_paid checks stop
 * any second pass, and a paid order is reported as paid without touching Stripe again.
 * ------------------------------------------------------------------ */

function sillage_stripe_complete( WP_REST_Request $request ) {
	$order = sillage_stripe_order_from_request( $request );
	if ( is_wp_error( $order ) ) {
		return $order;
	}

	$order_id = $order->get_id();

	if ( sillage_stripe_throttle( $order_id ) ) {
		return new WP_Error(
			'sillage_stripe_throttled',
			'Too many attempts for this order. Please try again shortly.',
			array( 'status' => 429 )
		);
	}

	// Already settled: nothing to do, and never re-charge.
	if ( $order->get_date_paid() ) {
		return sillage_stripe_order_payload( $order );
	}

	if ( SILLAGE_STRIPE_CARD_GATEWAY !== $order->get_payment_method() ) {
		return new WP_Error(
			'sillage_stripe_wrong_gateway',
			'Order was not placed with the card gateway.',
			array( 'status' => 400 )
		);
	}

	// A REST request has no frontend session; the gateway (notices, cart, order locks)
	// expects one. Without this, process_payment() fatals on a null session.
	if ( function_exists( 'WC' ) && function_exists( 'wc_load_cart' ) ) {
		wc_load_cart();
	}

	if ( ! class_exists( '\WC_Stripe_Constants' ) ) {
		return new WP_Error( 'sillage_stripe_no_plugin', 'Stripe plugin unavailable.', array( 'status' => 503 ) );
	}

	/*
	 * Bind the request to the order's own intent.
	 *
	 * The intent id is written on the order when the order is created, so that is the
	 * authority; a client-supplied id only has to agree with it. Without this check a
	 * shopper could pay for a cheap order and complete an expensive one by handing its
	 * intent to this route.
	 */
	$stored_intent = (string) $order->get_meta( \WC_Stripe_Constants::PAYMENT_INTENT_ID );
	$sent_intent   = sanitize_text_field( (string) $request->get_param( 'payment_intent' ) );

	if ( $stored_intent && $sent_intent && ! hash_equals( $stored_intent, $sent_intent ) ) {
		sillage_stripe_throttle( $order_id, true );
		return new WP_Error(
			'sillage_stripe_intent_mismatch',
			'That payment does not belong to this order.',
			array( 'status' => 403 )
		);
	}

	$intent_id = $stored_intent ?: $sent_intent;
	if ( ! $intent_id ) {
		return new WP_Error( 'sillage_stripe_no_intent', 'No payment is attached to this order.', array( 'status' => 400 ) );
	}

	$client = sillage_stripe_client( $order );
	if ( ! $client ) {
		return new WP_Error( 'sillage_stripe_no_client', 'Stripe client unavailable.', array( 'status' => 503 ) );
	}

	$intent = $client->paymentIntents->retrieve( $intent_id );
	if ( is_wp_error( $intent ) ) {
		return new WP_Error( 'sillage_stripe_intent_error', $intent->get_error_message(), array( 'status' => 502 ) );
	}

	// Second binding: the intent itself records the order it was created for.
	$intent_order = sillage_stripe_field( sillage_stripe_field( $intent, 'metadata' ), 'order_id' );
	if ( $intent_order && (int) $intent_order !== $order_id ) {
		sillage_stripe_throttle( $order_id, true );
		return new WP_Error(
			'sillage_stripe_intent_mismatch',
			'That payment does not belong to this order.',
			array( 'status' => 403 )
		);
	}

	$results = array(
		'intent_status' => $intent->status,
		'completed'     => false,
		'order_id'      => $order_id,
	);

	if ( ! in_array( $intent->status, array( 'succeeded', 'requires_capture' ), true ) ) {
		// Not paid yet. Not an error: the storefront polls until Stripe settles.
		return array_merge( sillage_stripe_order_payload( $order ), $results );
	}

	$gateways = WC()->payment_gateways()->payment_gateways();
	$gateway  = $gateways[ SILLAGE_STRIPE_CARD_GATEWAY ] ?? null;

	if ( ! $gateway instanceof WC_Payment_Gateway_Stripe ) {
		return new WP_Error( 'sillage_stripe_no_gateway', 'Stripe gateway unavailable.', array( 'status' => 503 ) );
	}

	$locked = method_exists( $gateway, 'has_order_lock' ) && $gateway->has_order_lock( $order );
	if ( $locked ) {
		// Another request is already settling this order; report the truth and let it finish.
		return array_merge( sillage_stripe_order_payload( $order ), $results );
	}

	// Tell the gateway to reuse the intent it already created (its redirect-handler path).
	if ( ! defined( \WC_Stripe_Constants::REDIRECT_HANDLER ) ) {
		define( \WC_Stripe_Constants::REDIRECT_HANDLER, true );
	}

	if ( method_exists( $gateway, 'set_order_lock' ) ) {
		$gateway->set_order_lock( $order );
	}
	if ( method_exists( $gateway, 'set_payment_method_id' ) ) {
		$payment_method = sillage_stripe_field( $intent, 'payment_method' );
		if ( $payment_method ) {
			$gateway->set_payment_method_id( is_object( $payment_method ) ? $payment_method->id : $payment_method );
		}
	}

	$result = $gateway->process_payment( $order_id );
	if ( isset( $result['result'] ) && 'success' === $result['result'] ) {
		$results['completed'] = true;
	}

	$order = wc_get_order( $order_id );
	if ( ! $order ) {
		return new WP_Error( 'sillage_stripe_order_gone', 'Order disappeared.', array( 'status' => 500 ) );
	}

	return array_merge( sillage_stripe_order_payload( $order ), $results );
}
