<?php
/**
 * Storefront catalog filters: hide B2B wholesaler products from the main shop,
 * and keep external product images from blowing out of their containers.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Theme-agnostic WooCommerce query filters.
 *
 * Vendor identity lives on `_sillage_vendor` postmeta (and the `pa_vendor` attribute for
 * storefront facets) — never on `product_cat`. Marketplace connectors treat product categories
 * as browse taxonomy; LPS01/LPS02/LPS03 must not appear there.
 *
 * wholesale-perfumes (B2B) products appear only on the dedicated B2B page
 * (`_sillage_b2b_shop` postmeta). Main shop, search, category archives, and related loops
 * exclude them via meta_query.
 *
 * Legacy LPS* `product_cat` terms (from an earlier mistaken lane) are stripped from category
 * widgets / `get_terms` / nav if they still exist. Empty feed categories are hidden too.
 */
final class Sillage_Catalog {

	private const B2B_VENDOR_SLUG = 'wholesale-perfumes';
	private const B2B_PAGE_META   = '_sillage_b2b_shop';
	private const VENDOR_META     = '_sillage_vendor';

	/** @var string[] Legacy product_cat slugs that must never appear in browse UI. */
	private const LEGACY_VENDOR_CAT_SLUGS = array( 'lps01', 'lps02', 'lps03' );

	public function register(): void {
		add_action( 'pre_get_posts', array( $this, 'exclude_b2b_from_main_catalog' ), 20 );
		add_action( 'woocommerce_product_query', array( $this, 'exclude_b2b_from_wc_query' ), 20 );
		// Blocksy live search uses WP REST /wp/v2/search (not the main query). After Blocksy's
		// rest_post_search_query (priority 999) so we keep its visibility/tax patches and still
		// exclude B2B the same way the search results page does.
		add_filter( 'rest_post_search_query', array( $this, 'exclude_b2b_from_rest_search' ), 1000, 2 );
		add_filter( 'woocommerce_shortcode_products_query', array( $this, 'filter_b2b_shortcode_products' ), 20, 3 );
		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue_image_safety_css' ), 30 );
		add_filter( 'get_terms', array( $this, 'filter_product_cat_term_lists' ), 20, 3 );
		add_filter( 'woocommerce_product_categories_widget_args', array( $this, 'filter_category_widget_args' ), 20 );
		add_filter( 'woocommerce_product_categories_widget_dropdown_args', array( $this, 'filter_category_widget_args' ), 20 );
		add_filter( 'wp_get_nav_menu_items', array( $this, 'hide_legacy_vendor_cats_from_nav' ), 20, 3 );
	}

	/**
	 * Soft-cap external vendor images so a tiny BF thumb cannot stretch a card.
	 * Root fix is sync-time image resolution; this is a theme-agnostic safety net.
	 */
	public function enqueue_image_safety_css(): void {
		if ( is_admin() ) {
			return;
		}
		$css = '.woocommerce ul.products li.product img,'
			. '.woocommerce div.product div.images img,'
			. '.woocommerce-page ul.products li.product img{'
			. 'max-width:100%;height:auto;object-fit:contain;'
			. '}';
		wp_register_style( 'sillage-bridge-images', false, array(), SILLAGE_BRIDGE_VERSION );
		wp_enqueue_style( 'sillage-bridge-images' );
		wp_add_inline_style( 'sillage-bridge-images', $css );
	}

	/**
	 * @param WP_Query $query Main query.
	 */
	public function exclude_b2b_from_main_catalog( $query ): void {
		if ( is_admin() || ! $query instanceof WP_Query || ! $query->is_main_query() ) {
			return;
		}
		if ( ! $this->is_product_listing_query( $query ) ) {
			return;
		}
		$this->ensure_catalog_visibility( $query );
		if ( $this->should_allow_b2b() ) {
			return;
		}
		$this->append_b2b_exclusion( $query );
	}

	/**
	 * WooCommerce shortcodes / product loops that skip the main query.
	 *
	 * @param WP_Query $query Product query.
	 */
	public function exclude_b2b_from_wc_query( $query ): void {
		if ( is_admin() || ! $query instanceof WP_Query ) {
			return;
		}
		$this->ensure_catalog_visibility( $query );
		if ( $this->should_allow_b2b() ) {
			return;
		}
		$this->append_b2b_exclusion( $query );
	}

	/**
	 * Exclude B2B from Blocksy/WP REST live search so dropdown matches /?s= results.
	 *
	 * @param array           $args    WP_Query args for the search.
	 * @param WP_REST_Request $request REST request.
	 * @return array
	 */
	public function exclude_b2b_from_rest_search( $args, $request ) {
		if ( ! is_array( $args ) ) {
			return $args;
		}

		$post_type         = $args['post_type'] ?? '';
		$includes_product  = ( 'product' === $post_type )
			|| ( is_array( $post_type ) && in_array( 'product', $post_type, true ) );
		if ( ! $includes_product ) {
			return $args;
		}

		unset( $request );
		$args = $this->ensure_catalog_visibility_args( $args );

		if ( $this->should_allow_b2b() ) {
			return $args;
		}

		return $this->append_b2b_exclusion_args( $args );
	}

	/**
	 * On the B2B page, `[products]` shortcodes list only wholesale-perfumes.
	 *
	 * @param array  $query_args Shortcode query args.
	 * @param array  $attributes Shortcode attributes.
	 * @param string $_type      Shortcode type (unused).
	 * @return array
	 */
	public function filter_b2b_shortcode_products( $query_args, $attributes = array(), $_type = '' ) {
		unset( $attributes, $_type );
		if ( ! is_array( $query_args ) || ! $this->should_allow_b2b() ) {
			return $query_args;
		}

		$meta_query = isset( $query_args['meta_query'] ) && is_array( $query_args['meta_query'] )
			? $query_args['meta_query']
			: array();
		$meta_query[] = array(
			'key'     => self::VENDOR_META,
			'value'   => self::B2B_VENDOR_SLUG,
			'compare' => '=',
		);
		$query_args['meta_query'] = $meta_query;

		return $query_args;
	}

	/**
	 * @param WP_Query $query Query.
	 */
	private function is_product_listing_query( WP_Query $query ): bool {
		if ( $query->is_search() ) {
			return true;
		}
		if ( function_exists( 'is_shop' ) && is_shop() ) {
			return true;
		}
		if ( function_exists( 'is_product_taxonomy' ) && is_product_taxonomy() ) {
			return true;
		}
		$post_type = $query->get( 'post_type' );
		if ( 'product' === $post_type || ( is_array( $post_type ) && in_array( 'product', $post_type, true ) ) ) {
			return true;
		}
		return false;
	}

	/** True on the dedicated B2B wholesale page only. */
	private function should_allow_b2b(): bool {
		if ( function_exists( 'is_page' ) && is_page() ) {
			$page_id = (int) get_queried_object_id();
			if ( $page_id > 0 && '1' === (string) get_post_meta( $page_id, self::B2B_PAGE_META, true ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Shop-truth visibility: hide `exclude-from-catalog` (Blocksy search often skips WC_Query).
	 *
	 * @param WP_Query $query Query to mutate.
	 */
	private function ensure_catalog_visibility( WP_Query $query ): void {
		$args = array(
			'tax_query' => $query->get( 'tax_query' ),
		);
		$args = $this->ensure_catalog_visibility_args( $args );
		if ( isset( $args['tax_query'] ) ) {
			$query->set( 'tax_query', $args['tax_query'] );
		}
	}

	/**
	 * @param array $args Query args.
	 * @return array
	 */
	private function ensure_catalog_visibility_args( array $args ): array {
		$term = get_term_by( 'slug', 'exclude-from-catalog', 'product_visibility' );
		if ( ! ( $term instanceof WP_Term ) ) {
			return $args;
		}
		$tt_id = (int) $term->term_taxonomy_id;
		if ( $tt_id <= 0 ) {
			return $args;
		}

		$tax_query = isset( $args['tax_query'] ) && is_array( $args['tax_query'] )
			? $args['tax_query']
			: array();
		if ( $this->tax_query_already_excludes_tt( $tax_query, $tt_id ) ) {
			return $args;
		}

		$tax_query[] = array(
			'taxonomy' => 'product_visibility',
			'field'    => 'term_taxonomy_id',
			'terms'    => array( $tt_id ),
			'operator' => 'NOT IN',
		);
		$args['tax_query'] = $tax_query;
		return $args;
	}

	/**
	 * @param array $tax_query Tax query.
	 * @param int   $tt_id     term_taxonomy_id.
	 */
	private function tax_query_already_excludes_tt( array $tax_query, int $tt_id ): bool {
		foreach ( $tax_query as $clause ) {
			if ( ! is_array( $clause ) ) {
				continue;
			}
			if ( isset( $clause['taxonomy'] ) && 'product_visibility' === $clause['taxonomy'] ) {
				$operator = isset( $clause['operator'] ) ? strtoupper( (string) $clause['operator'] ) : 'IN';
				if ( 'NOT IN' === $operator && $this->terms_include_id( $clause['terms'] ?? null, $tt_id ) ) {
					return true;
				}
			}
			if ( $this->tax_query_already_excludes_tt( $clause, $tt_id ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * @param WP_Query $query Query to mutate.
	 */
	private function append_b2b_exclusion( WP_Query $query ): void {
		$meta_query = $query->get( 'meta_query' );
		if ( ! is_array( $meta_query ) ) {
			$meta_query = array();
		}
		$meta_query[] = $this->b2b_exclusion_meta_clause();
		$query->set( 'meta_query', $meta_query );
	}

	/**
	 * @param array $args Query args.
	 * @return array
	 */
	private function append_b2b_exclusion_args( array $args ): array {
		$meta_query = isset( $args['meta_query'] ) && is_array( $args['meta_query'] )
			? $args['meta_query']
			: array();
		$meta_query[] = $this->b2b_exclusion_meta_clause();
		$args['meta_query'] = $meta_query;
		return $args;
	}

	/** @return array<string, mixed> */
	private function b2b_exclusion_meta_clause(): array {
		return array(
			'relation' => 'OR',
			array(
				'key'     => self::VENDOR_META,
				'value'   => self::B2B_VENDOR_SLUG,
				'compare' => '!=',
			),
			array(
				'key'     => self::VENDOR_META,
				'compare' => 'NOT EXISTS',
			),
		);
	}

	/**
	 * Drop legacy LPS* product_cat terms and empty feed cats from front-end lists.
	 *
	 * @param array                $terms      Term results.
	 * @param array|string         $taxonomies Taxonomies requested.
	 * @param array|string|WP_Term $args       Query args.
	 * @return array
	 */
	public function filter_product_cat_term_lists( $terms, $taxonomies = array(), $args = array() ) {
		if ( is_admin() || is_wp_error( $terms ) || ! is_array( $terms ) ) {
			return $terms;
		}
		$tax_list = is_array( $taxonomies ) ? $taxonomies : array( $taxonomies );
		if ( ! in_array( 'product_cat', $tax_list, true ) ) {
			return $terms;
		}

		$hide_empty = true;
		if ( is_array( $args ) && array_key_exists( 'hide_empty', $args ) ) {
			$hide_empty = (bool) $args['hide_empty'];
		}

		$legacy = self::LEGACY_VENDOR_CAT_SLUGS;

		return array_values(
			array_filter(
				$terms,
				static function ( $term ) use ( $legacy, $hide_empty ) {
					if ( $term instanceof WP_Term ) {
						if ( in_array( (string) $term->slug, $legacy, true ) ) {
							return false;
						}
						if ( preg_match( '/^lps0[123]$/i', (string) $term->name ) ) {
							return false;
						}
						if ( $hide_empty && (int) $term->count <= 0 ) {
							return false;
						}
						return true;
					}
					if ( is_string( $term ) && in_array( $term, $legacy, true ) ) {
						return false;
					}
					return true;
				}
			)
		);
	}

	/**
	 * @param array $args Widget args.
	 * @return array
	 */
	public function filter_category_widget_args( array $args ): array {
		$args['hide_empty'] = 1;
		$exclude            = isset( $args['exclude'] ) ? (array) $args['exclude'] : array();
		foreach ( self::LEGACY_VENDOR_CAT_SLUGS as $slug ) {
			$term = get_term_by( 'slug', $slug, 'product_cat' );
			if ( $term instanceof WP_Term ) {
				$exclude[] = (int) $term->term_id;
			}
		}
		$args['exclude'] = array_values( array_unique( array_map( 'intval', $exclude ) ) );
		return $args;
	}

	/**
	 * @param array         $items Menu items.
	 * @param WP_Term|mixed $_menu Menu term (unused).
	 * @param array         $_args Menu args (unused).
	 * @return array
	 */
	public function hide_legacy_vendor_cats_from_nav( $items, $_menu = null, $_args = array() ) {
		if ( is_admin() || ! is_array( $items ) ) {
			return $items;
		}
		$legacy = self::LEGACY_VENDOR_CAT_SLUGS;

		return array_values(
			array_filter(
				$items,
				static function ( $item ) use ( $legacy ) {
					if ( ! is_object( $item ) ) {
						return true;
					}
					$object = isset( $item->object ) ? (string) $item->object : '';
					if ( 'product_cat' !== $object ) {
						return true;
					}
					$url = isset( $item->url ) ? (string) $item->url : '';
					foreach ( $legacy as $slug ) {
						if ( false !== strpos( $url, '/product-category/' . $slug ) ) {
							return false;
						}
					}
					$object_id = isset( $item->object_id ) ? (int) $item->object_id : 0;
					if ( $object_id > 0 ) {
						$term = get_term( $object_id, 'product_cat' );
						if ( $term instanceof WP_Term && in_array( (string) $term->slug, $legacy, true ) ) {
							return false;
						}
					}
					return true;
				}
			)
		);
	}

	/**
	 * @param mixed $terms Term list from a tax_query clause.
	 * @param int   $id    Expected numeric id.
	 */
	private function terms_include_id( $terms, int $id ): bool {
		if ( is_numeric( $terms ) && (int) $terms === $id ) {
			return true;
		}
		if ( is_array( $terms ) ) {
			foreach ( $terms as $term ) {
				if ( is_numeric( $term ) && (int) $term === $id ) {
					return true;
				}
			}
		}
		return false;
	}
}
