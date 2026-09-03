<?php
/**
 * SEO helpers: keep Google able to crawl and discover the catalogue.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * WordPress core sitemap pagination sets HTTP 404 once `paged` exceeds the *blog post*
 * page count, even when the product sitemap body is valid XML (Trac #51912 / #65375).
 * Google discards those 404 responses, so only the first ~2000 products stay discoverable.
 *
 * Also: catalogue-hidden SKUs (no image / stock / operator pin) stay Published for sync,
 * but must not be offered to Google as indexable pages.
 */
final class Sillage_Seo {

	public function register(): void {
		add_filter( 'pre_handle_404', array( $this, 'bypass_sitemap_false_404' ), 10, 2 );
		add_action( 'template_redirect', array( $this, 'force_sitemap_ok_status' ), 0 );
		add_filter( 'wp_sitemaps_add_provider', array( $this, 'drop_users_sitemap' ), 10, 2 );
		add_filter( 'wp_robots', array( $this, 'robots_for_hidden_products' ), 20 );
	}

	/**
	 * Skip WP::handle_404() on core sitemap requests so paginated product sitemaps stay 200.
	 *
	 * @param bool     $preempt  Whether to short-circuit the 404 handler.
	 * @param WP_Query $wp_query The main query.
	 */
	public function bypass_sitemap_false_404( $preempt, $wp_query ): bool {
		if ( $preempt ) {
			return (bool) $preempt;
		}
		if ( ! ( $wp_query instanceof WP_Query ) ) {
			return false;
		}
		if ( $wp_query->get( 'sitemap' ) ) {
			return true;
		}
		return false;
	}

	/**
	 * Belt-and-braces: if something already stamped 404 before template_redirect, clear it
	 * for sitemap responses (render still happens later on the same hook at priority 10+).
	 */
	public function force_sitemap_ok_status(): void {
		if ( ! get_query_var( 'sitemap' ) ) {
			return;
		}
		global $wp_query;
		if ( $wp_query instanceof WP_Query ) {
			$wp_query->is_404 = false;
		}
		status_header( 200 );
		nocache_headers();
	}

	/**
	 * Author archives are noise for a dropshipping catalogue.
	 *
	 * @param WP_Sitemaps_Provider|false $provider Provider instance or false.
	 * @param string                     $name     Provider name.
	 * @return WP_Sitemaps_Provider|false
	 */
	public function drop_users_sitemap( $provider, string $name ) {
		if ( 'users' === $name ) {
			return false;
		}
		return $provider;
	}

	/**
	 * Catalogue-hidden products remain published (Sillage sync) but should not rank.
	 *
	 * @param array<string, bool|string> $robots Robots directives.
	 * @return array<string, bool|string>
	 */
	public function robots_for_hidden_products( array $robots ): array {
		if ( ! function_exists( 'is_product' ) || ! is_product() ) {
			return $robots;
		}
		$product = wc_get_product( get_queried_object_id() );
		if ( ! $product ) {
			return $robots;
		}
		// Matches shop loop rules: exclude-from-catalog OR exclude-from-search.
		if ( ! $product->is_visible() ) {
			$robots['noindex']  = true;
			$robots['nofollow'] = true;
			unset( $robots['max-image-preview'] );
		}
		return $robots;
	}
}
