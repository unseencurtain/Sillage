<?php
/**
 * Plugin Name: Storefront EAN API
 * Description: Exposes published product EANs and the first-party storefront category filter to the headless storefront.
 * Version: 1.1.0
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

/** Restrict Store API catalogue results to the active suppliers and products with an image. */
add_filter(
	'rest_request_before_callbacks',
	static function ( $response, $handler, WP_REST_Request $request ) {
		unset( $handler );
		if ( '/wc/store/v1/products' === untrailingslashit( $request->get_route() ) ) {
			$GLOBALS['cereve_storefront_product_collection_request'] = $request;
		}
		return $response;
	},
	10,
	3
);

add_action(
	'pre_get_posts',
	static function ( WP_Query $query ): void {
		$request = $GLOBALS['cereve_storefront_product_collection_request'] ?? null;
		if ( ! ( $request instanceof WP_REST_Request ) || ! in_array( 'product', (array) $query->get( 'post_type' ), true ) ) {
			return;
		}

		// Re-apply the Store API category last and match direct terms only. Sillage attaches every
		// segment of a vendor category path to the product, so recursive expansion is unnecessary;
		// it can also leak unrelated products when WordPress's cached child tree is stale.
		$raw_categories = $request->get_param( 'category' );
		if ( is_string( $raw_categories ) ) {
			$categories = wp_parse_list( $raw_categories );
		} elseif ( is_array( $raw_categories ) ) {
			$categories = $raw_categories;
		} else {
			$categories = array();
		}
		$categories = array_values(
			array_unique(
				array_filter(
					array_map(
						static function ( $category ): string {
							if ( ! is_scalar( $category ) ) {
								return '';
							}
							$value = trim( (string) $category );
							return is_numeric( $value ) ? (string) absint( $value ) : sanitize_title( $value );
						},
						$categories
					)
				)
			)
		);

		if ( $categories ) {
			$operator = strtolower( (string) $request->get_param( 'category_operator' ) );
			$operator = array(
				'in'     => 'IN',
				'not_in' => 'NOT IN',
				'and'    => 'AND',
			)[ $operator ] ?? 'IN';
			$field             = is_numeric( $categories[0] ) ? 'term_id' : 'slug';
			$category_tax_query = array(
				'taxonomy'         => 'product_cat',
				'field'            => $field,
				'terms'            => $categories,
				'operator'         => $operator,
				'include_children' => false,
			);
			$existing_tax_query = $query->get( 'tax_query' );

			$query->set(
				'tax_query',
				is_array( $existing_tax_query ) && $existing_tax_query
					? array(
						'relation' => 'AND',
						$existing_tax_query,
						$category_tax_query,
					)
					: array( $category_tax_query )
			);
		}
	},
	9999
);

/** Include the harmonised legal-guarantee notice with customer order emails. */
add_action(
	'woocommerce_email_after_order_table',
	'cereve_storefront_email_legal_guarantee_notice',
	15,
	4
);

function cereve_storefront_email_legal_guarantee_notice( $order, $sent_to_admin, $plain_text, $email ): void {
	if ( $sent_to_admin || ! ( $order instanceof WC_Order ) ) {
		return;
	}

	$email_id = is_object( $email ) && isset( $email->id ) ? (string) $email->id : '';
	if ( ! in_array( $email_id, array( 'customer_processing_order', 'customer_on_hold_order', 'customer_completed_order' ), true ) ) {
		return;
	}

	$notice_url = 'https://perfume.mirainikki.xyz/legal-pages/eu-legal-guarantee-notice-en.svg';
	$more_url   = 'https://europa.eu/youreurope/guarantees';

	if ( $plain_text ) {
		echo "\n";
		echo "YOUR LEGAL GUARANTEE RIGHTS\n";
		echo "Goods bought in the EU have a minimum two-year legal guarantee of conformity; national law may provide a longer period.\n";
		echo "Official EU notice: " . esc_url( $notice_url ) . "\n";
		echo "More information: " . esc_url( $more_url ) . "\n";
		return;
	}

	echo '<div style="margin:24px 0;padding:18px;background:#f1f5fb;border-left:4px solid #164194;">';
	echo '<p style="margin:0 0 8px;"><strong>Your legal guarantee rights</strong></p>';
	echo '<p style="margin:0 0 12px;">Goods bought in the EU have a minimum two-year legal guarantee of conformity; national law may provide a longer period.</p>';
	echo '<p style="margin:0 0 12px;"><a href="' . esc_url( $notice_url ) . '">View the official EU harmonised notice</a> · <a href="' . esc_url( $more_url ) . '">Read more on Your Europe</a></p>';
	echo '<a href="' . esc_url( $notice_url ) . '"><img src="' . esc_url( $notice_url ) . '" width="420" alt="Official EU harmonised notice on the legal guarantee of conformity" style="display:block;width:100%;max-width:420px;height:auto;border:0;" /></a>';
	echo '</div>';
}

/** Resolve an EAN through WooCommerce's indexed global unique ID lookup. */
function cereve_storefront_find_ean( WP_REST_Request $request ) {
	$ean        = (string) $request->get_param( 'ean' );
	$product_id = function_exists( 'wc_get_product_id_by_global_unique_id' )
		? wc_get_product_id_by_global_unique_id( $ean )
		: 0;

	if ( ! $product_id ) {
		return new WP_Error( 'product_ean_not_found', __( 'No product matches that EAN.', 'storefront-ean' ), array( 'status' => 404 ) );
	}

	$product = wc_get_product( $product_id );
	if ( ! $product || 'publish' !== get_post_status( $product->get_id() ) ) {
		return new WP_Error( 'product_ean_not_found', __( 'No product matches that EAN.', 'storefront-ean' ), array( 'status' => 404 ) );
	}

	return rest_ensure_response(
		array(
			'id'  => (int) $product->get_id(),
			'ean' => (string) $product->get_global_unique_id(),
		)
	);
}

/** Return the EAN for a published product only. */
function cereve_storefront_product_ean( WP_REST_Request $request ) {
	$product = wc_get_product( absint( $request->get_param( 'id' ) ) );
	if ( ! $product || 'publish' !== get_post_status( $product->get_id() ) ) {
		return new WP_Error( 'product_not_found', __( 'Product not found.', 'storefront-ean' ), array( 'status' => 404 ) );
	}

	return rest_ensure_response(
		array(
			'id'  => (int) $product->get_id(),
			'ean' => (string) $product->get_global_unique_id(),
		)
	);
}
