<?php
/**
 * REST endpoints sillage-core calls into.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The `sillage/v1` namespace.
 *
 * Authentication is an HMAC of the raw request body using a secret shared with sillage-core, not a
 * WordPress user. These calls come from another container on the Docker network, and giving the
 * sync engine a WordPress account with edit_products would be a much larger grant than it needs.
 */
final class Sillage_Rest {

	public function register(): void {
		add_action( 'rest_api_init', array( $this, 'register_routes' ) );
	}

	public function register_routes(): void {
		$args = array(
			'permission_callback' => array( $this, 'authorize' ),
		);

		register_rest_route(
			'sillage/v1',
			'/finalize',
			array_merge(
				$args,
				array(
					'methods'  => 'POST',
					'callback' => array( $this, 'finalize' ),
				)
			)
		);

		register_rest_route(
			'sillage/v1',
			'/status',
			array_merge(
				$args,
				array(
					'methods'  => 'GET',
					'callback' => array( $this, 'status' ),
				)
			)
		);

		register_rest_route(
			'sillage/v1',
			'/order-update',
			array_merge(
				$args,
				array(
					'methods'  => 'POST',
					'callback' => array( new Sillage_Orders(), 'handle_order_update' ),
				)
			)
		);
	}

	/**
	 * Verify the HMAC signature over the raw body.
	 *
	 * A GET has no body, so the signature covers the empty string; that is still enough to prove
	 * possession of the secret, and the endpoint only reads.
	 *
	 * @param WP_REST_Request $request Incoming request.
	 */
	public function authorize( $request ): bool {
		if ( ! $request instanceof WP_REST_Request ) {
			return false;
		}
		return Sillage_Settings::verify_signature(
			(string) $request->get_body(),
			$request->get_header( 'x-sillage-signature' )
		);
	}

	/**
	 * Invalidate every cache that a bulk SQL import leaves stale.
	 *
	 * sillage-core writes products with raw SQL, so none of WooCommerce's invalidation hooks fire.
	 * Without this call the storefront keeps serving pre-import product queries, category counts
	 * and price ranges until the transients happen to expire.
	 */
	public function finalize(): WP_REST_Response {
		$started = microtime( true );
		$done    = array();

		// Bumping the transient version is how WooCommerce invalidates its own product query
		// caches wholesale.
		if ( class_exists( 'WC_Cache_Helper' ) ) {
			WC_Cache_Helper::get_transient_version( 'product', true );
			WC_Cache_Helper::get_transient_version( 'product_query', true );
			$done[] = 'wc_transient_version';

			if ( method_exists( 'WC_Cache_Helper', 'invalidate_cache_group' ) ) {
				WC_Cache_Helper::invalidate_cache_group( 'products' );
				$done[] = 'wc_product_group';
			}
		}

		// Attribute layered-nav counts are cached separately from product queries.
		delete_transient( 'wc_layered_nav_counts' );
		wp_cache_flush_group( 'wc_layered_nav_counts' );
		$done[] = 'layered_nav';

		// Price range for the price filter widget.
		delete_transient( 'wc_products_onsale' );
		delete_transient( 'wc_featured_products' );
		$done[] = 'wc_product_lists';

		// Term counts were recomputed in SQL, but the cached copies still hold the old numbers.
		foreach ( array( 'product_cat', 'product_brand', 'pa_gender', 'pa_item-type', 'pa_volume' ) as $taxonomy ) {
			if ( taxonomy_exists( $taxonomy ) ) {
				clean_taxonomy_cache( $taxonomy );
			}
		}
		$done[] = 'taxonomy_cache';

		// Some themes keep their own derived tables for product filtering, populated by hooks on
		// product save that a raw SQL import never fires.
		if ( $this->regenerate_theme_lookups() ) {
			$done[] = 'theme_lookup';
		}

		/**
		 * Fires after Sillage has invalidated WooCommerce's caches following a bulk import.
		 *
		 * The hook exists so a theme or plugin with its own derived data can rebuild it without
		 * this plugin needing to know about it.
		 *
		 * @param string[] $done Identifiers of the caches already invalidated.
		 */
		do_action( 'sillage_finalize', $done );

		// Object cache last, so nothing above repopulates a stale entry.
		wp_cache_flush();
		$done[] = 'object_cache';

		return new WP_REST_Response(
			array(
				'ok'         => true,
				'invalidated' => $done,
				'duration_ms' => (int) round( ( microtime( true ) - $started ) * 1000 ),
			),
			200
		);
	}

	/**
	 * Rebuild theme-owned product lookup tables.
	 *
	 * Blocksy keeps a taxonomy lookup table. Astra / Elementor may expose similar refresh entry
	 * points — each check is guarded so this is a no-op when those themes/plugins are absent.
	 *
	 * Prefer a direct SQL rebuild: Blocksy's `regenerate_inline` loads every product through
	 * `wc_get_products( limit=-1 )`, which OOMs / times out on a ~60k catalogue. The wrong
	 * action name (`blocksy:products:taxonomies-lookup:regenerate`) was also a no-op — the
	 * real hook is `blocksy:pro:woo-extra:filters:lookup-table:regenerate`.
	 */
	private function regenerate_theme_lookups(): bool {
		$did = false;

		if ( $this->rebuild_blocksy_taxonomy_lookup() ) {
			$did = true;
		} elseif (
			function_exists( 'blocksy_get_product_taxonomies_lookup_table' )
			|| class_exists( '\Blocksy\Extensions\WoocommerceExtra\FiltersTaxonomiesProductsLookupTable' )
			|| class_exists( '\Blocksy\ProductTaxonomiesLookup' )
		) {
			// Fallback for smaller installs / future Blocksy versions.
			do_action( 'blocksy:pro:woo-extra:filters:lookup-table:regenerate' );
			$did = true;
		}

		// Astra WooCommerce addon / Elementor Pro occasionally cache product card markup.
		if ( function_exists( 'astra_clear_all_assets_cache' ) ) {
			astra_clear_all_assets_cache();
			$did = true;
		}
		if ( class_exists( '\Elementor\Plugin' ) && isset( \Elementor\Plugin::$instance->files_manager ) ) {
			$fm = \Elementor\Plugin::$instance->files_manager;
			if ( is_object( $fm ) && method_exists( $fm, 'clear_cache' ) ) {
				$fm->clear_cache();
				$did = true;
			}
		}
		if ( function_exists( 'elementor_theme_do_location' ) && class_exists( '\Elementor\Plugin' ) ) {
			do_action( 'elementor/core/files/clear_cache' );
			$did = true;
		}

		delete_transient( 'sillage_b2b_cats_v1' );
		delete_transient( 'sillage_b2b_cats_v2' );

		return $did;
	}

	/**
	 * Populate `wp_blocksy_product_taxonomies_lookup` from live term relationships.
	 *
	 * Without this, Blocksy's Ajax category filter only sees the handful of starter-site
	 * demo products that were indexed before the bulk SQL import.
	 */
	private function rebuild_blocksy_taxonomy_lookup(): bool {
		global $wpdb;
		$table = $wpdb->prefix . 'blocksy_product_taxonomies_lookup';

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		$exists = $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) );
		if ( $table !== $exists ) {
			return false;
		}

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		$wpdb->query( "TRUNCATE TABLE {$table}" ); // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared

		// Mirror Blocksy's store: product_cat + brand taxonomy (WC registers singular product_brand;
		// older Blocksy rows used product_brands — index both spellings when present).
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		$inserted = $wpdb->query(
			"INSERT INTO {$table} (product_id, taxonomy, term_id)
			SELECT DISTINCT p.ID, tt.taxonomy, tt.term_id
			FROM {$wpdb->posts} p
			INNER JOIN {$wpdb->term_relationships} tr ON tr.object_id = p.ID
			INNER JOIN {$wpdb->term_taxonomy} tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
			WHERE p.post_type = 'product'
			  AND p.post_status = 'publish'
			  AND tt.taxonomy IN ('product_cat', 'product_brand', 'product_brands')"
		);

		if ( false === $inserted ) {
			return false;
		}

		update_option(
			'blocksy_taxonomy_lookup_regeneration_state',
			array(
				'state'   => 'idle',
				'enabled' => true,
			),
			false
		);

		return true;
	}

	/** Health and configuration snapshot, used by the dashboard's Overview page. */
	public function status(): WP_REST_Response {
		global $wpdb;

		$product_count = (int) $wpdb->get_var(
			"SELECT COUNT(*) FROM {$wpdb->posts} WHERE post_type = 'product' AND post_status = 'publish'"
		);

		$attribute_taxonomies = array();
		if ( function_exists( 'wc_get_attribute_taxonomies' ) ) {
			foreach ( wc_get_attribute_taxonomies() as $attribute ) {
				$attribute_taxonomies[] = 'pa_' . $attribute->attribute_name;
			}
		}

		return new WP_REST_Response(
			array(
				'ok'                   => true,
				'plugin_version'       => SILLAGE_BRIDGE_VERSION,
				'wordpress_version'    => get_bloginfo( 'version' ),
				'woocommerce_version'  => defined( 'WC_VERSION' ) ? WC_VERSION : null,
				'currency'             => get_option( 'woocommerce_currency' ),
				'hpos_enabled'         => 'yes' === get_option( 'woocommerce_custom_orders_table_enabled' ),
				'published_products'   => $product_count,
				'attribute_taxonomies' => $attribute_taxonomies,
				'ean_index_readable'   => Sillage_Settings::ean_index_available(),
				'wp_cron_disabled'     => defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON,
			),
			200
		);
	}
}
