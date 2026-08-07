<?php
/**
 * Storefront catalog helpers: optional wholesaler landing page, catalog visibility,
 * and external product image safety.
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
 * All active vendors (including wholesale-perfumes) appear on the main shop, search, and
 * category archives like BF/BTS. Optional page `/b2b-wholesale/` (`_sillage_b2b_shop` postmeta)
 * remains a filtered landing that lists only wholesale-perfumes, with a sidebar of feed
 * browse categories. Differentiator for that vendor is per-vendor MOQ at cart/checkout, not
 * a separate B2B portal.
 *
 * Legacy LPS* `product_cat` terms (from an earlier mistaken lane) are stripped from category
 * widgets / `get_terms` / nav if they still exist. Empty feed categories are hidden too.
 */
final class Sillage_Catalog {

	private const B2B_VENDOR_SLUG = 'wholesale-perfumes';
	private const B2B_PAGE_META   = '_sillage_b2b_shop';
	private const VENDOR_META     = '_sillage_vendor';
	private const B2B_CAT_QUERY   = 'b2b_cat';
	private const INCLUDE_FLAG    = 'sillage_include_b2b';

	/** @var string[] Legacy product_cat slugs that must never appear in browse UI. */
	private const LEGACY_VENDOR_CAT_SLUGS = array( 'lps01', 'lps02', 'lps03' );

	public function register(): void {
		add_action( 'pre_get_posts', array( $this, 'ensure_main_catalog_visibility' ), 20 );
		add_action( 'woocommerce_product_query', array( $this, 'ensure_wc_catalog_visibility' ), 20 );
		// Blocksy live search uses WP REST /wp/v2/search (not the main query). After Blocksy's
		// rest_post_search_query (priority 999) so we keep its visibility/tax patches.
		add_filter( 'rest_post_search_query', array( $this, 'ensure_rest_search_visibility' ), 1000, 2 );
		add_filter( 'woocommerce_shortcode_products_query', array( $this, 'filter_b2b_shortcode_products' ), 20, 3 );
		add_filter( 'posts_clauses', array( $this, 'filter_posts_clauses' ), 20, 2 );
		add_filter( 'query_vars', array( $this, 'register_query_vars' ) );
		add_filter( 'the_content', array( $this, 'wrap_b2b_page_content' ), 12 );
		add_shortcode( 'sillage_b2b_categories', array( $this, 'shortcode_b2b_categories' ) );
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
			. '}'
			. '.sillage-b2b-layout{display:flex;flex-wrap:wrap;gap:1.5rem;align-items:flex-start;}'
			. '.sillage-b2b-sidebar{flex:0 0 14rem;max-width:100%;}'
			. '.sillage-b2b-main{flex:1 1 20rem;min-width:0;}'
			. '.sillage-b2b-cats{list-style:none;margin:0;padding:0;}'
			. '.sillage-b2b-cats li{margin:0 0 .35rem;}'
			. '.sillage-b2b-cats a{text-decoration:none;}'
			. '.sillage-b2b-cats a.is-active{font-weight:700;}'
			. '.sillage-b2b-cats-title{margin:0 0 .75rem;font-size:1rem;}';
		wp_register_style( 'sillage-bridge-images', false, array(), SILLAGE_BRIDGE_VERSION );
		wp_enqueue_style( 'sillage-bridge-images' );
		wp_add_inline_style( 'sillage-bridge-images', $css );
	}

	/**
	 * @param string[] $vars Public query vars.
	 * @return string[]
	 */
	public function register_query_vars( array $vars ): array {
		$vars[] = self::B2B_CAT_QUERY;
		return $vars;
	}

	/**
	 * @param WP_Query $query Main query.
	 */
	public function ensure_main_catalog_visibility( $query ): void {
		if ( is_admin() || ! $query instanceof WP_Query || ! $query->is_main_query() ) {
			return;
		}
		if ( $query->is_singular() ) {
			return;
		}
		if ( ! $this->is_product_listing_query( $query ) ) {
			return;
		}
		$this->ensure_catalog_visibility( $query );
	}

	/**
	 * WooCommerce shortcodes / product loops that skip the main query.
	 *
	 * @param WP_Query $query Product query.
	 */
	public function ensure_wc_catalog_visibility( $query ): void {
		if ( is_admin() || ! $query instanceof WP_Query ) {
			return;
		}
		if ( $query->is_singular() ) {
			return;
		}
		$this->ensure_catalog_visibility( $query );
	}

	/**
	 * Enforce catalog visibility on Blocksy/WP REST live search.
	 *
	 * @param array           $args    WP_Query args for the search.
	 * @param WP_REST_Request $request REST request.
	 * @return array
	 */
	public function ensure_rest_search_visibility( $args, $request ) {
		if ( ! is_array( $args ) ) {
			return $args;
		}

		$post_type        = $args['post_type'] ?? '';
		$includes_product = ( 'product' === $post_type )
			|| ( is_array( $post_type ) && in_array( 'product', $post_type, true ) );
		if ( ! $includes_product ) {
			return $args;
		}

		unset( $request );
		return $this->ensure_catalog_visibility_args( $args );
	}

	/**
	 * On the optional wholesaler landing page, `[products]` shortcodes list only wholesale-perfumes.
	 * Optional `?b2b_cat=<product_cat slug>` further scopes to a feed browse category.
	 *
	 * @param array  $query_args Shortcode query args.
	 * @param array  $attributes Shortcode attributes.
	 * @param string $_type      Shortcode type (unused).
	 * @return array
	 */
	public function filter_b2b_shortcode_products( $query_args, $attributes = array(), $_type = '' ) {
		unset( $attributes, $_type );
		if ( ! is_array( $query_args ) || ! $this->is_b2b_landing_page() ) {
			return $query_args;
		}

		$query_args[ self::INCLUDE_FLAG ] = 1;

		$cat = $this->current_b2b_cat_slug();
		if ( '' !== $cat ) {
			$tax_query = isset( $query_args['tax_query'] ) && is_array( $query_args['tax_query'] )
				? $query_args['tax_query']
				: array();
			$tax_query[] = array(
				'taxonomy' => 'product_cat',
				'field'    => 'slug',
				'terms'    => array( $cat ),
			);
			$query_args['tax_query'] = $tax_query;
		}

		return $query_args;
	}

	/**
	 * Fast wholesale-perfumes include on the optional landing page without WP's OR meta_query.
	 *
	 * @param array    $clauses SQL clauses.
	 * @param WP_Query $query   Query.
	 * @return array
	 */
	public function filter_posts_clauses( $clauses, $query ) {
		if ( ! is_array( $clauses ) || ! $query instanceof WP_Query ) {
			return $clauses;
		}

		$include = (bool) $query->get( self::INCLUDE_FLAG );
		if ( ! $include ) {
			return $clauses;
		}

		global $wpdb;
		$marker = 'sillage_b2b_incl';
		if ( isset( $clauses['where'] ) && is_string( $clauses['where'] ) && false !== strpos( $clauses['where'], $marker ) ) {
			return $clauses;
		}

		$clauses['where'] .= $wpdb->prepare(
			" AND EXISTS ( /* {$marker} */ SELECT 1 FROM {$wpdb->postmeta} pm_sillage_b2b"
			. " WHERE pm_sillage_b2b.post_id = {$wpdb->posts}.ID"
			. ' AND pm_sillage_b2b.meta_key = %s AND pm_sillage_b2b.meta_value = %s )',
			self::VENDOR_META,
			self::B2B_VENDOR_SLUG
		);
		return $clauses;
	}

	/**
	 * Left sidebar of feed browse categories that contain wholesale-perfumes products.
	 *
	 * @param string $content Page content.
	 * @return string
	 */
	public function wrap_b2b_page_content( $content ) {
		if ( is_admin() || ! is_string( $content ) || ! $this->is_b2b_landing_page() ) {
			return $content;
		}
		if ( ! in_the_loop() || ! is_main_query() ) {
			return $content;
		}
		// Avoid double-wrapping if the page already embeds the shortcode layout.
		if ( false !== strpos( $content, 'sillage-b2b-layout' ) || false !== strpos( $content, '[sillage_b2b_categories' ) ) {
			return $content;
		}

		$sidebar = $this->render_b2b_categories_html();
		return '<div class="sillage-b2b-layout">'
			. '<aside class="sillage-b2b-sidebar" aria-label="' . esc_attr__( 'Wholesale categories', 'sillage-bridge' ) . '">'
			. $sidebar
			. '</aside>'
			. '<div class="sillage-b2b-main">' . $content . '</div>'
			. '</div>';
	}

	/**
	 * @param array|string $atts Shortcode attributes (unused).
	 * @return string
	 */
	public function shortcode_b2b_categories( $atts = array() ): string {
		unset( $atts );
		if ( ! $this->is_b2b_landing_page() ) {
			return '';
		}
		return $this->render_b2b_categories_html();
	}

	/**
	 * @param WP_Query $query Query.
	 */
	private function is_product_listing_query( WP_Query $query ): bool {
		if ( $query->is_singular() ) {
			return false;
		}
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

	/** True on the optional wholesale-perfumes landing page only. */
	private function is_b2b_landing_page(): bool {
		if ( function_exists( 'is_page' ) && is_page() ) {
			$page_id = (int) get_queried_object_id();
			if ( $page_id > 0 && '1' === (string) get_post_meta( $page_id, self::B2B_PAGE_META, true ) ) {
				return true;
			}
		}
		return false;
	}

	/** Active `b2b_cat` slug from the request, or empty. */
	private function current_b2b_cat_slug(): string {
		$cat = get_query_var( self::B2B_CAT_QUERY );
		if ( ! is_string( $cat ) || '' === $cat ) {
			// phpcs:ignore WordPress.Security.NonceVerification.Recommended
			$raw = isset( $_GET[ self::B2B_CAT_QUERY ] ) ? wp_unslash( (string) $_GET[ self::B2B_CAT_QUERY ] ) : '';
			$cat = $raw;
		}
		$cat = sanitize_title( (string) $cat );
		return $cat;
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

	/** @return string HTML list of WPF-scoped product_cat terms. */
	private function render_b2b_categories_html(): string {
		$terms = $this->get_b2b_category_terms();
		$page  = get_permalink( (int) get_queried_object_id() );
		if ( ! is_string( $page ) || '' === $page ) {
			$page = home_url( '/b2b-wholesale/' );
		}
		$active = $this->current_b2b_cat_slug();

		$html  = '<h2 class="sillage-b2b-cats-title">' . esc_html__( 'Categories', 'sillage-bridge' ) . '</h2>';
		$html .= '<ul class="sillage-b2b-cats">';
		$all_class = '' === $active ? ' is-active' : '';
		$html     .= '<li><a class="' . esc_attr( trim( $all_class ) ) . '" href="' . esc_url( $page ) . '">'
			. esc_html__( 'All products', 'sillage-bridge' ) . '</a></li>';

		foreach ( $terms as $term ) {
			$url   = add_query_arg( self::B2B_CAT_QUERY, $term['slug'], $page );
			$class = ( $active === $term['slug'] ) ? ' is-active' : '';
			$label = $term['name'] . ' (' . (string) $term['count'] . ')';
			$html .= '<li><a class="' . esc_attr( trim( $class ) ) . '" href="' . esc_url( $url ) . '">'
				. esc_html( $label ) . '</a></li>';
		}
		$html .= '</ul>';
		return $html;
	}

	/**
	 * product_cat terms that have at least one published wholesale-perfumes product.
	 *
	 * @return array<int, array{term_id:int,name:string,slug:string,count:int}>
	 */
	private function get_b2b_category_terms(): array {
		$cached = get_transient( 'sillage_b2b_cats_v1' );
		if ( is_array( $cached ) ) {
			return $cached;
		}

		global $wpdb;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery, WordPress.DB.DirectDatabaseQuery.NoCaching
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				"SELECT t.term_id, t.name, t.slug, COUNT(DISTINCT p.ID) AS wpf_count
				FROM {$wpdb->terms} t
				INNER JOIN {$wpdb->term_taxonomy} tt
					ON tt.term_id = t.term_id AND tt.taxonomy = 'product_cat'
				INNER JOIN {$wpdb->term_relationships} tr
					ON tr.term_taxonomy_id = tt.term_taxonomy_id
				INNER JOIN {$wpdb->posts} p
					ON p.ID = tr.object_id AND p.post_type = 'product' AND p.post_status = 'publish'
				INNER JOIN {$wpdb->postmeta} pm
					ON pm.post_id = p.ID AND pm.meta_key = %s AND pm.meta_value = %s
				WHERE t.slug NOT IN ('lps01','lps02','lps03')
				GROUP BY t.term_id, t.name, t.slug
				HAVING wpf_count > 0
				ORDER BY t.name ASC
				LIMIT 200",
				self::VENDOR_META,
				self::B2B_VENDOR_SLUG
			),
			ARRAY_A
		);

		$terms = array();
		if ( is_array( $rows ) ) {
			foreach ( $rows as $row ) {
				$slug = (string) ( $row['slug'] ?? '' );
				if ( '' === $slug || preg_match( '/^lps0[123]$/i', (string) ( $row['name'] ?? '' ) ) ) {
					continue;
				}
				$terms[] = array(
					'term_id' => (int) ( $row['term_id'] ?? 0 ),
					'name'    => (string) ( $row['name'] ?? '' ),
					'slug'    => $slug,
					'count'   => (int) ( $row['wpf_count'] ?? 0 ),
				);
			}
		}

		set_transient( 'sillage_b2b_cats_v1', $terms, 15 * MINUTE_IN_SECONDS );
		return $terms;
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
