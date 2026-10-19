<?php
/**
 * Plugin Name: Sillage Storefront
 * Description: Storefront image service for the React frontend. Serves supplier product images resized and re-encoded as WebP, cached on disk. The shop grid downloads thumbnails, not multi-megabyte originals; the product page downloads one large variant instead of the supplier original.
 * Version: 1.1.0
 * Requires PHP: 8.1
 *
 * Endpoint: GET /wp-json/sillage/v1/img?src=<https url>&w=<280|400|560|1000|1600>
 * - Host allowlist only (no open proxy). Anything else returns 400.
 * - Caches to wp-content/uploads/sillage-img/<sha1>.webp, served with a one-year immutable cache header.
 * - If decoding or resizing fails, it redirects to the original URL, so a broken variant never blocks an image.
 * - The small widths feed the grid and the strip thumbnails; 1000/1600 feed the
 *   product-detail stage, which is drawn at ~650px and 2x on a retina screen.
 */

defined( 'ABSPATH' ) || exit;

const SILLAGE_IMG_VERSION   = '1.1.0';
const SILLAGE_IMG_WIDTHS    = array( 280, 400, 560, 1000, 1600 );
const SILLAGE_IMG_MAX_BYTES = 8 * 1024 * 1024;
const SILLAGE_IMG_QUALITY   = 80;

/** Supplier hosts the storefront may proxy. Keep in sync with the product sync sources. */
function sillage_img_allowed_hosts(): array {
	return array(
		'images.btswholesaler.com',
		'cdn.shopify.com',
		'images.mirainikki.xyz',
		'images.prinscosmetic.eu',
	);
}

function sillage_img_cache_dir(): string {
	$uploads = wp_get_upload_dir();
	return trailingslashit( $uploads['basedir'] ) . 'sillage-img';
}

add_action(
	'rest_api_init',
	static function () {
		register_rest_route(
			'sillage/v1',
			'/img',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'permission_callback' => '__return_true',
				'callback'            => 'sillage_img_endpoint',
				'args'                => array(
					'src' => array( 'required' => true ),
					'w'   => array( 'required' => false ),
				),
			)
		);
	}
);

/** Validate the source URL against the host allowlist. Returns the sanitized URL or null. */
function sillage_img_validate_src( string $src ): ?string {
	$src = trim( $src );
	if ( '' === $src || strlen( $src ) > 2000 ) {
		return null;
	}
	$parts = wp_parse_url( $src );
	if ( ! is_array( $parts ) || ( $parts['scheme'] ?? '' ) !== 'https' || empty( $parts['host'] ) ) {
		return null;
	}
	if ( ! in_array( strtolower( $parts['host'] ), sillage_img_allowed_hosts(), true ) ) {
		return null;
	}
	return $src;
}

/** Nearest allowed width, so the cache holds a bounded set of variants per image. */
function sillage_img_pick_width( $raw ): int {
	$want = (int) $raw;
	if ( $want <= 0 ) {
		$want = 400;
	}
	$best = SILLAGE_IMG_WIDTHS[0];
	foreach ( SILLAGE_IMG_WIDTHS as $width ) {
		if ( abs( $width - $want ) < abs( $best - $want ) ) {
			$best = $width;
		}
	}
	return $best;
}

function sillage_img_endpoint( WP_REST_Request $request ) {
	$src = sillage_img_validate_src( (string) $request->get_param( 'src' ) );
	if ( null === $src ) {
		return new WP_Error( 'sillage_img_host', 'Image host is not allowed.', array( 'status' => 400 ) );
	}
	$width = sillage_img_pick_width( $request->get_param( 'w' ) );

	$dir  = sillage_img_cache_dir();
	$file = $dir . '/' . sha1( $src . '|' . $width ) . '.webp';

	if ( ! is_file( $file ) ) {
		$encoded = sillage_img_render( $src, $width );
		if ( null === $encoded ) {
			// Could not process: send the browser to the original rather than failing the image.
			wp_redirect( $src, 302 ); // phpcs:ignore WordPress.Security.SafeRedirect.wp_redirect_wp_redirect
			exit;
		}
		wp_mkdir_p( $dir );
		$tmp = $file . '.' . wp_generate_password( 8, false ) . '.tmp';
		if ( false === file_put_contents( $tmp, $encoded ) || ! rename( $tmp, $file ) ) {
			@unlink( $tmp ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			wp_redirect( $src, 302 ); // phpcs:ignore WordPress.Security.SafeRedirect.wp_redirect_wp_redirect
			exit;
		}
	}

	header( 'Content-Type: image/webp' );
	header( 'Content-Length: ' . filesize( $file ) );
	header( 'Cache-Control: public, max-age=31536000, immutable' );
	header( 'X-Sillage-Img: ' . SILLAGE_IMG_VERSION );
	readfile( $file ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_readfile
	exit;
}

/** Download, resize down to $width (never up), and re-encode as WebP. Null on any failure. */
function sillage_img_render( string $src, int $width ): ?string {
	if ( ! function_exists( 'imagecreatefromstring' ) || ! function_exists( 'imagewebp' ) ) {
		return null;
	}

	$response = wp_remote_get(
		$src,
		array(
			'timeout'             => 12,
			'limit_response_size' => SILLAGE_IMG_MAX_BYTES,
			'redirection'         => 2,
			'user-agent'          => 'SillageStorefront/' . SILLAGE_IMG_VERSION,
		)
	);
	if ( is_wp_error( $response ) || 200 !== (int) wp_remote_retrieve_response_code( $response ) ) {
		return null;
	}
	$body = wp_remote_retrieve_body( $response );
	if ( '' === $body ) {
		return null;
	}

	$source = @imagecreatefromstring( $body ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
	if ( false === $source ) {
		return null;
	}

	$orig_w = imagesx( $source );
	$orig_h = imagesy( $source );
	if ( $orig_w <= 0 || $orig_h <= 0 ) {
		imagedestroy( $source );
		return null;
	}

	$target_w = min( $width, $orig_w );
	$target_h = (int) round( $orig_h * ( $target_w / $orig_w ) );

	$canvas = imagecreatetruecolor( $target_w, max( 1, $target_h ) );
	imagealphablending( $canvas, false );
	imagesavealpha( $canvas, true );
	$transparent = imagecolorallocatealpha( $canvas, 0, 0, 0, 127 );
	imagefill( $canvas, 0, 0, $transparent );
	imagecopyresampled( $canvas, $source, 0, 0, 0, 0, $target_w, max( 1, $target_h ), $orig_w, $orig_h );
	imagedestroy( $source );

	ob_start();
	$ok = imagewebp( $canvas, null, SILLAGE_IMG_QUALITY );
	$out = ob_get_clean();
	imagedestroy( $canvas );

	return ( $ok && is_string( $out ) && '' !== $out ) ? $out : null;
}
