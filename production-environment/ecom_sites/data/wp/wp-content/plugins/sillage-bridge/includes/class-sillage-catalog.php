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
 * LPS03 (wholesale-perfumes) products must only appear on their own category archive and the
 * dedicated B2B page created by sillage-core. Everything else — shop, search, related products,
 * other category archives — excludes that term.
 *
 * When LPS03 has zero assigned products (vendor inactive / not yet synced), the empty term is
 * also dropped from category widgets, `get_terms` lists, and nav menus. As soon as `tt.count`
 * becomes > 0 after sync, those surfaces show it again — no operator toggle.
 *
 * Resolution uses `sil_vendors.storefront_label` (lime has SELECT) plus the WordPress
 * `product_cat` term — not `sil_term_map`, which the WordPress DB user cannot read.
 */
final class Sillage_Catalog {

	private const B2B_VENDOR_SLUG = 'wholesale-perfumes';
	private const B2B_PAGE_META   = '_sillage_b2b_shop';

	/** @var int|null term_taxonomy_id for the B2B product_cat, or 0 when unknown. */
	private ?int $b2b_tt_id = null;

	/** @var int|null term_id for the B2B product_cat, or 0 when unknown. */
	private ?int $b2b_term_id = null;

	/** @var string|null product_cat slug for the B2B term. */
	private ?string $b2b_slug = null;

	/** @var int|null Cached product count for the B2B term (−1 = unresolved). */
	private ?int $b2b_count = null;

	public function register(): void {
		add_action( 'pre_get_posts', array( $this, 'exclude_b2b_from_main_catalog' ), 20 );
		add_action( 'woocommerce_product_query', array( $this, 'exclude_b2b_from_wc_query' ), 20 );
		add_action( 'wp_enqueue_scripts', array( $this, 'enqueue_image_safety_css' ), 30 );
		add_filter( 'get_terms', array( $this, 'hide_empty_b2b_from_term_lists' ), 20, 3 );
		add_filter( 'woocommerce_product_categories_widget_args', array( $this, 'exclude_empty_b2b_from_category_widget' ), 20 );
		add_filter( 'woocommerce_product_categories_widget_dropdown_args', array( $this, 'exclude_empty_b2b_from_category_widget' ), 20 );
		add_filter( 'wp_get_nav_menu_items', array( $this, 'hide_empty_b2b_from_nav_menus' ), 20, 3 );
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
		if ( $this->should_allow_b2b( $query ) ) {
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
		if ( $this->should_allow_b2b( $query ) ) {
			return;
		}
		$this->append_b2b_exclusion( $query );
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

	/**
	 * Allow B2B products on their category archive and on the dedicated B2B page.
	 *
	 * @param WP_Query $query Query.
	 */
	private function should_allow_b2b( WP_Query $query ): bool {
		$slug = $this->b2b_category_slug();
		if ( '' === $slug ) {
			return false;
		}

		if ( function_exists( 'is_product_category' ) && is_product_category( $slug ) ) {
			return true;
		}

		$tax_query = $query->get( 'tax_query' );
		if ( is_array( $tax_query ) && $this->tax_query_targets_b2b( $tax_query, $slug ) ) {
			return true;
		}

		if ( function_exists( 'is_page' ) && is_page() ) {
			$page_id = (int) get_queried_object_id();
			if ( $page_id > 0 && '1' === (string) get_post_meta( $page_id, self::B2B_PAGE_META, true ) ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * @param array  $tax_query Tax query clauses.
	 * @param string $slug      B2B category slug.
	 */
	private function tax_query_targets_b2b( array $tax_query, string $slug ): bool {
		foreach ( $tax_query as $clause ) {
			if ( ! is_array( $clause ) ) {
				continue;
			}
			if ( isset( $clause['taxonomy'] ) && 'product_cat' === $clause['taxonomy'] ) {
				$terms = $clause['terms'] ?? null;
				$field = isset( $clause['field'] ) ? (string) $clause['field'] : 'term_id';
				if ( 'slug' === $field || '' === $field ) {
					if ( is_string( $terms ) && $terms === $slug ) {
						return true;
					}
					if ( is_array( $terms ) && in_array( $slug, array_map( 'strval', $terms ), true ) ) {
						return true;
					}
				}
			}
			if ( $this->tax_query_targets_b2b( $clause, $slug ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * @param WP_Query $query Query to mutate.
	 */
	private function append_b2b_exclusion( WP_Query $query ): void {
		$tt_id = $this->b2b_term_taxonomy_id();
		if ( $tt_id <= 0 ) {
			return;
		}

		$tax_query = $query->get( 'tax_query' );
		if ( ! is_array( $tax_query ) ) {
			$tax_query = array();
		}

		$tax_query[] = array(
			'taxonomy' => 'product_cat',
			'field'    => 'term_taxonomy_id',
			'terms'    => array( $tt_id ),
			'operator' => 'NOT IN',
		);
		$query->set( 'tax_query', $tax_query );
	}

	/**
	 * Drop the empty B2B product_cat from front-end term lists (widgets, Blocksy, etc.).
	 *
	 * @param array                 $terms      Term results.
	 * @param array|string          $taxonomies Taxonomies requested.
	 * @param array|string|WP_Term  $_args      Query args (unused).
	 * @return array
	 */
	public function hide_empty_b2b_from_term_lists( $terms, $taxonomies = array(), $_args = array() ) {
		if ( is_admin() || is_wp_error( $terms ) || ! is_array( $terms ) || ! $this->is_empty_b2b_category() ) {
			return $terms;
		}
		$tax_list = is_array( $taxonomies ) ? $taxonomies : array( $taxonomies );
		if ( ! in_array( 'product_cat', $tax_list, true ) ) {
			return $terms;
		}

		$term_id = $this->b2b_term_id();
		$tt_id   = $this->b2b_term_taxonomy_id();
		$slug    = $this->b2b_category_slug();

		return array_values(
			array_filter(
				$terms,
				static function ( $term ) use ( $term_id, $tt_id, $slug ) {
					if ( $term instanceof WP_Term ) {
						return (int) $term->term_id !== $term_id
							&& (int) $term->term_taxonomy_id !== $tt_id
							&& (string) $term->slug !== $slug;
					}
					if ( is_numeric( $term ) ) {
						return (int) $term !== $term_id;
					}
					if ( is_string( $term ) ) {
						return $term !== $slug;
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
	public function exclude_empty_b2b_from_category_widget( array $args ): array {
		if ( ! $this->is_empty_b2b_category() ) {
			return $args;
		}
		$term_id = $this->b2b_term_id();
		if ( $term_id <= 0 ) {
			return $args;
		}
		$exclude = isset( $args['exclude'] ) ? (array) $args['exclude'] : array();
		$exclude[] = $term_id;
		$args['exclude'] = array_values( array_unique( array_map( 'intval', $exclude ) ) );
		return $args;
	}

	/**
	 * @param array         $items Menu items.
	 * @param WP_Term|mixed $_menu Menu term (unused).
	 * @param array         $_args Menu args (unused).
	 * @return array
	 */
	public function hide_empty_b2b_from_nav_menus( $items, $_menu = null, $_args = array() ) {
		if ( is_admin() || ! is_array( $items ) || ! $this->is_empty_b2b_category() ) {
			return $items;
		}
		$term_id = $this->b2b_term_id();
		$slug    = $this->b2b_category_slug();
		if ( $term_id <= 0 && '' === $slug ) {
			return $items;
		}

		return array_values(
			array_filter(
				$items,
				static function ( $item ) use ( $term_id, $slug ) {
					if ( ! is_object( $item ) ) {
						return true;
					}
					$object = isset( $item->object ) ? (string) $item->object : '';
					if ( 'product_cat' !== $object ) {
						return true;
					}
					$object_id = isset( $item->object_id ) ? (int) $item->object_id : 0;
					if ( $term_id > 0 && $object_id === $term_id ) {
						return false;
					}
					$url = isset( $item->url ) ? (string) $item->url : '';
					if ( '' !== $slug && false !== strpos( $url, '/product-category/' . $slug ) ) {
						return false;
					}
					return true;
				}
			)
		);
	}

	private function b2b_category_slug(): string {
		$this->resolve_b2b_term();
		return $this->b2b_slug ?? '';
	}

	private function b2b_term_taxonomy_id(): int {
		$this->resolve_b2b_term();
		return $this->b2b_tt_id ?? 0;
	}

	private function b2b_term_id(): int {
		$this->resolve_b2b_term();
		return $this->b2b_term_id ?? 0;
	}

	/** True when the B2B product_cat exists and currently has zero products. */
	private function is_empty_b2b_category(): bool {
		$this->resolve_b2b_term();
		if ( ( $this->b2b_term_id ?? 0 ) <= 0 ) {
			return false;
		}
		return ( $this->b2b_count ?? 0 ) <= 0;
	}

	/**
	 * Resolve the B2B product_cat from sil_vendors.storefront_label → WP term slug/name.
	 */
	private function resolve_b2b_term(): void {
		if ( null !== $this->b2b_tt_id ) {
			return;
		}
		$this->b2b_tt_id   = 0;
		$this->b2b_term_id = 0;
		$this->b2b_slug    = '';
		$this->b2b_count   = 0;

		$label = $this->b2b_storefront_label();
		$guesses = array_values(
			array_unique(
				array_filter(
					array(
						$label ? sanitize_title( $label ) : '',
						'lps03',
						'wholesale-perfumes-eu-soleluna',
						'wholesale-perfumes',
					)
				)
			)
		);

		foreach ( $guesses as $guess ) {
			$term = get_term_by( 'slug', $guess, 'product_cat' );
			if ( ! ( $term instanceof WP_Term ) && $label ) {
				$term = get_term_by( 'name', $label, 'product_cat' );
			}
			if ( $term instanceof WP_Term ) {
				$this->b2b_tt_id   = (int) $term->term_taxonomy_id;
				$this->b2b_term_id = (int) $term->term_id;
				$this->b2b_slug    = (string) $term->slug;
				$this->b2b_count   = (int) $term->count;
				return;
			}
		}
	}

	/** Customer-facing label from sil_vendors (LPS03), or empty when unreadable. */
	private function b2b_storefront_label(): string {
		$cached = wp_cache_get( 'b2b_storefront_label', 'sillage' );
		if ( is_string( $cached ) ) {
			return $cached;
		}

		global $wpdb;
		$suppress = $wpdb->suppress_errors( true );
		$table    = SILLAGE_DB . '.sil_vendors';
		// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table is a constant.
		$label = $wpdb->get_var(
			$wpdb->prepare(
				"SELECT COALESCE(NULLIF(storefront_label, ''), name) FROM {$table} WHERE slug = %s LIMIT 1",
				self::B2B_VENDOR_SLUG
			)
		);
		$wpdb->suppress_errors( $suppress );

		$out = is_string( $label ) ? trim( $label ) : '';
		wp_cache_set( 'b2b_storefront_label', $out, 'sillage', 300 );
		return $out;
	}
}
