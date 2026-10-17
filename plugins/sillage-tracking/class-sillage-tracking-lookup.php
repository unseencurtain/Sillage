<?php
/**
 * The storefront's public parcel lookup: `POST /wp-json/sillage/v1/track`.
 *
 * The shop's own Order Tracking page (`/order-tracking`) asks a shopper for an order number (or a
 * tracking number) *and* the email address used at checkout, and answers with the parcels we hold
 * for that order. The order number alone is guessable, so both parts are required and a wrong email
 * is answered exactly like an unknown order: the reply never reveals whether the order exists.
 *
 * Nothing is cached and nothing is written: this route only reads the `_sillage_tracking` meta that
 * `sillage-bridge` already records, so it cannot disagree with the tracking email.
 *
 * @package Sillage_Tracking
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Serves the parcel lookup.
 */
final class Sillage_Tracking_Lookup {

	/**
	 * Route path, relative to the `sillage/v1` namespace.
	 */
	const ROUTE = '/track';

	/**
	 * Lookups allowed from one client per window.
	 */
	const RATE_LIMIT = 30;

	/**
	 * Length of the rate-limit window, in seconds.
	 */
	const RATE_WINDOW = 600;

	/**
	 * Hook the route up.
	 */
	public static function register(): void {
		add_action( 'rest_api_init', array( __CLASS__, 'register_route' ) );
	}

	/**
	 * Declare the route.
	 */
	public static function register_route(): void {
		register_rest_route(
			'sillage/v1',
			self::ROUTE,
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'permission_callback' => '__return_true',
				'callback'            => array( __CLASS__, 'handle' ),
				'args'                => array(
					'order' => array(
						'required'          => true,
						'type'              => 'string',
						'sanitize_callback' => 'sanitize_text_field',
					),
					'email' => array(
						'required'          => true,
						'type'              => 'string',
						'sanitize_callback' => 'sanitize_email',
					),
				),
			)
		);
	}

	/**
	 * Answer one lookup.
	 *
	 * @param WP_REST_Request $request Request carrying `order` and `email`.
	 * @return WP_REST_Response
	 */
	public static function handle( WP_REST_Request $request ) {
		$term  = trim( (string) $request->get_param( 'order' ) );
		$email = strtolower( trim( (string) $request->get_param( 'email' ) ) );

		if ( '' === $term || ! is_email( $email ) ) {
			return new WP_REST_Response(
				array(
					'ok'    => false,
					'error' => 'invalid',
				),
				200
			);
		}

		if ( self::is_rate_limited() ) {
			return new WP_REST_Response(
				array(
					'ok'    => false,
					'error' => 'rate_limited',
				),
				429
			);
		}

		$order = self::find_order( $term );

		// An unknown order and a mismatched email answer the same way, on purpose.
		if ( ! $order instanceof WC_Order || strtolower( (string) $order->get_billing_email() ) !== $email ) {
			return new WP_REST_Response(
				array(
					'ok'    => false,
					'error' => 'not_found',
				),
				200
			);
		}

		/**
		 * Filter the parcel lookup payload before it is returned.
		 *
		 * @param array<string, mixed> $payload Data for the storefront's tracking page.
		 * @param WC_Order             $order   The matched order.
		 */
		$payload = apply_filters( 'sillage_tracking_lookup_payload', self::payload( $order ), $order );

		return new WP_REST_Response( $payload, 200 );
	}

	/**
	 * Find the order a shopper's term refers to.
	 *
	 * The term may be the order number the customer sees, the internal order ID, or a tracking
	 * number printed on a supplier's paperwork.
	 *
	 * @param string $term Order number, order ID or tracking number.
	 * @return WC_Order|null
	 */
	private static function find_order( string $term ): ?WC_Order {
		if ( ctype_digit( $term ) ) {
			$order = wc_get_order( (int) $term );
			if ( $order instanceof WC_Order ) {
				return $order;
			}
		}

		$by_number = wc_get_orders(
			array(
				'limit'      => 1,
				'return'     => 'objects',
				'meta_query' => array( // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
					array(
						'key'   => '_order_number',
						'value' => $term,
					),
				),
			)
		);
		if ( ! empty( $by_number[0] ) && $by_number[0] instanceof WC_Order ) {
			return $by_number[0];
		}

		global $wpdb;
		$by_tracking = wc_get_orders(
			array(
				'limit'      => 1,
				'return'     => 'objects',
				'meta_query' => array( // phpcs:ignore WordPress.DB.SlowDBQuery.slow_db_query_meta_query
					array(
						'key'     => '_sillage_tracking',
						'value'   => '%' . $wpdb->esc_like( $term ) . '%',
						'compare' => 'LIKE',
					),
				),
			)
		);
		if ( ! empty( $by_tracking[0] ) && $by_tracking[0] instanceof WC_Order ) {
			return $by_tracking[0];
		}

		return null;
	}

	/**
	 * What the storefront is told about an order it has already proved ownership of.
	 *
	 * @param WC_Order $order Matched order.
	 * @return array<string, mixed>
	 */
	private static function payload( WC_Order $order ): array {
		$parcels = array();
		foreach ( sillage_tracking_parcels( $order ) as $parcel ) {
			$parcels[] = array(
				'courier' => (string) $parcel['courier'],
				'code'    => (string) $parcel['code'],
				'url'     => (string) $parcel['url'],
			);
		}

		$items = array();
		foreach ( $order->get_items() as $item ) {
			$product = $item->get_product();
			$items[] = array(
				'name'     => (string) $item->get_name(),
				'quantity' => (int) $item->get_quantity(),
				'image'    => $product ? (string) wp_get_attachment_image_url( $product->get_image_id(), 'woocommerce_thumbnail' ) : '',
			);
		}

		$created = $order->get_date_created();

		return array(
			'ok'      => true,
			'order'   => array(
				'number'       => (string) $order->get_order_number(),
				'status'       => (string) $order->get_status(),
				'status_label' => wc_get_order_status_name( $order->get_status() ),
				'placed'       => $created ? gmdate( 'c', $created->getTimestamp() ) : '',
				'currency'     => (string) $order->get_currency(),
			),
			'parcels' => $parcels,
			'items'   => $items,
		);
	}

	/**
	 * Has this client looked up too much in the current window?
	 *
	 * The storefront sits behind the edge proxy, so the client address is the first hop of
	 * `X-Forwarded-For` when the proxy supplies one and the socket address otherwise. A missing
	 * address is never limited, so a misconfigured proxy cannot lock the shop out.
	 *
	 * @return bool
	 */
	private static function is_rate_limited(): bool {
		$client = self::client_address();
		if ( '' === $client ) {
			return false;
		}

		$key   = 'sillage_track_' . md5( $client );
		$count = (int) get_transient( $key );

		if ( $count >= self::RATE_LIMIT ) {
			return true;
		}

		set_transient( $key, $count + 1, self::RATE_WINDOW );

		return false;
	}

	/**
	 * The client's address, as far as the proxy chain lets us tell.
	 *
	 * @return string
	 */
	private static function client_address(): string {
		$forwarded = isset( $_SERVER['HTTP_X_FORWARDED_FOR'] )
			? sanitize_text_field( wp_unslash( (string) $_SERVER['HTTP_X_FORWARDED_FOR'] ) )
			: '';

		if ( '' !== $forwarded ) {
			$first = trim( explode( ',', $forwarded )[0] );
			if ( filter_var( $first, FILTER_VALIDATE_IP ) ) {
				return $first;
			}
		}

		$remote = isset( $_SERVER['REMOTE_ADDR'] )
			? sanitize_text_field( wp_unslash( (string) $_SERVER['REMOTE_ADDR'] ) )
			: '';

		return filter_var( $remote, FILTER_VALIDATE_IP ) ? $remote : '';
	}
}
