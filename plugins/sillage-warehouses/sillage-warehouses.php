<?php
/**
 * Plugin Name: Sillage Warehouses
 * Description: Two warehouses ("Location A" and "Location B") with country-based delivery rules, one shipping charge per location, and per-line location records on orders.
 * Version: 1.0.0
 * Requires PHP: 7.4
 * Requires Plugins: woocommerce
 *
 * Rules, by destination country (derived from `_sillage_ship_countries` on each product):
 *  1. Only warehouse BTS delivers there: only BTS products are shown.
 *  2. Only warehouse BeautyFort delivers there: only BeautyFort products are shown.
 *  3. Both deliver there: all products are shown; each location ships and charges separately.
 *  4. Neither delivers there: no products are shown ("not delivered" state).
 *
 * Internal vendor slugs stay on the server and in admin data. Customer-facing text, HTML, and
 * emails only ever say "Location A" or "Location B".
 */

defined( 'ABSPATH' ) || exit;

const SILLAGE_WH_LOCATIONS = array(
	'bts'        => 'A',
	'beautyfort' => 'B',
);

/** Customer-facing warehouse names, keyed by letter. Admin screens still show the letters. */
const SILLAGE_WH_NAMES = array(
	'A' => 'Blossom',
	'B' => 'Fern',
);

const SILLAGE_WH_CACHE_GROUP = 'sillage_warehouses';

/* Shipping prices, markup, threshold and the total-or-per-location display (sillage-shipping.php). */
require_once __DIR__ . '/sillage-shipping.php';
const SILLAGE_WH_TRANSIENT   = 'sillage_wh_vendor_countries';

/** Country sets per warehouse, derived from `_sillage_ship_countries` on published, image-bearing products. */
function sillage_wh_vendor_countries(): array {
	$cached = wp_cache_get( 'vendor_countries', SILLAGE_WH_CACHE_GROUP );
	if ( is_array( $cached ) ) {
		return $cached;
	}
	$stored = get_transient( SILLAGE_WH_TRANSIENT );
	if ( is_array( $stored ) ) {
		wp_cache_set( 'vendor_countries', $stored, SILLAGE_WH_CACHE_GROUP, 300 );
		return $stored;
	}

	global $wpdb;
	$rows = $wpdb->get_results(
		"SELECT vendor.meta_value AS vendor, ship.meta_value AS countries
		FROM {$wpdb->postmeta} vendor
		INNER JOIN {$wpdb->postmeta} ship ON ship.post_id = vendor.post_id AND ship.meta_key = '_sillage_ship_countries'
		INNER JOIN {$wpdb->postmeta} image ON image.post_id = vendor.post_id AND image.meta_key = '_external_thumbnail_url' AND image.meta_value <> ''
		INNER JOIN {$wpdb->posts} p ON p.ID = vendor.post_id AND p.post_status = 'publish' AND p.post_type = 'product'
		WHERE vendor.meta_key = '_sillage_vendor' AND vendor.meta_value IN ('bts', 'beautyfort')",
		ARRAY_A
	);

	$sets = array_fill_keys( array_keys( SILLAGE_WH_LOCATIONS ), array() );
	foreach ( (array) $rows as $row ) {
		$vendor  = strtolower( (string) $row['vendor'] );
		$decoded = json_decode( (string) $row['countries'], true );
		if ( ! isset( $sets[ $vendor ] ) || ! is_array( $decoded ) ) {
			continue;
		}
		foreach ( $decoded as $code ) {
			if ( is_string( $code ) && preg_match( '/^[A-Za-z]{2}$/', $code ) ) {
				$sets[ $vendor ][ strtoupper( $code ) ] = true;
			}
		}
	}
	foreach ( $sets as $vendor => $codes ) {
		$list = array_keys( $codes );
		sort( $list );
		$sets[ $vendor ] = $list;
	}

	set_transient( SILLAGE_WH_TRANSIENT, $sets, HOUR_IN_SECONDS );
	wp_cache_set( 'vendor_countries', $sets, SILLAGE_WH_CACHE_GROUP, 300 );
	return $sets;
}

/**
 * Version stamp for public catalogue caches. Every cached catalogue response embeds it in its key,
 * so bumping it invalidates all of them at once without enumerating keys.
 */
function sillage_wh_cache_version(): string {
	$version = wp_cache_get( 'cache_version', SILLAGE_WH_CACHE_GROUP );
	if ( ! is_string( $version ) || '' === $version ) {
		$version = (string) round( microtime( true ) * 1000 );
		wp_cache_set( 'cache_version', $version, SILLAGE_WH_CACHE_GROUP, 0 );
	}
	return $version;
}

/** Fresh entries live this long. The stale copy stays for an hour so a refresh never leaves a gap. */
const SILLAGE_WH_FRESH_TTL = 300;
const SILLAGE_WH_STALE_TTL = 3600;
const SILLAGE_WH_LOCK_TTL  = 30;

/**
 * Read a cached catalogue entry. When the fresh copy has expired and another request is already
 * rebuilding it, the stale copy is served instead. A busy moment then costs one heavy query, not
 * one per visitor. Returns array( 'serve' => bool, 'value' => mixed ).
 */
function sillage_wh_cache_read( string $base ): array {
	$fresh = wp_cache_get( $base . '_' . sillage_wh_cache_version(), SILLAGE_WH_CACHE_GROUP );
	if ( is_array( $fresh ) ) {
		return array(
			'serve' => true,
			'value' => $fresh,
		);
	}
	$stale = wp_cache_get( $base . '_stale', SILLAGE_WH_CACHE_GROUP );
	if ( is_array( $stale ) && ! wp_cache_add( $base . '_lock', 1, SILLAGE_WH_CACHE_GROUP, SILLAGE_WH_LOCK_TTL ) ) {
		return array(
			'serve' => true,
			'value' => $stale,
		);
	}
	return array(
		'serve' => false,
		'value' => null,
	);
}

/** Store a freshly built catalogue entry and release the rebuild lock. */
function sillage_wh_cache_write( string $base, $value ): void {
	wp_cache_set( $base . '_' . sillage_wh_cache_version(), $value, SILLAGE_WH_CACHE_GROUP, SILLAGE_WH_FRESH_TTL );
	wp_cache_set( $base . '_stale', $value, SILLAGE_WH_CACHE_GROUP, SILLAGE_WH_STALE_TTL );
	wp_cache_delete( $base . '_lock', SILLAGE_WH_CACHE_GROUP );
}

/** Drop cached country sets and catalogue responses after a product change or sync. */
/**
 * Invalidate catalogue caches after a product write. Debounced to one bump per minute: a sync writes
 * many products, and one bump per product would make every visitor rebuild every catalogue key.
 * Entries also expire on their own within SILLAGE_WH_FRESH_TTL, so a skipped bump only delays a
 * change by minutes.
 */
function sillage_wh_flush_cache(): void {
	if ( ! wp_cache_add( 'bump_gate', 1, SILLAGE_WH_CACHE_GROUP, 60 ) ) {
		return;
	}
	sillage_wh_bump_cache_version();
}

function sillage_wh_bump_cache_version(): void {
	wp_cache_set( 'cache_version', (string) round( microtime( true ) * 1000 ), SILLAGE_WH_CACHE_GROUP, 0 );
}

/**
 * Runs once per sync, from finalize. Rebuilds the country sets here, on the sync request, so the
 * heavy join never runs on a visitor's page load (the delivery endpoint reads them on every load).
 */
function sillage_wh_on_sync_finished(): void {
	delete_transient( SILLAGE_WH_TRANSIENT );
	wp_cache_delete( 'vendor_countries', SILLAGE_WH_CACHE_GROUP );
	sillage_wh_vendor_countries();
	sillage_wh_bump_cache_version();
	sillage_wh_sync_wc_countries();
}

const SILLAGE_WH_SELL_HASH = 'sillage_wh_selling_hash';

/** Every country either warehouse delivers to, sorted. This is the store's selling list. */
function sillage_wh_selling_countries(): array {
	$union = array();
	foreach ( sillage_wh_vendor_countries() as $codes ) {
		foreach ( (array) $codes as $code ) {
			$union[ $code ] = true;
		}
	}
	$list = array_keys( $union );
	sort( $list );
	return $list;
}

/**
 * Keep WooCommerce > General > "Selling location(s)" and "Shipping location(s)" in step with the
 * warehouses, so checkout only offers countries we can actually ship to (fail closed).
 * Writes only when the list changes. An empty list leaves the current setting alone.
 */
function sillage_wh_sync_wc_countries(): void {
	if ( ! class_exists( 'WooCommerce' ) ) {
		return;
	}
	$list = sillage_wh_selling_countries();
	if ( ! $list ) {
		return;
	}
	$hash = md5( implode( ',', $list ) );
	if ( get_option( SILLAGE_WH_SELL_HASH ) === $hash && 'specific' === get_option( 'woocommerce_allowed_countries' ) ) {
		return;
	}
	update_option( 'woocommerce_allowed_countries', 'specific' );
	update_option( 'woocommerce_specific_allowed_countries', $list );
	// Empty ship_to means "Ship to all countries you sell to", which is the intended behaviour.
	update_option( 'woocommerce_ship_to_countries', '' );
	update_option( SILLAGE_WH_SELL_HASH, $hash, false );
}
add_action( 'admin_init', 'sillage_wh_sync_wc_countries' );

/** Warehouse slugs that deliver to a two-letter ISO country code. */
function sillage_wh_country_vendors( string $country ): array {
	$out = array();
	foreach ( sillage_wh_vendor_countries() as $vendor => $codes ) {
		if ( in_array( $country, $codes, true ) ) {
			$out[] = $vendor;
		}
	}
	return $out;
}

/** Warehouse slugs in scope for a country. An empty country means no restriction (both warehouses). */
function sillage_wh_scope_vendors( string $country ): array {
	return '' === $country ? array_keys( SILLAGE_WH_LOCATIONS ) : sillage_wh_country_vendors( $country );
}

/** Two-letter ISO code from the `sillage_country` request parameter, or empty string. */
function sillage_wh_request_country( WP_REST_Request $request ): string {
	$raw = $request->get_param( 'sillage_country' );
	if ( ! is_string( $raw ) || ! preg_match( '/^[A-Za-z]{2}$/', $raw ) ) {
		return '';
	}
	return strtoupper( $raw );
}

/** Warehouse slug of a product, or empty string when it is not a known warehouse. */
function sillage_wh_product_vendor( int $product_id ): string {
	$vendor = strtolower( (string) get_post_meta( $product_id, '_sillage_vendor', true ) );
	return isset( SILLAGE_WH_LOCATIONS[ $vendor ] ) ? $vendor : '';
}

/** Customer-facing location name for a warehouse slug. */
function sillage_wh_location_name( string $vendor ): string {
	return 'Warehouse ' . SILLAGE_WH_NAMES[ SILLAGE_WH_LOCATIONS[ $vendor ] ];
}

/* ------------------------------------------------------------------
 * REST endpoints
 * ----------------------------------------------------------------*/
add_action(
	'rest_api_init',
	static function () {
		register_rest_route(
			'sillage/v1',
			'/delivery',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'permission_callback' => '__return_true',
				'callback'            => 'sillage_wh_delivery_endpoint',
			)
		);

		register_rest_route(
			'sillage/v1',
			'/products/catalog-meta',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'permission_callback' => '__return_true',
				'callback'            => 'sillage_wh_catalog_meta_endpoint',
				'args'                => array(
					'ids' => array(
						'required'          => true,
						'sanitize_callback' => 'sanitize_text_field',
					),
				),
			)
		);

		register_rest_route(
			'sillage/v1',
			'/products/catalog-counts',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'permission_callback' => '__return_true',
				'callback'            => 'sillage_wh_catalog_counts_endpoint',
			)
		);
	}
);

/**
 * Countries served by at least one warehouse (with names), the country set of each location, and
 * the visitor's country from a trusted proxy header. Country codes only; the IP is never returned.
 */
function sillage_wh_delivery_endpoint( WP_REST_Request $request ) {
	unset( $request );
	$sets      = sillage_wh_vendor_countries();
	$union     = array();
	$locations = array();
	foreach ( SILLAGE_WH_LOCATIONS as $vendor => $letter ) {
		$locations[ $letter ] = $sets[ $vendor ] ?? array();
		foreach ( $locations[ $letter ] as $code ) {
			$union[ $code ] = true;
		}
	}

	$names     = function_exists( 'WC' ) && WC()->countries ? WC()->countries->get_countries() : array();
	$countries = array();
	foreach ( array_keys( $union ) as $code ) {
		if ( isset( $names[ $code ] ) ) {
			$countries[ $code ] = $names[ $code ];
		}
	}
	asort( $countries );

	// Only trust a country header set by the edge proxy (Cloudflare or Caddy header passthrough).
	$geo = null;
	foreach ( array( 'HTTP_CF_IPCOUNTRY', 'HTTP_X_COUNTRY_CODE' ) as $header ) {
		if ( empty( $_SERVER[ $header ] ) ) {
			continue;
		}
		$value = strtoupper( substr( preg_replace( '/[^A-Za-z]/', '', (string) wp_unslash( $_SERVER[ $header ] ) ), 0, 2 ) );
		if ( isset( $union[ $value ] ) ) {
			$geo = $value;
			break;
		}
	}

	$response = rest_ensure_response(
		array(
			'countries' => $countries,
			'locations' => $locations,
			'geo'       => $geo,
		)
	);
	$response->header( 'Cache-Control', 'private, no-store' );
	return $response;
}

/** Supplier location and destination-country metadata for a batch of published product IDs. */
function sillage_wh_catalog_meta_endpoint( WP_REST_Request $request ) {
	$ids = array_slice( array_unique( array_filter( array_map( 'absint', explode( ',', (string) $request->get_param( 'ids' ) ) ) ) ), 0, 100 );
	$out = array();
	foreach ( $ids as $id ) {
		if ( 'publish' !== get_post_status( $id ) || 'product' !== get_post_type( $id ) ) {
			continue;
		}
		$vendor    = sillage_wh_product_vendor( $id );
		$image_url = get_post_meta( $id, '_external_thumbnail_url', true );
		if ( '' === $vendor || ! is_string( $image_url ) || '' === trim( $image_url ) ) {
			continue;
		}
		$raw       = get_post_meta( $id, '_sillage_ship_countries', true );
		$countries = is_string( $raw ) ? json_decode( $raw, true ) : array();
		$out[ (string) $id ] = array(
			'location'  => SILLAGE_WH_LOCATIONS[ $vendor ],
			'countries' => is_array( $countries ) ? array_values( array_filter( array_map( 'strtoupper', $countries ), 'is_string' ) ) : array(),
		);
	}
	$names = function_exists( 'WC' ) && WC()->countries ? WC()->countries->get_allowed_countries() : array();
	return rest_ensure_response( array( 'products' => $out, 'countries' => $names ) );
}

/** Category counts for in-stock, image-bearing products from the warehouses that deliver to the country. */
function sillage_wh_catalog_counts_endpoint( WP_REST_Request $request ) {
	global $wpdb;
	$country = sillage_wh_request_country( $request );
	$vendors = sillage_wh_scope_vendors( $country );
	if ( ! $vendors ) {
		return rest_ensure_response( array() );
	}

	// Key by warehouse scope, not country: all countries served by the same warehouses share one entry.
	$cache_base = 'counts_' . md5( implode( ',', $vendors ) );
	$read       = sillage_wh_cache_read( $cache_base );
	if ( $read['serve'] ) {
		return rest_ensure_response( $read['value'] );
	}

	$vendor_list = implode( ',', array_map( static fn( $vendor ) => "'" . esc_sql( $vendor ) . "'", $vendors ) );
	$lookup      = $wpdb->prefix . 'wc_product_meta_lookup';
	$rows        = $wpdb->get_results(
		"SELECT tt.term_id, COUNT(DISTINCT p.ID) AS product_count
		FROM {$wpdb->term_taxonomy} tt
		INNER JOIN {$wpdb->term_relationships} tr ON tr.term_taxonomy_id = tt.term_taxonomy_id
		INNER JOIN {$wpdb->posts} p ON p.ID = tr.object_id AND p.post_type = 'product' AND p.post_status = 'publish'
		INNER JOIN {$wpdb->postmeta} vendor ON vendor.post_id = p.ID AND vendor.meta_key = '_sillage_vendor' AND vendor.meta_value IN ({$vendor_list})
		INNER JOIN {$wpdb->postmeta} image ON image.post_id = p.ID AND image.meta_key = '_external_thumbnail_url' AND image.meta_value <> ''
		INNER JOIN {$lookup} lookup ON lookup.product_id = p.ID AND lookup.stock_status = 'instock'
		WHERE tt.taxonomy = 'product_cat'
		GROUP BY tt.term_id",
		ARRAY_A
	);
	$counts = array();
	foreach ( (array) $rows as $row ) {
		$counts[ (string) $row['term_id'] ] = (int) $row['product_count'];
	}
	sillage_wh_cache_write( $cache_base, $counts );
	return rest_ensure_response( $counts );
}

/* ------------------------------------------------------------------
 * Store API: country scope on product collections
 * ----------------------------------------------------------------*/
add_filter(
	'rest_request_before_callbacks',
	static function ( $response, $handler, WP_REST_Request $request ) {
		unset( $handler );
		if ( '/wc/store/v1/products' === untrailingslashit( $request->get_route() ) ) {
			$GLOBALS['sillage_wh_collection_request'] = $request;
		}
		return $response;
	},
	10,
	3
);

add_action(
	'pre_get_posts',
	static function ( WP_Query $query ): void {
		$request = $GLOBALS['sillage_wh_collection_request'] ?? null;
		if ( ! ( $request instanceof WP_REST_Request ) || ! in_array( 'product', (array) $query->get( 'post_type' ), true ) ) {
			return;
		}

		$vendors = sillage_wh_scope_vendors( sillage_wh_request_country( $request ) );
		if ( ! $vendors ) {
			// Neither warehouse delivers here: return nothing, so the storefront shows "not delivered".
			$query->set( 'post__in', array( 0 ) );
		}

		$meta_query   = (array) $query->get( 'meta_query' );
		$meta_query[] = array(
			'key'     => '_sillage_vendor',
			'value'   => $vendors ? $vendors : array( 'none' ),
			'compare' => 'IN',
		);
		$meta_query[] = array(
			'key'     => '_external_thumbnail_url',
			'value'   => '',
			'compare' => '!=',
		);
		$query->set( 'meta_query', $meta_query );
	},
	9999
);

/* ------------------------------------------------------------------
 * Response cache for public catalogue collections
 * The Store API product list is heavy (meta self-joins on wp_postmeta, SQL_CALC_FOUND_ROWS).
 * Public GET responses are kept in the persistent object cache, keyed by route, query, and
 * warehouse scope. Carts and checkout are never cached.
 * ----------------------------------------------------------------*/
const SILLAGE_WH_STORE_CACHE_ROUTES = array( '/wc/store/v1/products', '/wc/store/v1/products/categories' );

/** Cache base key for a cacheable catalogue request, or null when the request must not be cached. */
function sillage_wh_store_cache_base( WP_REST_Request $request ): ?string {
	$route = untrailingslashit( $request->get_route() );
	if ( 'GET' !== $request->get_method() || ! in_array( $route, SILLAGE_WH_STORE_CACHE_ROUTES, true ) ) {
		return null;
	}
	// The country only selects the warehouse scope, so it is replaced by that scope in the key.
	$params = $request->get_query_params();
	unset( $params['sillage_country'] );
	ksort( $params );
	$scope = implode( ',', sillage_wh_scope_vendors( sillage_wh_request_country( $request ) ) );
	return 'store_' . md5( $route . '?' . http_build_query( $params ) . '|' . $scope );
}

add_filter(
	'rest_pre_dispatch',
	static function ( $result, $server, WP_REST_Request $request ) {
		unset( $server );
		if ( null !== $result ) {
			return $result;
		}
		$base = sillage_wh_store_cache_base( $request );
		if ( null === $base ) {
			return $result;
		}
		$read = sillage_wh_cache_read( $base );
		if ( $read['serve'] ) {
			// Served from cache: the post-dispatch hook must not write it back, or every hit would
			// reset the expiry and a busy shop would never refresh.
			$GLOBALS['sillage_wh_store_served'] = true;
			return new WP_REST_Response( $read['value']['data'], 200, $read['value']['headers'] );
		}
		$GLOBALS['sillage_wh_store_base'] = $base;
		return $result;
	},
	10,
	3
);

add_filter(
	'rest_post_dispatch',
	static function ( $response, $server, WP_REST_Request $request ) {
		unset( $server );
		if ( ! empty( $GLOBALS['sillage_wh_store_served'] ) || ! $response instanceof WP_REST_Response ) {
			return $response;
		}
		$base = $GLOBALS['sillage_wh_store_base'] ?? null;
		unset( $GLOBALS['sillage_wh_store_base'] );
		if ( null === $base || sillage_wh_store_cache_base( $request ) !== $base ) {
			return $response;
		}
		if ( 200 !== $response->get_status() ) {
			wp_cache_delete( $base . '_lock', SILLAGE_WH_CACHE_GROUP );
			return $response;
		}
		sillage_wh_cache_write(
			$base,
			array(
				'data'    => $response->get_data(),
				'headers' => $response->get_headers(),
			)
		);
		return $response;
	},
	999,
	3
);

/* ------------------------------------------------------------------
 * Cart and checkout
 * ----------------------------------------------------------------*/

/**
 * One shipping package per warehouse, so each location is quoted and charged separately. A cart
 * with items from one warehouse is left untouched.
 */
add_filter(
	'woocommerce_cart_shipping_packages',
	static function ( $packages ) {
		$out = array();
		foreach ( (array) $packages as $package ) {
			$groups = array();
			foreach ( (array) ( $package['contents'] ?? array() ) as $key => $item ) {
				$vendor                    = sillage_wh_product_vendor( (int) ( $item['product_id'] ?? 0 ) );
				$groups[ $vendor ][ $key ] = $item;
			}

			if ( count( $groups ) <= 1 ) {
				$vendor = (string) array_key_first( $groups );
				if ( '' !== $vendor ) {
					$package['sillage_location'] = SILLAGE_WH_LOCATIONS[ $vendor ];
				}
				$out[] = $package;
				continue;
			}

			foreach ( $groups as $vendor => $contents ) {
				$part             = $package;
				$part['contents'] = $contents;
				if ( '' !== (string) $vendor ) {
					$part['sillage_location'] = SILLAGE_WH_LOCATIONS[ $vendor ];
				}
				$out[] = $part;
			}
		}
		return $out;
	},
	20
);

add_filter(
	'woocommerce_shipping_package_name',
	static function ( $name, $index, $package ) {
		// Customers never see a warehouse name. With several parcels, each one is numbered.
		if ( empty( $package['sillage_location'] ) || ! function_exists( 'WC' ) || ! WC()->shipping() ) {
			return $name;
		}
		if ( 'per_location' === sillage_ship_rules()['mode'] && count( (array) WC()->shipping()->get_packages() ) > 1 ) {
			return 'Parcel ' . ( (int) $index + 1 );
		}
		return $name;
	},
	10,
	3
);

/*
 * Location records on order lines. Keys start with an underscore, so they are hidden from the
 * customer order view and from customer emails. Admins can read them in the order item meta.
 */
add_action(
	'woocommerce_checkout_create_order_line_item',
	static function ( $item, $cart_item_key, $values, $order ) {
		unset( $cart_item_key, $order );
		$vendor = sillage_wh_product_vendor( (int) ( $values['product_id'] ?? 0 ) );
		if ( '' === $vendor ) {
			return;
		}
		$item->add_meta_data( '_sillage_vendor', $vendor, true );
		$item->add_meta_data( '_sillage_location', SILLAGE_WH_LOCATIONS[ $vendor ], true );
	},
	10,
	4
);

add_action(
	'woocommerce_checkout_create_order_shipping_item',
	static function ( $item, $package_key, $package, $order ) {
		unset( $package_key, $order );
		if ( ! empty( $package['sillage_location'] ) ) {
			$item->add_meta_data( '_sillage_location', $package['sillage_location'], true );
		}
	},
	10,
	4
);

/**
 * Items must be deliverable to the destination country. The storefront flags them first; this
 * stops checkout if they are still in the bag.
 */
function sillage_wh_check_delivery(): void {
	if ( ! function_exists( 'WC' ) || ! WC()->cart || ! WC()->customer ) {
		return;
	}
	$country = strtoupper( (string) WC()->customer->get_shipping_country() );
	if ( '' === $country ) {
		$country = strtoupper( (string) WC()->customer->get_billing_country() );
	}
	if ( '' === $country ) {
		return;
	}

	$served = sillage_wh_country_vendors( $country );
	foreach ( WC()->cart->get_cart() as $item ) {
		$vendor = sillage_wh_product_vendor( (int) ( $item['product_id'] ?? 0 ) );
		if ( '' !== $vendor && ! in_array( $vendor, $served, true ) ) {
			wc_add_notice(
				__( 'Some items in your bag cannot be delivered to this country. Remove them to continue.', 'sillage-warehouses' ),
				'error'
			);
			return;
		}
	}
}
add_action( 'woocommerce_check_cart_items', 'sillage_wh_check_delivery' );
add_action( 'woocommerce_checkout_process', 'sillage_wh_check_delivery' );

/* Refresh the cached country sets when products are saved or imported. */
add_action( 'woocommerce_update_product', 'sillage_wh_flush_cache' );
add_action( 'woocommerce_new_product', 'sillage_wh_flush_cache' );
add_action( 'woocommerce_update_product_variation', 'sillage_wh_flush_cache' );
add_action( 'woocommerce_product_set_stock', 'sillage_wh_flush_cache' );
add_action( 'woocommerce_variation_set_stock', 'sillage_wh_flush_cache' );
add_action( 'save_post_product', 'sillage_wh_flush_cache' );
add_action( 'deleted_post', 'sillage_wh_flush_cache' );
// sillage-core writes products with raw SQL and then calls finalize, which fires this action.
add_action( 'sillage_finalize', 'sillage_wh_on_sync_finished' );

/* ------------------------------------------------------------------
 * Settings page (WooCommerce > Warehouses)
 * Read-only country sets derived from product metadata, plus a cache flush. Country sets are not
 * hand-edited here; they follow `_sillage_ship_countries` on each product.
 * ----------------------------------------------------------------*/
add_action(
	'admin_menu',
	static function () {
		add_submenu_page(
			'woocommerce',
			__( 'Warehouses', 'sillage-warehouses' ),
			__( 'Warehouses', 'sillage-warehouses' ),
			'manage_woocommerce',
			'sillage-warehouses',
			'sillage_wh_render_settings'
		);
	}
);

add_action(
	'admin_post_sillage_wh_flush',
	static function () {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'Not allowed.', 'sillage-warehouses' ), 403 );
		}
		check_admin_referer( 'sillage_wh_flush' );
		sillage_wh_flush_cache();
		wp_safe_redirect( add_query_arg( 'flushed', '1', admin_url( 'admin.php?page=sillage-warehouses' ) ) );
		exit;
	}
);

function sillage_wh_render_settings(): void {
	if ( ! current_user_can( 'manage_woocommerce' ) ) {
		return;
	}
	$sets  = sillage_wh_vendor_countries();
	$names = function_exists( 'WC' ) && WC()->countries ? WC()->countries->get_countries() : array();
	?>
	<div class="wrap">
		<h1><?php esc_html_e( 'Warehouses', 'sillage-warehouses' ); ?></h1>
		<?php if ( isset( $_GET['flushed'] ) ) : // phpcs:ignore WordPress.Security.NonceVerification.Recommended ?>
			<div class="notice notice-success is-dismissible"><p><?php esc_html_e( 'Country cache cleared.', 'sillage-warehouses' ); ?></p></div>
		<?php endif; ?>

		<p><?php esc_html_e( 'Country sets are read from each product (_sillage_ship_countries). Warehouses appear to customers as Location A and Location B only.', 'sillage-warehouses' ); ?></p>

		<table class="widefat striped" style="max-width:900px">
			<thead>
				<tr>
					<th><?php esc_html_e( 'Location', 'sillage-warehouses' ); ?></th>
					<th><?php esc_html_e( 'Countries served', 'sillage-warehouses' ); ?></th>
				</tr>
			</thead>
			<tbody>
				<?php foreach ( SILLAGE_WH_LOCATIONS as $vendor => $letter ) : ?>
					<tr>
						<td><strong><?php echo esc_html( 'Location ' . $letter ); ?></strong> <span class="description"><?php echo esc_html( sprintf( '(%d)', count( $sets[ $vendor ] ?? array() ) ) ); ?></span></td>
						<td>
							<?php
							$codes = $sets[ $vendor ] ?? array();
							echo esc_html( implode( ', ', array_map( static fn( $code ) => $names[ $code ] ?? $code, $codes ) ) );
							?>
						</td>
					</tr>
				<?php endforeach; ?>
			</tbody>
		</table>

		<p>
			<a class="button" href="<?php echo esc_url( wp_nonce_url( admin_url( 'admin-post.php?action=sillage_wh_flush' ), 'sillage_wh_flush' ) ); ?>">
				<?php esc_html_e( 'Clear country cache', 'sillage-warehouses' ); ?>
			</a>
		</p>
	</div>
	<?php
}
