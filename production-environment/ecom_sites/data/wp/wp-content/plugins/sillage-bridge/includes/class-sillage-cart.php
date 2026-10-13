<?php
/**
 * Cart + ship-to country restriction across two warehouses.
 *
 * Products from both warehouses may share a cart. Checkout offers the countries that at least one
 * cart item can ship to (from `_sillage_ship_countries` meta written by sillage-core). Per-country
 * warehouse rules (items the destination cannot receive) are enforced by the storefront EAN plugin.
 * Customer-facing text never names a warehouse.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Sillage_Cart {

	public function register(): void {
		add_action( 'woocommerce_product_meta_end', array( $this, 'render_ean' ) );
		add_filter( 'woocommerce_countries_allowed_countries', array( $this, 'filter_countries' ) );
		add_filter( 'woocommerce_countries_shipping_countries', array( $this, 'filter_countries' ) );
		add_filter( 'woocommerce_countries_selling_countries', array( $this, 'filter_countries' ) );
	}

	/**
	 * Show the primary EAN next to SKU meta on the product page.
	 */
	public function render_ean(): void {
		global $product;
		if ( ! $product instanceof WC_Product ) {
			return;
		}
		$ean = get_post_meta( $product->get_id(), '_global_unique_id', true );
		if ( ! is_string( $ean ) || $ean === '' ) {
			$ean = get_post_meta( $product->get_id(), '_sillage_ean', true );
		}
		if ( ! is_string( $ean ) || $ean === '' ) {
			return;
		}
		echo '<span class="sku_wrapper sillage-ean-wrapper">'
			. esc_html__( 'EAN:', 'sillage-bridge' )
			. ' <span class="sillage-ean">' . esc_html( $ean ) . '</span></span>';
	}

	/**
	 * When the cart has a vendor, shrink the country dropdowns to that vendor's list.
	 *
	 * @param array<string, string> $countries Country code => name.
	 * @return array<string, string>
	 */
	public function filter_countries( array $countries ): array {
		$allowed = $this->cart_ship_countries();
		if ( empty( $allowed ) ) {
			return $countries;
		}
		$filtered = array();
		foreach ( $allowed as $code ) {
			$code = strtoupper( $code );
			if ( isset( $countries[ $code ] ) ) {
				$filtered[ $code ] = $countries[ $code ];
			}
		}
		return empty( $filtered ) ? $countries : $filtered;
	}

	/**
	 * Union of the countries every cart item can ship to.
	 *
	 * @return list<string>
	 */
	private function cart_ship_countries(): array {
		if ( ! function_exists( 'WC' ) || ! WC()->cart ) {
			return array();
		}
		$out = array();
		foreach ( WC()->cart->get_cart() as $item ) {
			$pid = isset( $item['product_id'] ) ? (int) $item['product_id'] : 0;
			$raw = get_post_meta( $pid, '_sillage_ship_countries', true );
			if ( ! is_string( $raw ) || $raw === '' ) {
				continue;
			}
			$decoded = json_decode( $raw, true );
			if ( ! is_array( $decoded ) ) {
				continue;
			}
			foreach ( $decoded as $code ) {
				if ( is_string( $code ) && $code !== '' ) {
					$out[ strtoupper( $code ) ] = true;
				}
			}
		}
		return array_keys( $out );
	}
}
