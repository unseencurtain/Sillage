<?php
/**
 * Plugin Name: Cereve Storefront Auth
 * Description: Session authentication endpoints for the headless Cereve storefront. Adds register, login, logout, profile and order-history routes under the WooCommerce Store API namespace so a decoupled React app can authenticate against WordPress cookies instead of shipping API secrets to the browser.
 * Version: 1.0.0
 * Requires PHP: 7.4
 *
 * Why this exists
 * ---------------
 * WooCommerce's Store API ships no /customer routes, and WordPress core has no
 * browser-safe login for a decoupled front end. The usual workaround is a
 * third-party JWT plugin, or WooCommerce consumer key/secret over HTTP Basic
 * auth -- but consumer keys are server credentials, and shipping them in a
 * browser bundle exposes them to every visitor. Cookie sessions keep the secret
 * on the server, so this plugin issues the session and hands back a REST nonce.
 *
 * @package Cereve
 */

defined( 'ABSPATH' ) || exit;

const CEREVE_AUTH_NS    = 'wc/store/v1';
const CEREVE_AUTH_PROVIDER = 'cereve-storefront';

/* -------------------------------------------------------------------------
 * Route registration
 * ---------------------------------------------------------------------- */

/**
 * Register the account routes alongside the rest of the Store API.
 */
function cereve_auth_register_routes() {
	// Credentials are only required on the two routes that take them; sharing
	// them across a route would make GET/PUT on /customer demand a password.
	$credentials = array(
		'email'    => array(
			'type'              => 'string',
			'required'          => true,
			'sanitize_callback' => 'sanitize_email',
		),
		'username' => array(
			'type'     => 'string',
			'required' => false,
		),
		'password' => array(
			'type'     => 'string',
			'required' => true,
		),
	);

	$public = array(
		// Register a new customer and sign them straight in.
		array(
			'path'       => '/customer',
			'methods'    => 'POST',
			'callback'   => 'cereve_auth_register',
			'permission' => '__return_true',
			'args'       => $credentials,
		),
		// Exchange credentials for a session cookie.
		array(
			'path'       => '/customer/login',
			'methods'    => 'POST',
			'callback'   => 'cereve_auth_login',
			'permission' => '__return_true',
			'args'       => $credentials,
		),
		// Order history is only readable by the signed-in owner.
		array(
			'path'       => '/customer/orders',
			'methods'    => 'GET',
			'callback'   => 'cereve_auth_orders',
			'permission' => '__return_true',
			'args'       => array(
				'page'     => array( 'type' => 'integer' ),
				'per_page' => array( 'type' => 'integer' ),
			),
		),
		// A single order, for the order detail view.
		array(
			'path'       => '/customer/orders/(?P<id>\d+)',
			'methods'    => 'GET',
			'callback'   => 'cereve_auth_order',
			'permission' => '__return_true',
			'args'       => array(
				'id' => array( 'type' => 'integer' ),
			),
		),
	);

	$authenticated = array(
		// Read the current customer.
		array(
			'path'       => '/customer',
			'methods'    => 'GET',
			'callback'   => 'cereve_auth_me',
			'permission' => '__return_true',
		),
		// Update profile and address book.
		array(
			'path'       => '/customer',
			'methods'    => 'PUT',
			'callback'   => 'cereve_auth_update',
			'permission' => '__return_true',
		),
		// Drop the session.
		array(
			'path'       => '/customer/logout',
			'methods'    => 'POST',
			'callback'   => 'cereve_auth_logout',
			'permission' => '__return_true',
		),
	);

	foreach ( array_merge( $public, $authenticated ) as $route ) {
		register_rest_route(
			CEREVE_AUTH_NS,
			$route['path'],
			array(
				'methods'             => $route['methods'],
				'callback'            => $route['callback'],
				'permission_callback' => $route['permission'],
				'args'                => $route['args'] ?? array(),
			)
		);
	}
}
add_action( 'rest_api_init', 'cereve_auth_register_routes' );

/* -------------------------------------------------------------------------
 * Session helpers
 * ---------------------------------------------------------------------- */

/**
 * Build the customer payload the storefront renders.
 *
 * The nonce is included so the app can call core endpoints (users/me, media)
 * as this customer without ever holding a long-lived credential.
 *
 * @param WP_User $user Customer user.
 * @return array
 */
function cereve_auth_payload( WP_User $user ) {
	$customer = new WC_Customer( $user->ID );

	// A customer with no address yet shows the store's own country, not a hard-coded
	// one. `wc_get_base_location()` follows WooCommerce → Settings → General, so a
	// fresh account on this shop reads as NL and never as US.
	$base            = wc_get_base_location();
	$default_country = is_array( $base ) && ! empty( $base['country'] ) ? $base['country'] : '';

	return array(
		'id'           => $user->ID,
		'username'     => $user->user_login,
		'email'        => $user->user_email,
		'first_name'   => $customer->get_first_name(),
		'last_name'    => $customer->get_last_name(),
		'display_name' => trim( $customer->get_first_name() . ' ' . $customer->get_last_name() ),
		'phone'        => $customer->get_billing_phone(),
		'billing'      => array(
			'first_name' => $customer->get_billing_first_name(),
			'last_name'  => $customer->get_billing_last_name(),
			'company'    => $customer->get_billing_company(),
			'address_1'  => $customer->get_billing_address_1(),
			'address_2'  => $customer->get_billing_address_2(),
			'city'       => $customer->get_billing_city(),
			'state'      => $customer->get_billing_state(),
			'postcode'   => $customer->get_billing_postcode(),
			'country'    => $customer->get_billing_country() ? $customer->get_billing_country() : $default_country,
			'phone'      => $customer->get_billing_phone(),
			'email'      => $customer->get_billing_email() ? $customer->get_billing_email() : $user->user_email,
		),
		'shipping'     => array(
			'first_name' => $customer->get_shipping_first_name(),
			'last_name'  => $customer->get_shipping_last_name(),
			'company'    => $customer->get_shipping_company(),
			'address_1'  => $customer->get_shipping_address_1(),
			'address_2'  => $customer->get_shipping_address_2(),
			'city'       => $customer->get_shipping_city(),
			'state'      => $customer->get_shipping_state(),
			'postcode'   => $customer->get_shipping_postcode(),
			'country'    => $customer->get_shipping_country() ? $customer->get_shipping_country() : $default_country,
		),
		'nonce'        => wp_create_nonce( 'wp_rest' ),
	);
}

/**
 * Reject unauthenticated callers with a 401 the SPA can distinguish.
 *
 * @return WP_REST_Response|WP_Error
 */
function cereve_auth_require_login() {
	if ( ! is_user_logged_in() ) {
		return new WP_Error(
			'cereve_not_logged_in',
			__( 'You need to be signed in to do that.', 'cereve' ),
			array( 'status' => 401 )
		);
	}
	return true;
}

/**
 * Turn a WP_Error into a response the client can display.
 *
 * @param WP_Error $error   Source error.
 * @param int      $code    HTTP status.
 * @return WP_REST_Response
 */
function cereve_auth_error( WP_Error $error, $code = 400 ) {
	return new WP_REST_Response(
		array(
			'code'    => $error->get_error_code(),
			'message' => $error->get_error_message(),
			'data'    => array( 'status' => $code ),
		),
		$code
	);
}

/* -------------------------------------------------------------------------
 * Throttling
 *
 * Login and register are the only two routes that accept unauthenticated
 * credentials, so they are the only two worth guessing against. Both are
 * limited per-IP using transients: enough to blunt credential stuffing without
 * needing a persistent store, and the counters expire on their own.
 * ---------------------------------------------------------------------- */

/** Failed logins allowed per IP before a cool-off. */
const CEREVE_AUTH_LOGIN_MAX_ATTEMPTS = 7;

/** Seconds an IP stays locked out once it trips the limit. */
const CEREVE_AUTH_LOGIN_LOCKOUT = 900;

/** Accounts a single IP may create per hour. */
const CEREVE_AUTH_REGISTER_MAX = 5;

/** Seconds a registration is held back once the limit is reached. */
const CEREVE_AUTH_REGISTER_LOCKOUT = 3600;

/**
 * Transient key for an IP's attempt counter.
 *
 * @param string $action Counter name.
 * @param string $ip     Client IP.
 * @return string
 */
function cereve_auth_throttle_key( $action, $ip ) {
	return 'cereve_rl_' . $action . '_' . md5( $ip );
}

/**
 * Best-effort client IP.
 *
 * Only REMOTE_ADDR is trusted. Proxy headers are attacker-controlled unless
 * you know a reverse proxy rewrites them, and trusting them here would let a
 * caller rotate its identity for free.
 *
 * @return string
 */
function cereve_auth_client_ip() {
	$ip = isset( $_SERVER['REMOTE_ADDR'] ) ? sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) : '';

	return '' !== $ip ? $ip : 'unknown';
}

/**
 * Refuse the request when this IP is over its limit.
 *
 * @param string $action Counter name.
 * @param int    $max    Attempts allowed.
 * @param int    $window Lockout length in seconds.
 * @return WP_REST_Response|null Response to send, or null to proceed.
 */
function cereve_auth_throttled( $action, $max, $window ) {
	$key  = cereve_auth_throttle_key( $action, cereve_auth_client_ip() );
	$used = (int) get_transient( $key );

	if ( $used < $max ) {
		return null;
	}

	$retry = (int) get_option( $key . '_until', 0 ) - time();

	return cereve_auth_error(
		new WP_Error(
			'cereve_too_many_attempts',
			sprintf(
				/* translators: %d: number of minutes to wait. */
				__( 'Too many attempts. Please try again in %d minutes.', 'cereve' ),
				max( 1, (int) ceil( $retry / 60 ) )
			)
		),
		429
	);
}

/**
 * Count one attempt against this IP and start the clock on their first try.
 *
 * @param string $action Counter name.
 * @param int    $max    Attempts allowed.
 * @param int    $window Lockout length in seconds.
 */
function cereve_auth_count_attempt( $action, $max, $window ) {
	$key  = cereve_auth_throttle_key( $action, cereve_auth_client_ip() );
	$used = (int) get_transient( $key );

	set_transient( $key, $used + 1, $window );

	if ( 0 === $used ) {
		add_option( $key . '_until', time() + $window, '', false );
	}
}

/**
 * Drop this IP's counter, called after a successful sign-in so a legitimate
 * shopper who mistyped twice is not left one mistake from a lockout.
 *
 * @param string $action Counter name.
 */
function cereve_auth_clear_attempts( $action ) {
	$key = cereve_auth_throttle_key( $action, cereve_auth_client_ip() );

	delete_transient( $key );
	delete_option( $key . '_until' );
}

/**
 * Start a WordPress session for the user and fire the login hooks so
 * WooCommerce and other listeners react as they would on wp-login.php.
 *
 * @param WP_User $user User to sign in.
 * @return array Customer payload.
 */
function cereve_auth_sign_in( WP_User $user ) {
	wp_set_current_user( $user->ID, $user->user_login );
	wp_set_auth_cookie( $user->ID, true, is_ssl() );
	do_action( 'wp_login', $user->user_login, $user );

	return cereve_auth_payload( $user );
}

/* -------------------------------------------------------------------------
 * Handlers
 * ---------------------------------------------------------------------- */

/**
 * Create a customer account and sign the new customer in.
 *
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response|WP_Error
 */
function cereve_auth_register( WP_REST_Request $request ) {
	$locked = cereve_auth_throttled( 'register', CEREVE_AUTH_REGISTER_MAX, CEREVE_AUTH_REGISTER_LOCKOUT );
	if ( $locked instanceof WP_REST_Response ) {
		return $locked;
	}

	// Honeypot. A real browser leaves this hidden field empty; a naive bot fills
	// every input it finds. Accepting the request silently is better than a
	// banner that tells a scraper what tripped it.
	if ( '' !== trim( (string) $request->get_param( 'website' ) ) ) {
		return new WP_REST_Response( array( 'id' => 0 ), 201 );
	}

	// Counted before anything else and never cleared on success: the point is
	// to cap how many accounts one IP can create, not how many it can fail.
	cereve_auth_count_attempt( 'register', CEREVE_AUTH_REGISTER_MAX, CEREVE_AUTH_REGISTER_LOCKOUT );

	$email    = $request->get_param( 'email' );
	$password = $request->get_param( 'password' );
	$username = $request->get_param( 'username' );

	if ( ! is_email( $email ) ) {
		return cereve_auth_error(
			new WP_Error( 'cereve_bad_email', __( 'Enter a valid email address.', 'cereve' ) )
		);
	}

	// WooCommerce owns the rules here: strength, duplicate email, reserved names.
	$user_id = wc_create_new_customer(
		$email,
		$username ? sanitize_user( $username ) : '',
		$password,
		array(
			'first_name' => sanitize_text_field( $request->get_param( 'first_name' ) ),
			'last_name'  => sanitize_text_field( $request->get_param( 'last_name' ) ),
			'phone'      => sanitize_text_field( $request->get_param( 'phone' ) ),
		)
	);

	if ( is_wp_error( $user_id ) ) {
		return cereve_auth_error( $user_id );
	}

	// Carry the address straight onto the customer record.
	$customer = new WC_Customer( $user_id );
	$customer->set_billing_email( $email );

	foreach ( array( 'first_name', 'last_name', 'phone' ) as $field ) {
		$value = $request->get_param( $field );
		if ( $value ) {
			$customer->{"set_billing_{$field}"}( sanitize_text_field( $value ) );
			$customer->{"set_shipping_{$field}"}( sanitize_text_field( $value ) );
		}
	}

	foreach ( array( 'company', 'address_1', 'address_2', 'city', 'state', 'postcode', 'country' ) as $field ) {
		$value = $request->get_param( $field );
		if ( $value ) {
			$customer->{"set_billing_{$field}"}( sanitize_text_field( $value ) );
			$customer->{"set_shipping_{$field}"}( sanitize_text_field( $value ) );
		}
	}

	$customer->save();

	$user = get_user_by( 'id', $user_id );

	return new WP_REST_Response( cereve_auth_sign_in( $user ), 201 );
}

/**
 * Exchange credentials for a session cookie.
 *
 * Errors are deliberately generic so the endpoint cannot be used to discover
 * whether an email address has an account.
 *
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response|WP_Error
 */
function cereve_auth_login( WP_REST_Request $request ) {
	$locked = cereve_auth_throttled( 'login', CEREVE_AUTH_LOGIN_MAX_ATTEMPTS, CEREVE_AUTH_LOGIN_LOCKOUT );
	if ( $locked instanceof WP_REST_Response ) {
		return $locked;
	}

	$identifier = $request->get_param( 'email' );
	$password   = $request->get_param( 'password' );

	// Sign in by email, or by username when one was given.
	if ( is_email( $identifier ) ) {
		$user = get_user_by( 'email', $identifier );
		if ( $user ) {
			$identifier = $user->user_login;
		}
	}

	$user = wp_authenticate( $identifier, $password );

	if ( is_wp_error( $user ) ) {
		cereve_auth_count_attempt( 'login', CEREVE_AUTH_LOGIN_MAX_ATTEMPTS, CEREVE_AUTH_LOGIN_LOCKOUT );

		return cereve_auth_error(
			new WP_Error( 'cereve_bad_credentials', __( 'Incorrect email or password.', 'cereve' ) ),
			401
		);
	}

	cereve_auth_clear_attempts( 'login' );

	return new WP_REST_Response( cereve_auth_sign_in( $user ), 200 );
}

/**
 * Return the signed-in customer.
 *
 * @return WP_REST_Response|WP_Error
 */
function cereve_auth_me() {
	$guard = cereve_auth_require_login();
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}

	return new WP_REST_Response( cereve_auth_payload( wp_get_current_user() ), 200 );
}

/**
 * Update the signed-in customer's profile and addresses.
 *
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response|WP_Error
 */
function cereve_auth_update( WP_REST_Request $request ) {
	$guard = cereve_auth_require_login();
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}

	$user     = wp_get_current_user();
	$customer = new WC_Customer( $user->ID );

	$email = $request->get_param( 'email' );
	if ( $email && is_email( $email ) && $email !== $user->user_email ) {
		$existing = email_exists( $email );
		if ( $existing && (int) $existing !== $user->ID ) {
			return cereve_auth_error(
				new WP_Error( 'cereve_email_taken', __( 'That email address is already in use.', 'cereve' ) )
			);
		}
		wp_update_user(
			array(
				'ID'         => $user->ID,
				'user_email' => sanitize_email( $email ),
			)
		);
	}

	// New password: only change it when one was actually supplied.
	$password = $request->get_param( 'password' );
	if ( $password ) {
		$error = cereve_auth_validate_password( $password );
		if ( is_wp_error( $error ) ) {
			return cereve_auth_error( $error );
		}
		wp_set_password( $password, $user->ID );
	}

	$fields = array( 'first_name', 'last_name', 'phone' );
	$address = array( 'company', 'address_1', 'address_2', 'city', 'state', 'postcode', 'country' );

	foreach ( $fields as $field ) {
		$value = $request->get_param( $field );
		if ( null !== $value ) {
			$clean = sanitize_text_field( $value );
			$customer->{"set_billing_{$field}"}( $clean );
			$customer->{"set_shipping_{$field}"}( $clean );
		}
	}

	foreach ( $address as $field ) {
		$billing  = $request->get_param( "billing_{$field}" );
		$shipping = $request->get_param( "shipping_{$field}" );
		if ( null !== $billing ) {
			$customer->{"set_billing_{$field}"}( sanitize_text_field( $billing ) );
		}
		if ( null !== $shipping ) {
			$customer->{"set_shipping_{$field}"}( sanitize_text_field( $shipping ) );
		}
	}

	$customer->set_billing_email( $customer->get_billing_email() ? $customer->get_billing_email() : $user->user_email );
	$customer->save();

	return new WP_REST_Response( cereve_auth_payload( get_user_by( 'id', $user->ID ) ), 200 );
}

/**
 * Enforce WooCommerce's password rules on direct password changes.
 *
 * @param string $password Candidate password.
 * @return true|WP_Error
 */
function cereve_auth_validate_password( $password ) {
	$errors = new WP_Error();

	if ( strlen( $password ) < 8 ) {
		$errors->add( 'cereve_weak_password', __( 'Password must be at least 8 characters.', 'cereve' ) );
	}

	return $errors->has_errors() ? $errors : true;
}

/**
 * Destroy the session and clear the auth cookies.
 *
 * @return WP_REST_Response
 */
function cereve_auth_logout() {
	wp_destroy_current_session();
	wp_clear_auth_cookie();

	return new WP_REST_Response( array( 'logged_in' => false ), 200 );
}

/**
 * Order history for the signed-in customer.
 *
 * The Store API has no customer-orders route and wc/v3 needs consumer secrets,
 * so this reads the orders directly under the session we already verified.
 *
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response|WP_Error
 */
function cereve_auth_orders( WP_REST_Request $request ) {
	$guard = cereve_auth_require_login();
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}

	$user_id = get_current_user_id();
	$page    = max( 1, (int) $request->get_param( 'page' ) );
	$limit   = min( 50, max( 1, (int) $request->get_param( 'per_page' ) ) );

	$orders = wc_get_orders(
		array(
			'customer_id' => $user_id,
			'limit'       => $limit,
			'paged'       => $page,
			'orderby'     => 'date',
			'order'       => 'DESC',
		)
	);

	$items = array();

	foreach ( $orders as $order ) {
		$lines = array();

		foreach ( $order->get_items() as $item ) {
			$product = $item->get_product();
			$image   = $product ? $product->get_image_id() : 0;

			$lines[] = array(
				'name'     => $item->get_name(),
				'quantity' => (int) $item->get_quantity(),
				'total'    => (string) $item->get_total(),
				'image'    => $image ? wp_get_attachment_image_url( $image, 'woocommerce_thumbnail' ) : null,
			);
		}

		$items[] = array(
			'id'          => $order->get_id(),
			'number'      => $order->get_order_number(),
			'status'      => wc_get_order_status_name( $order->get_status() ),
			'status_slug' => $order->get_status(),
			'date'        => wc_format_datetime( $order->get_date_created() ),
			'total'       => $order->get_total(),
			'currency'    => $order->get_currency(),
			'payment'     => $order->get_payment_method_title(),
			'method'      => $order->get_payment_method(),
			'items'       => $lines,
		);
	}

	return new WP_REST_Response(
		array(
			'items' => $items,
			'total' => wc_get_customer_order_count( $user_id ),
			'page'  => $page,
		),
		200
	);
}

/**
 * Format an order address as a list of display lines.
 *
 * @param WC_Order $order Order to read.
 * @param string   $type  billing|shipping.
 * @return string[]
 */
function cereve_auth_address( WC_Order $order, $type = 'billing' ) {
	if ( 'shipping' === $type ) {
		$name    = trim( $order->get_shipping_first_name() . ' ' . $order->get_shipping_last_name() );
		$lines   = array( $order->get_shipping_address_1(), $order->get_shipping_address_2() );
		$locality = trim( $order->get_shipping_city() . ' ' . $order->get_shipping_state() . ' ' . $order->get_shipping_postcode() );
		$country  = $order->get_shipping_country();
	} else {
		$name    = trim( $order->get_billing_first_name() . ' ' . $order->get_billing_last_name() );
		$lines   = array( $order->get_billing_address_1(), $order->get_billing_address_2() );
		$locality = trim( $order->get_billing_city() . ' ' . $order->get_billing_state() . ' ' . $order->get_billing_postcode() );
		$country  = $order->get_billing_country();
	}

	$out = array( $name );

	foreach ( $lines as $line ) {
		$line = trim( (string) $line );
		if ( '' !== $line ) {
			$out[] = $line;
		}
	}

	if ( '' !== $locality ) {
		$out[] = $locality;
	}
	if ( '' !== $country ) {
		$out[] = $country;
	}

	return array_values( array_filter( $out, 'strlen' ) );
}

/**
 * A single order, for the order detail view. Owners only.
 *
 * @param WP_REST_Request $request Request.
 * @return WP_REST_Response|WP_Error
 */
function cereve_auth_order( WP_REST_Request $request ) {
	$guard = cereve_auth_require_login();
	if ( is_wp_error( $guard ) ) {
		return $guard;
	}

	$order = wc_get_order( (int) $request->get_param( 'id' ) );

	// 404 for someone else's order rather than 403, so this cannot be used to
	// discover which order ids exist.
	if ( ! $order || (int) $order->get_customer_id() !== (int) get_current_user_id() ) {
		return new WP_Error(
			'cereve_order_not_found',
			__( 'Order not found.', 'cereve' ),
			array( 'status' => 404 )
		);
	}

	$items = array();

	foreach ( $order->get_items() as $item ) {
		$product = $item->get_product();
		$image   = $product ? $product->get_image_id() : 0;

		$items[] = array(
			'name'     => $item->get_name(),
			'quantity' => (int) $item->get_quantity(),
			'subtotal' => (string) $item->get_subtotal(),
			'total'    => (string) $item->get_total(),
			'sku'      => $product ? $product->get_sku() : null,
			'image'    => $image ? wp_get_attachment_image_url( $image, 'woocommerce_thumbnail' ) : null,
		);
	}

	$status = $order->get_status();

	return new WP_REST_Response(
		array(
			'id'               => $order->get_id(),
			'number'           => $order->get_order_number(),
			'status'           => wc_get_order_status_name( $status ),
			'status_slug'      => $status,
			'date'             => wc_format_datetime( $order->get_date_created() ),
			'currency'         => $order->get_currency(),
			'subtotal'         => $order->get_subtotal(),
			'discount'         => $order->get_discount_total(),
			'coupons'          => array_values( $order->get_coupon_codes() ),
			'shipping'         => $order->get_shipping_total(),
			'shipping_method'  => $order->get_shipping_method(),
			'tax'              => $order->get_total_tax(),
			'total'            => $order->get_total(),
			'payment'          => $order->get_payment_method_title(),
			'method'           => $order->get_payment_method(),
			'transaction'      => $order->get_transaction_id(),
			'note'             => $order->get_customer_note(),
			'billing'          => cereve_auth_address( $order, 'billing' ),
			'shipping_address' => cereve_auth_address( $order, 'shipping' ),
			'items'            => $items,
		),
		200
	);
}
