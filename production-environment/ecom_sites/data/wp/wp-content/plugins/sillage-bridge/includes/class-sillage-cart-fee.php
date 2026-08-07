<?php
/**
 * Foodpanda-style small-order cart fee.
 *
 * Reads enable flag, global minimum, fee amount and message template from sillage.sil_settings,
 * and optional per-vendor floors from sil_vendors.order_config.min_order_value_eur. Adds at most
 * one fee per cart. Never blocks checkout. If sillage is unreachable or config is unusable, this
 * module is a no-op so a broken config cannot block a sale.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Sillage_Cart_Fee {

	private const CACHE_GROUP = 'sillage';
	private const CACHE_KEY   = 'cart_min_config';
	private const CACHE_TTL   = 60;

	/** @var array{enabled:bool,min:float,fee:float,message:string,vendor_mins:array<string,float>,vendor_labels:array<string,string>}|null|false */
	private $config = false;

	public function register(): void {
		add_action( 'woocommerce_cart_calculate_fees', array( $this, 'apply_fee' ), 20 );
		add_action( 'woocommerce_before_cart', array( $this, 'maybe_notice' ) );
		add_action( 'woocommerce_before_checkout_form', array( $this, 'maybe_notice' ), 5 );
		add_action( 'woocommerce_check_cart_items', array( $this, 'maybe_notice' ) );
	}

	/**
	 * @param WC_Cart $cart Cart being totals-calculated.
	 */
	public function apply_fee( $cart ): void {
		if ( is_admin() && ! defined( 'DOING_AJAX' ) ) {
			return;
		}
		if ( ! $cart instanceof WC_Cart ) {
			return;
		}

		$assessment = $this->assess( $cart );
		if ( null === $assessment || ! $assessment['applies'] ) {
			return;
		}

		$cart->add_fee(
			__( 'Small order fee', 'sillage-bridge' ),
			$assessment['fee'],
			false
		);
	}

	public function maybe_notice(): void {
		if ( ! function_exists( 'WC' ) || ! WC()->cart ) {
			return;
		}

		static $shown = false;
		if ( $shown ) {
			return;
		}

		$assessment = $this->assess( WC()->cart );
		if ( null === $assessment || ! $assessment['applies'] ) {
			return;
		}

		$shown = true;

		$remaining = $assessment['remaining'];
		if ( $remaining > 0 && '' !== $assessment['message'] ) {
			$formatted = wp_strip_all_tags( wc_price( $remaining ) );
			$text      = str_replace( '{remaining}', $formatted, $assessment['message'] );
			wc_add_notice( $text, 'notice' );
		}

		// Surface per-vendor shortfalls when a cart mixes suppliers (or when only a vendor
		// floor is unmet). A single-vendor cart whose shortfall matches the template amount
		// already has a clear "add X more" line above.
		$multi_vendor = count( $assessment['vendors_in_cart'] ) > 1;
		foreach ( $assessment['vendor_shortfalls'] as $slug => $shortfall ) {
			if ( $shortfall <= 0 ) {
				continue;
			}
			if ( ! $multi_vendor && abs( $shortfall - $remaining ) < 0.0001 ) {
				continue;
			}
			wc_add_notice(
				sprintf(
					/* translators: 1: formatted money amount, 2: shop section label such as LPS01 */
					__( 'Add %1$s more from %2$s to drop the small-order fee.', 'sillage-bridge' ),
					wp_strip_all_tags( wc_price( $shortfall ) ),
					esc_html( $assessment['vendor_labels'][ $slug ] ?? $slug )
				),
				'notice'
			);
		}
	}

	/**
	 * @return array{
	 *   applies: bool,
	 *   fee: float,
	 *   remaining: float,
	 *   global_shortfall: float,
	 *   vendor_shortfalls: array<string, float>,
	 *   vendors_in_cart: list<string>,
	 *   vendor_labels: array<string, string>,
	 *   message: string
	 * }|null Null when fee must not run (disabled, unreadable config, empty cart).
	 */
	private function assess( WC_Cart $cart ): ?array {
		$config = $this->load_config();
		if ( null === $config || ! $config['enabled'] ) {
			return null;
		}
		if ( $config['fee'] <= 0 ) {
			return null;
		}

		$subtotals = $this->vendor_subtotals( $cart );
		if ( empty( $subtotals['by_vendor'] ) && $subtotals['total'] <= 0 ) {
			return null;
		}

		$global_shortfall = 0.0;
		if ( $config['min'] > 0 && $subtotals['total'] < $config['min'] ) {
			$global_shortfall = $config['min'] - $subtotals['total'];
		}

		$vendor_shortfalls = array();
		foreach ( $subtotals['by_vendor'] as $slug => $amount ) {
			$min = $config['vendor_mins'][ $slug ] ?? 0.0;
			if ( $min > 0 && $amount < $min ) {
				$vendor_shortfalls[ $slug ] = $min - $amount;
			}
		}

		$remaining = $global_shortfall;
		foreach ( $vendor_shortfalls as $shortfall ) {
			if ( $shortfall > $remaining ) {
				$remaining = $shortfall;
			}
		}

		$applies = $global_shortfall > 0 || ! empty( $vendor_shortfalls );

		return array(
			'applies'           => $applies,
			'fee'               => $config['fee'],
			'remaining'         => $remaining,
			'global_shortfall'  => $global_shortfall,
			'vendor_shortfalls' => $vendor_shortfalls,
			'vendors_in_cart'   => array_keys( $subtotals['by_vendor'] ),
			'vendor_labels'     => $config['vendor_labels'],
			'message'           => $config['message'],
		);
	}

	/**
	 * @return array{total: float, by_vendor: array<string, float>}
	 */
	private function vendor_subtotals( WC_Cart $cart ): array {
		$by_vendor = array();
		$total     = 0.0;

		foreach ( $cart->get_cart() as $item ) {
			$line = isset( $item['line_subtotal'] ) ? (float) $item['line_subtotal'] : 0.0;
			$total += $line;

			$pid = isset( $item['product_id'] ) ? (int) $item['product_id'] : 0;
			if ( $pid <= 0 ) {
				continue;
			}
			$meta = get_post_meta( $pid, '_sillage_vendor', true );
			if ( ! is_string( $meta ) || '' === $meta ) {
				continue;
			}
			$slug = strtolower( $meta );
			$by_vendor[ $slug ] = ( $by_vendor[ $slug ] ?? 0.0 ) + $line;
		}

		return array(
			'total'     => $total,
			'by_vendor' => $by_vendor,
		);
	}

	/**
	 * @return array{enabled:bool,min:float,fee:float,message:string,vendor_mins:array<string,float>,vendor_labels:array<string,string>}|null
	 */
	private function load_config(): ?array {
		if ( false !== $this->config ) {
			return $this->config;
		}

		$cached = wp_cache_get( self::CACHE_KEY, self::CACHE_GROUP );
		if ( is_array( $cached ) && isset( $cached['enabled'], $cached['min'], $cached['fee'], $cached['message'], $cached['vendor_mins'], $cached['vendor_labels'] ) ) {
			$this->config = $cached;
			return $this->config;
		}

		$loaded = $this->fetch_config();
		$this->config = $loaded;
		if ( null !== $loaded ) {
			wp_cache_set( self::CACHE_KEY, $loaded, self::CACHE_GROUP, self::CACHE_TTL );
		}
		return $loaded;
	}

	/**
	 * @return array{enabled:bool,min:float,fee:float,message:string,vendor_mins:array<string,float>,vendor_labels:array<string,string>}|null
	 */
	private function fetch_config(): ?array {
		global $wpdb;

		$suppress = $wpdb->suppress_errors( true );
		try {
			$settings_table = SILLAGE_DB . '.sil_settings';
			// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name is a constant.
			$rows = $wpdb->get_results(
				$wpdb->prepare(
					"SELECT setting_key, setting_value FROM {$settings_table}
					 WHERE setting_key IN (%s, %s, %s, %s)",
					'cart_min_enabled',
					'cart_min_subtotal_eur',
					'cart_min_fee_eur',
					'cart_min_message'
				),
				ARRAY_A
			);
			// phpcs:enable

			if ( null === $rows || '' !== (string) $wpdb->last_error ) {
				return null;
			}

			$map = array();
			foreach ( (array) $rows as $row ) {
				if ( ! is_array( $row ) || ! isset( $row['setting_key'], $row['setting_value'] ) ) {
					continue;
				}
				$map[ (string) $row['setting_key'] ] = (string) $row['setting_value'];
			}

			if ( ! isset( $map['cart_min_enabled'], $map['cart_min_subtotal_eur'], $map['cart_min_fee_eur'], $map['cart_min_message'] ) ) {
				return null;
			}

			$enabled = ( '1' === $map['cart_min_enabled'] || 'true' === strtolower( $map['cart_min_enabled'] ) );
			$min     = $this->parse_non_negative( $map['cart_min_subtotal_eur'] );
			$fee     = $this->parse_non_negative( $map['cart_min_fee_eur'] );
			if ( null === $min || null === $fee ) {
				return null;
			}

			// An operator editing the wording must not be able to switch the feature off by
			// dropping the placeholder, so fall back rather than disabling.
			$message = trim( $map['cart_min_message'] );
			if ( '' === $message || ! str_contains( $message, '{remaining}' ) ) {
				$message = __( 'Add {remaining} more to your basket and the small-order fee disappears.', 'sillage-bridge' );
			}

			$vendors_table = SILLAGE_DB . '.sil_vendors';
			// phpcs:disable WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name is a constant.
			$vendor_rows = $wpdb->get_results(
				"SELECT slug, storefront_label, order_config FROM {$vendors_table} WHERE active = 1",
				ARRAY_A
			);
			// phpcs:enable

			// Per-vendor floors are an enhancement of the global rule. If they cannot be read,
			// keep applying the global minimum instead of dropping the feature entirely.
			$vendor_mins   = array();
			$vendor_labels = array();
			foreach ( (array) ( $vendor_rows ?? array() ) as $vrow ) {
				if ( ! is_array( $vrow ) || ! isset( $vrow['slug'] ) ) {
					continue;
				}
				$slug = strtolower( (string) $vrow['slug'] );

				// Customers see the shop section label (LPS01 / LPS02), never a supplier name.
				$label = isset( $vrow['storefront_label'] ) ? trim( (string) $vrow['storefront_label'] ) : '';
				if ( '' !== $label ) {
					$vendor_labels[ $slug ] = $label;
				}

				$raw = $vrow['order_config'] ?? null;
				if ( ! is_string( $raw ) || '' === $raw ) {
					continue;
				}
				$decoded = json_decode( $raw, true );
				if ( ! is_array( $decoded ) || ! array_key_exists( 'min_order_value_eur', $decoded ) ) {
					continue;
				}
				$vmin = $this->parse_non_negative( $decoded['min_order_value_eur'] );
				if ( null !== $vmin && $vmin > 0 ) {
					$vendor_mins[ $slug ] = $vmin;
				}
			}

			return array(
				'enabled'       => $enabled,
				'min'           => $min,
				'fee'           => $fee,
				'message'       => $message,
				'vendor_mins'   => $vendor_mins,
				'vendor_labels' => $vendor_labels,
			);
		} catch ( Throwable $e ) {
			unset( $e );
			return null;
		} finally {
			$wpdb->suppress_errors( $suppress );
		}
	}

	private function parse_non_negative( mixed $value ): ?float {
		if ( is_int( $value ) || is_float( $value ) ) {
			$n = (float) $value;
			return ( is_finite( $n ) && $n >= 0 ) ? $n : null;
		}
		if ( ! is_string( $value ) || '' === trim( $value ) ) {
			return null;
		}
		if ( ! is_numeric( $value ) ) {
			return null;
		}
		$n = (float) $value;
		return ( is_finite( $n ) && $n >= 0 ) ? $n : null;
	}
}
