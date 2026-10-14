<?php
/**
 * Plugin Name: Storefront EAN API
 * Description: EAN (barcode) lookup for the headless storefront. This plugin does EAN only.
 * Version: 1.1.0
 *
 * One job: resolve an EAN to a product, and return a product's EAN. Everything else the storefront
 * calls lives elsewhere — country scope, shipping and the catalogue endpoints are in
 * `sillage-warehouses`; barcode search inside WordPress is in `sillage-bridge`; the legal-guarantee
 * order-email notice is in `storefront-legal-notice`. Do not grow this plugin past EAN.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_action(
	'rest_api_init',
	static function () {
		register_rest_route(
			'cereve/v1',
			'/ean/(?P<ean>[0-9]{8,14})',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'permission_callback' => '__return_true',
				'callback'            => 'cereve_storefront_find_ean',
				'args'                => array(
					'ean' => array(
						'required'          => true,
						'sanitize_callback' => 'sanitize_text_field',
					),
				),
			)
		);

		register_rest_route(
			'cereve/v1',
			'/products/(?P<id>[0-9]+)/ean',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'permission_callback' => '__return_true',
				'callback'            => 'cereve_storefront_product_ean',
				'args'                => array(
					'id' => array(
						'required'          => true,
						'sanitize_callback' => 'absint',
					),
				),
			)
		);
	}
);

/** WooCommerce's GTIN field (the primary EAN), or empty string. Public read of a published product. */
function cereve_storefront_product_ean( WP_REST_Request $request ) {
	$id = absint( $request->get_param( 'id' ) );
	if ( 'product' !== get_post_type( $id ) || 'publish' !== get_post_status( $id ) ) {
		return new WP_Error( 'product_not_found', __( 'Product not found.', 'storefront-ean' ), array( 'status' => 404 ) );
	}

	$response = rest_ensure_response(
		array(
			'id'  => $id,
			'ean' => cereve_storefront_ean_for_product( $id ),
		)
	);
	$response->header( 'Cache-Control', 'public, max-age=3600' );
	return $response;
}

/**
 * Resolve a barcode to a published, image-bearing product.
 *
 * Reads `sillage.sil_ean_index` — one row per EAN per product — because a BeautyFort product can
 * carry up to 26 EANs, which cannot live in a single postmeta row. Falls back to WooCommerce's
 * indexed global unique id when the Sillage index is unavailable.
 */
function cereve_storefront_find_ean( WP_REST_Request $request ) {
	$ean = (string) $request->get_param( 'ean' );
	$ids = cereve_storefront_ean_product_ids( $ean );

	foreach ( $ids as $id ) {
		$id = absint( $id );
		if ( 'product' !== get_post_type( $id ) || 'publish' !== get_post_status( $id ) ) {
			continue;
		}
		if ( '' === trim( (string) get_post_meta( $id, '_external_thumbnail_url', true ) ) ) {
			continue;
		}

		$response = rest_ensure_response(
			array(
				'id'  => $id,
				'ean' => cereve_storefront_ean_for_product( $id ) ?: $ean,
			)
		);
		$response->header( 'Cache-Control', 'public, max-age=3600' );
		return $response;
	}

	return new WP_Error( 'product_ean_not_found', __( 'No product matches that EAN.', 'storefront-ean' ), array( 'status' => 404 ) );
}

/** The primary EAN stored on a product, preferring WooCommerce's GTIN field. */
function cereve_storefront_ean_for_product( int $product_id ): string {
	foreach ( array( '_global_unique_id', '_sillage_ean' ) as $key ) {
		$value = get_post_meta( $product_id, $key, true );
		if ( is_string( $value ) && '' !== trim( $value ) ) {
			return trim( $value );
		}
	}
	return '';
}

/** Product IDs holding a barcode, from the Sillage EAN index; WooCommerce's index as fallback. */
function cereve_storefront_ean_product_ids( string $ean ): array {
	$ean = trim( $ean );
	if ( 1 !== preg_match( '/^\d{8,14}$/', $ean ) ) {
		return array();
	}

	global $wpdb;
	if ( defined( 'SILLAGE_DB' ) ) {
		$table = SILLAGE_DB . '.sil_ean_index';
		foreach ( array( $ean, str_pad( $ean, 13, '0', STR_PAD_LEFT ) ) as $candidate ) {
			// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name is a constant.
			$ids = $wpdb->get_col( $wpdb->prepare( "SELECT wp_post_id FROM {$table} WHERE ean = %s LIMIT 50", $candidate ) );
			if ( ! empty( $ids ) ) {
				return array_map( 'absint', (array) $ids );
			}
		}
	}

	// A barcode a shopper pasted may have lost a leading zero; retry zero-padded before giving up.
	if ( function_exists( 'wc_get_product_id_by_global_unique_id' ) ) {
		foreach ( array_unique( array( $ean, str_pad( $ean, 13, '0', STR_PAD_LEFT ) ) ) as $candidate ) {
			$id = (int) wc_get_product_id_by_global_unique_id( $candidate );
			if ( $id > 0 ) {
				return array( $id );
			}
		}
	}

	return array();
}
