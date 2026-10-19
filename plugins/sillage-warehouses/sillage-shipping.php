<?php
/**
 * Shipping prices for the two locations.
 *
 * Vendor costs come from sil_shipping_quotes (refreshed by sillage-core, never fetched at checkout).
 * The same row carries the carrier's delivery_days, which is handed to the storefront as rate meta
 * `delivery_days` (empty for the carrier that quotes none) so checkout can state the estimate.
 * The operator's rules come from sil_settings (shipping_*), set on the Sillage dashboard Shipping page:
 *
 *   shipping_markup_percent      percent added to the vendor cost (0 = none)
 *   shipping_markup_fixed_eur    euro added per shipment (0 = none)
 *   shipping_free_over_eur       whole-bag subtotal at or above which shipping is free (0 = off)
 *   shipping_display_mode        total = one shipping charge for the bag
 *                                per_location = one charge per location (one parcel each)
 *
 * Every rule applies to all countries. Coupons that allow free shipping also make shipping free.
 *
 * Fail-closed: if a location has no usable quote for the destination, that location has no shipping
 * rate, so checkout says shipping is not available. A price is never guessed.
 *
 * Required by sillage-warehouses.php. Keep this file in the plugin folder; the deploy copies every
 * top-level .php file there.
 */

defined( 'ABSPATH' ) || exit;

const SILLAGE_SHIP_CACHE_GROUP = 'sillage_shipping';
const SILLAGE_SHIP_CACHE_TTL   = 60;
const SILLAGE_SHIP_ZONE_NAME   = 'Sillage shipping';
const SILLAGE_SHIP_ZONE_OPTION = 'sillage_ship_zone_hash';

/** Database holding sil_settings and sil_shipping_quotes. SILLAGE_DB is defined by sillage-bridge. */
function sillage_ship_db(): string {
	return defined( 'SILLAGE_DB' ) ? (string) SILLAGE_DB : 'sillage';
}

/** Operator rules, cached briefly. Defaults change nothing: markup 0, no threshold, total mode. */
function sillage_ship_rules(): array {
	$cached = wp_cache_get( 'rules', SILLAGE_SHIP_CACHE_GROUP );
	if ( is_array( $cached ) ) {
		return $cached;
	}

	$rules = array(
		'percent'  => 0.0,
		'fixed'    => 0.0,
		'free_over' => 0.0,
		'mode'     => 'total',
		'ok'       => false,
	);

	global $wpdb;
	$table = sillage_ship_db() . '.sil_settings';
	// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name is a constant.
	$rows = $wpdb->get_results(
		"SELECT setting_key, setting_value FROM {$table} WHERE setting_key LIKE 'shipping\_%'",
		ARRAY_A
	);
	// phpcs:enable
	if ( null !== $rows && '' === (string) $wpdb->last_error ) {
		$rules['ok'] = true;
		$values = array();
		foreach ( (array) $rows as $row ) {
			$values[ (string) $row['setting_key'] ] = (string) $row['setting_value'];
		}
		$rules['percent']   = max( 0.0, (float) ( $values['shipping_markup_percent'] ?? 0 ) );
		$rules['fixed']     = max( 0.0, (float) ( $values['shipping_markup_fixed_eur'] ?? 0 ) );
		$rules['free_over'] = max( 0.0, (float) ( $values['shipping_free_over_eur'] ?? 0 ) );
		if ( 'per_location' === ( $values['shipping_display_mode'] ?? '' ) ) {
			$rules['mode'] = 'per_location';
		}
	}

	if ( $rules['ok'] ) {
		wp_cache_set( 'rules', $rules, SILLAGE_SHIP_CACHE_GROUP, SILLAGE_SHIP_CACHE_TTL );
	}
	return $rules;
}

/**
 * Cached vendor quotes: [ vendor_slug => [ country => [ 'cost' => cost_eur, 'days' => delivery_days ] ] ],
 * status 'ok' only. `days` is the carrier's own estimate, null when it quotes none (the standard
 * service). If the table cannot be read, this returns nothing, so every location is unavailable.
 */
function sillage_ship_quote_map(): array {
	$cached = wp_cache_get( 'quotes', SILLAGE_SHIP_CACHE_GROUP );
	if ( is_array( $cached ) ) {
		return $cached;
	}

	global $wpdb;
	$table = sillage_ship_db() . '.sil_shipping_quotes';
	// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name is a constant.
	$rows = $wpdb->get_results(
		"SELECT vendor_slug, country, cost_eur, delivery_days FROM {$table} WHERE status = 'ok'",
		ARRAY_A
	);
	// phpcs:enable

	$map = array();
	if ( null === $rows || '' !== (string) $wpdb->last_error ) {
		return array(); // Unreadable cache: no quotes, so no rates (fail closed). Not cached.
	}
	foreach ( (array) $rows as $row ) {
		$days = isset( $row['delivery_days'] ) && null !== $row['delivery_days'] ? (int) $row['delivery_days'] : 0;
		$map[ (string) $row['vendor_slug'] ][ strtoupper( (string) $row['country'] ) ] = array(
			'cost' => (float) $row['cost_eur'],
			'days' => $days > 0 ? $days : null,
		);
	}

	wp_cache_set( 'quotes', $map, SILLAGE_SHIP_CACHE_GROUP, SILLAGE_SHIP_CACHE_TTL );
	return $map;
}

/** Locations (A/B) a package ships from. Empty when the package is not a warehouse package. */
function sillage_ship_package_letters( array $package ): array {
	if ( ! empty( $package['sillage_locations'] ) && is_array( $package['sillage_locations'] ) ) {
		return array_values( array_unique( $package['sillage_locations'] ) );
	}
	if ( ! empty( $package['sillage_location'] ) ) {
		return array( (string) $package['sillage_location'] );
	}
	return array();
}

/** Whether shipping is free for this cart: whole-bag threshold or a coupon that allows free shipping. */
function sillage_ship_cart_is_free( array $rules ): bool {
	if ( ! function_exists( 'WC' ) || ! WC()->cart ) {
		return false;
	}
	if ( $rules['free_over'] > 0 && (float) WC()->cart->get_subtotal() >= $rules['free_over'] ) {
		return true;
	}
	foreach ( (array) WC()->cart->get_applied_coupons() as $code ) {
		$coupon = new WC_Coupon( $code );
		if ( $coupon->get_free_shipping() ) {
			return true;
		}
	}
	return false;
}

/**
 * In total mode, one parcel per bag: merge the per-location packages sillage-warehouses created, so
 * the customer sees one shipping charge. Runs after the split (priority 20).
 */
add_filter(
	'woocommerce_cart_shipping_packages',
	static function ( $packages ) {
		$rules = sillage_ship_rules();
		if ( 'total' !== $rules['mode'] || count( (array) $packages ) < 2 ) {
			return $packages;
		}

		$merged    = null;
		$contents  = array();
		$letters   = array();
		foreach ( (array) $packages as $package ) {
			if ( null === $merged ) {
				$merged = $package;
			}
			foreach ( (array) ( $package['contents'] ?? array() ) as $key => $item ) {
				$contents[ $key ] = $item;
			}
			foreach ( sillage_ship_package_letters( $package ) as $letter ) {
				$letters[ $letter ] = true;
			}
		}

		$merged['contents']      = $contents;
		$merged['contents_cost'] = array_sum( array_map( static function ( $item ) {
			return (float) ( $item['line_total'] ?? 0 );
		}, $contents ) );
		unset( $merged['sillage_location'] );
		$merged['sillage_locations'] = array_keys( $letters );
		return array( $merged );
	},
	30
);

/**
 * Price each warehouse package from the vendor cache and the operator rules. The zone's flat-rate
 * placeholder is kept only as the carrier of the rate; its cost is replaced here.
 */
add_filter(
	'woocommerce_package_rates',
	static function ( $rates, $package ) {
		$letters = sillage_ship_package_letters( (array) $package );
		if ( empty( $letters ) ) {
			return array(); // Fail closed: a package we cannot identify gets no rate.
		}
		$rules = sillage_ship_rules();
		if ( empty( $rules['ok'] ) ) {
			return array(); // Settings unreadable: never price with defaults (fail closed).
		}

		$country  = strtoupper( (string) ( $package['destination']['country'] ?? '' ) );
		$quotes   = sillage_ship_quote_map();
		$base     = 0.0;
		$days     = 0;     // The slowest day count any location quotes.
		$standard = false; // A location whose carrier quotes no day count (the standard service).
		foreach ( $letters as $letter ) {
			$slug  = array_search( $letter, SILLAGE_WH_LOCATIONS, true );
			$quote = false !== $slug && isset( $quotes[ $slug ][ $country ] ) ? $quotes[ $slug ][ $country ] : null;
			if ( null === $quote ) {
				return array(); // No usable quote from one location: that location cannot deliver here.
			}
			$base += (float) $quote['cost'];
			if ( null === $quote['days'] ) {
				$standard = true;
			} else {
				$days = max( $days, (int) $quote['days'] );
			}
		}

		// A parcel is only as fast as its slowest location, and a location with no quoted day count
		// is the standard service, which the storefront describes with its own range.
		$delivery_days = $standard || $days <= 0 ? '' : (string) $days;

		$final = sillage_ship_cart_is_free( $rules )
			? 0.0
			: round( $base * ( 1 + $rules['percent'] / 100 ) + $rules['fixed'], 2 );

		foreach ( (array) $rates as $id => $rate ) {
			if ( ! $rate instanceof WC_Shipping_Rate ) {
				continue;
			}
			$rate->set_cost( $final );
			$rate->set_taxes( WC_Tax::calc_shipping_tax( $final, WC_Tax::get_shipping_tax_rates() ) );
			// The carrier's own day count, for the storefront to say how long the parcel takes.
			// No `_` prefix: the Store API hands this one to the shop, and the shop reads it as a
			// number, never as a price. Empty means the standard service.
			$rate->add_meta_data( 'delivery_days', $delivery_days );
			return array( $id => $rate ); // One rate per parcel.
		}
		return array();
	},
	20,
	2
);

/**
 * Keep a WooCommerce shipping zone that covers every country any location serves, with one flat-rate
 * method. Without a zone WooCommerce offers no shipping at all. Runs when the country sets change.
 */
function sillage_ship_sync_zone(): void {
	if ( ! class_exists( 'WC_Shipping_Zone' ) || ! class_exists( 'WC_Shipping_Zones' ) ) {
		return;
	}

	$union = array();
	foreach ( sillage_wh_vendor_countries() as $codes ) {
		foreach ( (array) $codes as $code ) {
			$union[ strtoupper( (string) $code ) ] = true;
		}
	}
	$countries = array_keys( $union );
	sort( $countries );
	$hash = md5( implode( ',', $countries ) );

	// Common path: nothing changed since the last sync. One option read, no WooCommerce queries.
	if ( get_option( SILLAGE_SHIP_ZONE_OPTION ) === $hash ) {
		return;
	}

	$zone_id = null;
	foreach ( WC_Shipping_Zones::get_zones() as $zone ) {
		if ( ( $zone['zone_name'] ?? '' ) === SILLAGE_SHIP_ZONE_NAME ) {
			$zone_id = (int) $zone['id'];
			break;
		}
	}

	$zone = null !== $zone_id ? new WC_Shipping_Zone( $zone_id ) : new WC_Shipping_Zone();
	if ( null === $zone_id ) {
		$zone->set_zone_name( SILLAGE_SHIP_ZONE_NAME );
	}
	$zone->set_locations(
		array_map(
			static function ( $code ) {
				return array( 'type' => 'country', 'code' => $code );
			},
			$countries
		)
	);
	$zone->save();

	if ( null === $zone_id ) {
		$instance_id = $zone->add_shipping_method( 'flat_rate' );
		update_option(
			'woocommerce_flat_rate_' . $instance_id . '_settings',
			array( 'title' => 'Shipping', 'tax_status' => 'taxable', 'cost' => '0' )
		);
	}

	// WooCommerce caches the enabled-method count. A count taken before this zone existed reads 0 and
	// makes every cart "not need shipping". Drop that cache whenever the zone changes.
	if ( class_exists( 'WC_Cache_Helper' ) ) {
		WC_Cache_Helper::invalidate_cache_group( 'shipping' );
	}
	delete_transient( 'wc_shipping_method_count' );
	update_option( SILLAGE_SHIP_ZONE_OPTION, $hash, false );
}

add_action( 'woocommerce_init', 'sillage_ship_sync_zone' );
