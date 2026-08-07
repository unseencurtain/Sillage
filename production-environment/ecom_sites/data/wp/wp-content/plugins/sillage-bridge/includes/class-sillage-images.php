<?php
/**
 * Render product images straight from the vendor's CDN.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Serves product images from the vendor URL stored in postmeta.
 *
 * There are no attachments and no files under wp-content/uploads for synced products. Downloading
 * 52,000 images would cost hours of import time and gigabytes of disk for no benefit, since both
 * vendors already serve them over HTTPS from their own infrastructure. The URL is emitted exactly
 * as the vendor supplied it.
 *
 * ## Why this hooks the attachment layer rather than any gallery template
 *
 * Themes do not agree on how a product image is rendered. WooCommerce's own templates call
 * `wp_get_attachment_image()`, Blocksy builds its gallery from attachment IDs and ignores the
 * `woocommerce_before_single_product_summary` output entirely, Elementor has its own widget, and
 * the block templates go through yet another path. Overriding each renderer means a new hook for
 * every theme, and silent breakage the day the theme changes.
 *
 * What all of them share is the attachment ID. So instead of replacing renderers, this makes the
 * product *look like* it has a thumbnail: `post_thumbnail_id` returns an ID, and the resolution
 * filters below turn that ID into the vendor URL. Every theme, the REST API, wp-admin, structured
 * data and the block editor then work unmodified.
 *
 * The ID handed out is the product's own post ID. A synthetic ID would be tidier but
 * `wp_get_attachment_image()` calls `get_post()` on it, and a null post there is fatal — the
 * product post is guaranteed to exist.
 *
 * This carries one real limitation: one image per product, since a post ID identifies exactly one
 * URL. Both vendors currently ship exactly one image per product (verified across all 52,270
 * products with an image), so nothing is lost. A vendor with real galleries would need synthetic
 * IDs and a matching `get_post` shim.
 */
final class Sillage_Images {

	private const THUMB_META = '_external_thumbnail_url';

	/** Memoised per request; these filters run on every image on the page. */
	private array $url_cache = array();

	public function register(): void {
		// Make the product report a thumbnail. Everything else follows from this.
		add_filter( 'post_thumbnail_id', array( $this, 'thumbnail_id' ), 10, 2 );
		add_filter( 'woocommerce_product_get_image_id', array( $this, 'product_image_id' ), 10, 2 );

		// Resolve that ID to the vendor URL. image_downsize is the single choke point that
		// wp_get_attachment_image(), _src(), _url() and every theme helper funnel through.
		add_filter( 'image_downsize', array( $this, 'downsize' ), 10, 3 );
		add_filter( 'wp_get_attachment_url', array( $this, 'attachment_url' ), 10, 2 );

		// Alt text is supplied as attachment meta rather than as an image attribute, because the
		// Store API and the block editor read the meta directly and never build an <img> tag.
		add_filter( 'get_post_metadata', array( $this, 'image_alt_meta' ), 10, 4 );

		// Structured data and social meta read the attachment image, which does not exist.
		add_filter( 'woocommerce_structured_data_product', array( $this, 'structured_data' ), 10, 2 );
	}

	/**
	 * The vendor thumbnail URL for a product, or an empty string.
	 *
	 * @param int $product_id Product post ID.
	 */
	public static function thumbnail_url( int $product_id ): string {
		$url = get_post_meta( $product_id, self::THUMB_META, true );
		return is_string( $url ) ? trim( $url ) : '';
	}

	/**
	 * Cached lookup guarded by post type, since the resolution filters fire for every image on
	 * the page including logos, avatars and block images.
	 *
	 * @param int $id Candidate post ID.
	 */
	private function url_for( int $id ): string {
		if ( $id <= 0 ) {
			return '';
		}
		if ( isset( $this->url_cache[ $id ] ) ) {
			return $this->url_cache[ $id ];
		}

		$url = 'product' === get_post_type( $id ) ? self::thumbnail_url( $id ) : '';

		$this->url_cache[ $id ] = $url;
		return $url;
	}

	/**
	 * Report the product's own ID as its thumbnail ID.
	 *
	 * @param int|string  $thumbnail_id Existing thumbnail ID, 0 when there is none.
	 * @param int|WP_Post $post         Post or post ID.
	 * @return int
	 */
	public function thumbnail_id( $thumbnail_id, $post = null ) {
		if ( ! empty( $thumbnail_id ) ) {
			return (int) $thumbnail_id;
		}
		$post_id = $post instanceof WP_Post ? $post->ID : (int) $post;

		return '' === $this->url_for( $post_id ) ? (int) $thumbnail_id : $post_id;
	}

	/**
	 * Same, for WC_Product::get_image_id().
	 *
	 * @param int|string $image_id Existing image ID.
	 * @param mixed      $product  Product object.
	 * @return int
	 */
	public function product_image_id( $image_id, $product = null ) {
		if ( ! empty( $image_id ) || ! $product instanceof WC_Product ) {
			return (int) $image_id;
		}
		$product_id = $product->get_id();

		return '' === $this->url_for( $product_id ) ? (int) $image_id : $product_id;
	}

	/**
	 * Resolve an ID to the vendor URL, short-circuiting WordPress's file-based sizing.
	 *
	 * Width and height are reported as 0 deliberately. The vendor feeds do not carry image
	 * dimensions, and guessing them would emit `width`/`height` attributes that fix a wrong aspect
	 * ratio on the element. Zero makes `image_hwstring()` omit both, so the browser uses the
	 * image's real dimensions.
	 *
	 * @param bool|array   $downsize Short-circuit value.
	 * @param int          $id       Attachment ID.
	 * @param string|int[] $size     Requested size.
	 * @return bool|array
	 */
	public function downsize( $downsize, $id, $size = 'medium' ) {
		unset( $size );
		if ( false !== $downsize ) {
			return $downsize;
		}
		$url = $this->url_for( (int) $id );
		if ( '' === $url ) {
			return $downsize;
		}
		return array( $url, 0, 0, false );
	}

	/**
	 * Resolve wp_get_attachment_url() for a product standing in as its own attachment.
	 *
	 * @param string $url     Resolved URL, pointing into wp-content/uploads.
	 * @param int    $post_id Attachment ID.
	 * @return string
	 */
	public function attachment_url( $url, $post_id ) {
		$external = $this->url_for( (int) $post_id );
		return '' === $external ? $url : $external;
	}

	/**
	 * Give the image real alt text, falling back to the product name.
	 *
	 * Alt normally lives in `_wp_attachment_image_alt` on the attachment, which synced products do
	 * not have, so without this every product image ships empty alt text.
	 *
	 * @param mixed  $value     Short-circuit value; null means "not handled".
	 * @param int    $object_id Post ID being read.
	 * @param string $meta_key  Meta key being read.
	 * @param bool   $single    Whether a single value was requested.
	 * @return mixed
	 */
	public function image_alt_meta( $value, $object_id, $meta_key, $single ) {
		if ( '_wp_attachment_image_alt' !== $meta_key || null !== $value ) {
			return $value;
		}
		if ( '' === $this->url_for( (int) $object_id ) ) {
			return $value;
		}
		$alt = get_the_title( (int) $object_id );

		return $single ? $alt : array( $alt );
	}

	/**
	 * Put the vendor URL into product schema markup, which otherwise reports no image.
	 *
	 * @param array $markup  Structured data.
	 * @param mixed $product Product object.
	 * @return array
	 */
	public function structured_data( $markup, $product ) {
		if ( ! is_array( $markup ) || ! $product instanceof WC_Product ) {
			return $markup;
		}
		if ( ! empty( $markup['image'] ) ) {
			return $markup;
		}
		$url = $this->url_for( $product->get_id() );
		if ( '' !== $url ) {
			$markup['image'] = esc_url_raw( $url );
		}
		return $markup;
	}
}
