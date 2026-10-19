<?php
/**
 * Plugin Name: Storefront Best Sellers
 * Description: The curated "Best sellers" row and page, edited by EAN.
 * Version: 1.0.0
 *
 * One job: hold an ordered list of EANs and publish the product IDs they resolve to at
 * `sillage/v1/best-sellers`. The storefront renders them in this order on the home page and on
 * /best-sellers, and falls back to WooCommerce's own popularity ranking while the list is empty.
 *
 * The editor is the admin screen under "Best sellers". Everything else the storefront calls lives
 * elsewhere — EAN lookup inside WordPress is `storefront-ean`, country scope and shipping are
 * `sillage-warehouses`. Do not grow this plugin past the curated list.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'SILLAGE_BS_OPTION', 'sillage_best_sellers_eans' );
define( 'SILLAGE_BS_SLUG', 'sillage-best-sellers' );

/**
 * The starting edit, so a fresh install shows a full row instead of waiting for someone to log in
 * and pick. These are premium products the supplier already stocks.
 *
 * It is only a default: the moment the owner saves anything — including clearing the list — the
 * stored option wins, and this constant is never consulted again. Replace it from the
 * "Best sellers" screen.
 */
const SILLAGE_BS_DEFAULT_EANS = array(
	'3348901609265', // Dior Prestige La Micro-Huile de Rose serum 50ml
	'7611773108638', // La Prairie Platinum Rare Haute-Rejuvenation cream 30ml
	'3442180006125', // Courrèges Les Parfums discovery set, 7 x 10ml
	'3349668614684', // Paco Rabanne Fame Parfum 200ml refill
	'7611773082242', // La Prairie Skin Caviar concealer foundation SPF 15
	'7640233340035', // Elie Saab Le Parfum eau de parfum 90ml
	'4973167968710', // Kanebo Sensai Cellular Performance Hydrachange mask 75ml
	'8008277115825', // Kevin Murphy colouring lightener 250g
);

/** Shop managers, and anyone else who runs the shop, may curate the list. */
function sillage_bs_cap(): string {
	return 'manage_woocommerce';
}

/* ------------------------------------------------------------------
 * The list
 * ----------------------------------------------------------------*/

/** The curated list: ordered, unique, digits only. */
function sillage_bs_eans(): array {
	$stored = get_option( SILLAGE_BS_OPTION, SILLAGE_BS_DEFAULT_EANS );
	if ( ! is_array( $stored ) ) {
		return array();
	}
	return sillage_bs_parse( implode( ',', array_map( 'strval', $stored ) ) );
}

/** Split pasted text (commas, spaces, newlines) into clean, unique EANs, in order. */
function sillage_bs_parse( string $raw ): array {
	$eans = array();
	foreach ( preg_split( '/[^0-9]+/', $raw ) ?: array() as $chunk ) {
		$ean = sillage_bs_clean_ean( $chunk );
		if ( '' !== $ean && ! in_array( $ean, $eans, true ) ) {
			$eans[] = $ean;
		}
	}
	return $eans;
}

/** A barcode is 8–14 digits; anything else is discarded rather than stored as a broken row. */
function sillage_bs_clean_ean( $value ): string {
	$ean = preg_replace( '/\D/', '', (string) $value );
	return is_string( $ean ) && strlen( $ean ) >= 8 && strlen( $ean ) <= 14 ? $ean : '';
}

function sillage_bs_save( array $eans ): void {
	update_option( SILLAGE_BS_OPTION, array_values( array_unique( $eans ) ), false );
}

/* ------------------------------------------------------------------
 * Resolution
 * ----------------------------------------------------------------*/

/**
 * Every product ID a barcode points at, from the Sillage EAN index; WooCommerce's indexed global
 * unique id is the fallback. A BeautyFort product can carry up to 26 EANs, which is why the index
 * is one row per EAN per product.
 */
function sillage_bs_ids_for_ean( string $ean ): array {
	if ( 1 !== preg_match( '/^\d{8,14}$/', $ean ) ) {
		return array();
	}

	global $wpdb;
	if ( defined( 'SILLAGE_DB' ) ) {
		$table = SILLAGE_DB . '.sil_ean_index';
		foreach ( array( $ean, str_pad( $ean, 13, '0', STR_PAD_LEFT ) ) as $candidate ) {
			// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name is a constant.
			$ids = $wpdb->get_col( $wpdb->prepare( "SELECT wp_post_id FROM {$table} WHERE ean = %s LIMIT 20", $candidate ) );
			if ( ! empty( $ids ) ) {
				return array_map( 'absint', (array) $ids );
			}
		}
	}

	if ( function_exists( 'wc_get_product_id_by_global_unique_id' ) ) {
		foreach ( array_unique( array( $ean, str_pad( $ean, 13, '0', STR_PAD_LEFT ) ) ) as $candidate ) {
			$id = (int) wc_get_product_id_by_global_unique_id( $candidate );
			if ( $id > 0 ) {
				return array( $id );
			}
		}
	}

	return array();
}

/**
 * The product a row shows. A published product with an image wins — that is the only kind the
 * storefront can actually render — otherwise the first match is returned so the editor can say
 * what is wrong with it.
 *
 * State is one of: ok · no-image · unpublished · missing.
 */
function sillage_bs_resolve( string $ean ): array {
	$ids = sillage_bs_ids_for_ean( $ean );
	if ( ! $ids ) {
		return array( 'id' => 0, 'state' => 'missing' );
	}

	$fallback       = 0;
	$fallback_state = 'unpublished';

	foreach ( $ids as $id ) {
		if ( 'product' !== get_post_type( $id ) ) {
			continue;
		}
		$published = 'publish' === get_post_status( $id );

		// The first product of any kind is what the editor falls back to.
		if ( ! $fallback ) {
			$fallback       = $id;
			$fallback_state = $published ? 'no-image' : 'unpublished';
		}

		if ( $published && '' !== trim( (string) get_post_meta( $id, '_external_thumbnail_url', true ) ) ) {
			return array( 'id' => $id, 'state' => 'ok' );
		}

		// A published product is a better fallback than an unpublished one.
		if ( $published && 'unpublished' === $fallback_state ) {
			$fallback       = $id;
			$fallback_state = 'no-image';
		}
	}

	if ( ! $fallback ) {
		return array( 'id' => 0, 'state' => 'missing' );
	}
	return array( 'id' => $fallback, 'state' => $fallback_state );
}

/* ------------------------------------------------------------------
 * The public route
 * ----------------------------------------------------------------*/
add_action(
	'rest_api_init',
	static function () {
		register_rest_route(
			'sillage/v1',
			'/best-sellers',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'permission_callback' => '__return_true',
				'callback'            => 'sillage_bs_endpoint',
			)
		);
	}
);

/**
 * Publish the curated list: the IDs of the published, image-bearing products it resolves to, in
 * the operator's order. No IDs means the storefront falls back to WooCommerce best sellers.
 */
function sillage_bs_endpoint(): WP_REST_Response {
	$ids = array();
	foreach ( sillage_bs_eans() as $ean ) {
		$row = sillage_bs_resolve( $ean );
		if ( 'ok' === $row['state'] && ! in_array( $row['id'], $ids, true ) ) {
			$ids[] = $row['id'];
		}
	}

	$response = rest_ensure_response( array( 'ids' => $ids ) );
	// An edit must show up on the next storefront load, so this must not be cached.
	$response->header( 'Cache-Control', 'no-store' );
	return $response;
}

/* ------------------------------------------------------------------
 * Admin screen
 * ----------------------------------------------------------------*/
add_action(
	'admin_menu',
	static function () {
		add_menu_page(
			__( 'Best sellers', 'storefront-bestsellers' ),
			__( 'Best sellers', 'storefront-bestsellers' ),
			sillage_bs_cap(),
			SILLAGE_BS_SLUG,
			'sillage_bs_render_page',
			'dashicons-star-filled',
			56
		);
	}
);

add_action( 'admin_post_sillage_bs_save', 'sillage_bs_handle_save' );

/**
 * One form per action, one handler. The row buttons submit `action:argument` in a single value so
 * the whole table can live in one form (a form inside a form is invalid HTML).
 */
function sillage_bs_handle_save(): void {
	if ( ! current_user_can( sillage_bs_cap() ) ) {
		wp_die( esc_html__( 'You are not allowed to edit the best sellers.', 'storefront-bestsellers' ), 403 );
	}
	check_admin_referer( 'sillage_bs' );

	$parts  = explode( ':', sanitize_text_field( wp_unslash( $_POST['sillage_action'] ?? '' ) ), 2 );
	$action = $parts[0];
	$arg    = $parts[1] ?? '';

	$eans = sillage_bs_eans();

	switch ( $action ) {
		case 'add':
			$ean = sillage_bs_clean_ean( wp_unslash( $_POST['ean'] ?? '' ) );
			if ( '' !== $ean ) {
				$eans[] = $ean;
			}
			break;

		case 'replace':
			$eans = sillage_bs_parse( wp_unslash( $_POST['eans'] ?? '' ) );
			break;

		case 'remove':
			$ean  = sillage_bs_clean_ean( $arg );
			$eans = array_values(
				array_filter(
					$eans,
					static function ( $row ) use ( $ean ) {
						return $row !== $ean;
					}
				)
			);
			break;

		case 'up':
		case 'down':
			$at = absint( $arg );
			$to = 'up' === $action ? $at - 1 : $at + 1;
			if ( isset( $eans[ $at ], $eans[ $to ] ) ) {
				$carry      = $eans[ $to ];
				$eans[ $to ] = $eans[ $at ];
				$eans[ $at ] = $carry;
			}
			break;

		case 'clear':
			$eans = array();
			break;
	}

	sillage_bs_save( $eans );

	wp_safe_redirect(
		add_query_arg(
			array(
				'page'          => SILLAGE_BS_SLUG,
				'sillage-saved' => count( sillage_bs_eans() ),
			),
			admin_url( 'admin.php' )
		)
	);
	exit;
}

/** Human wording for a resolution state. */
function sillage_bs_state_label( string $state ): string {
	switch ( $state ) {
		case 'ok':
			return __( 'Live on the storefront', 'storefront-bestsellers' );
		case 'no-image':
			return __( 'Published, but has no image — skipped', 'storefront-bestsellers' );
		case 'unpublished':
			return __( 'Not published — skipped', 'storefront-bestsellers' );
		default:
			return __( 'No product with that EAN — skipped', 'storefront-bestsellers' );
	}
}

function sillage_bs_render_page(): void {
	if ( ! current_user_can( sillage_bs_cap() ) ) {
		return;
	}

	$eans    = sillage_bs_eans();
	$saved   = isset( $_GET['sillage-saved'] ) ? absint( $_GET['sillage-saved'] ) : null;
	$action  = admin_url( 'admin-post.php' );
	$nonce   = wp_nonce_field( 'sillage_bs', '_wpnonce', true, false );
	?>
	<div class="wrap">
		<h1><?php esc_html_e( 'Best sellers', 'storefront-bestsellers' ); ?></h1>

		<?php if ( null !== $saved ) : ?>
			<div class="notice notice-success is-dismissible">
				<p>
					<?php
					printf(
						/* translators: %s: number of EANs on the list. */
						esc_html__( 'Saved. %s EANs on the list.', 'storefront-bestsellers' ),
						esc_html( number_format_i18n( $saved ) )
					);
					?>
				</p>
			</div>
		<?php endif; ?>

		<p class="description" style="max-width:780px">
			<?php esc_html_e( 'These products fill the "Bestsellers" row on the home page and the whole of /best-sellers, in the order below. Add a product by its EAN (barcode). The storefront skips anything that is not published or has no image — the status column says which. While the list is empty it shows WooCommerce best sellers instead.', 'storefront-bestsellers' ); ?>
		</p>

		<div style="display:flex;gap:24px;flex-wrap:wrap;align-items:flex-start;margin:18px 0 24px">
			<form method="post" action="<?php echo esc_url( $action ); ?>">
				<input type="hidden" name="action" value="sillage_bs_save" />
				<input type="hidden" name="sillage_action" value="add" />
				<?php echo $nonce; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- nonce field markup. ?>
				<label class="screen-reader-text" for="sillage-bs-ean"><?php esc_html_e( 'EAN', 'storefront-bestsellers' ); ?></label>
				<input type="text" id="sillage-bs-ean" name="ean" class="regular-text" inputmode="numeric" placeholder="<?php esc_attr_e( 'EAN', 'storefront-bestsellers' ); ?>" required />
				<button type="submit" class="button button-primary"><?php esc_html_e( 'Add', 'storefront-bestsellers' ); ?></button>
			</form>

			<form method="post" action="<?php echo esc_url( $action ); ?>" style="flex:1;min-width:320px">
				<input type="hidden" name="action" value="sillage_bs_save" />
				<input type="hidden" name="sillage_action" value="replace" />
				<?php echo $nonce; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- nonce field markup. ?>
				<textarea name="eans" rows="2" class="large-text code" placeholder="8712345678901, 8712345678902, ..."></textarea>
				<p>
					<button type="submit" class="button"><?php esc_html_e( 'Replace the list', 'storefront-bestsellers' ); ?></button>
					<span class="description"><?php esc_html_e( 'Comma separated. This replaces the whole list and sets the order.', 'storefront-bestsellers' ); ?></span>
				</p>
			</form>
		</div>

		<form method="post" action="<?php echo esc_url( $action ); ?>">
			<input type="hidden" name="action" value="sillage_bs_save" />
			<?php echo $nonce; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- nonce field markup. ?>

			<table class="wp-list-table widefat fixed striped" style="max-width:900px">
				<thead>
					<tr>
						<th style="width:90px"><?php esc_html_e( 'Order', 'storefront-bestsellers' ); ?></th>
						<th style="width:170px"><?php esc_html_e( 'EAN', 'storefront-bestsellers' ); ?></th>
						<th><?php esc_html_e( 'Product', 'storefront-bestsellers' ); ?></th>
						<th style="width:130px"><?php esc_html_e( 'Actions', 'storefront-bestsellers' ); ?></th>
					</tr>
				</thead>
				<tbody>
					<?php if ( ! $eans ) : ?>
						<tr>
							<td colspan="4">
								<?php esc_html_e( 'The list is empty. The storefront is showing WooCommerce best sellers.', 'storefront-bestsellers' ); ?>
							</td>
						</tr>
					<?php else : ?>
						<?php
						foreach ( $eans as $at => $ean ) :
							$row   = sillage_bs_resolve( $ean );
							$title = $row['id'] ? get_the_title( $row['id'] ) : '';
							?>
							<tr>
								<td>
									<button type="submit" class="button-link" name="sillage_action" value="<?php echo esc_attr( 'up:' . $at ); ?>" <?php disabled( 0 === $at ); ?> aria-label="<?php esc_attr_e( 'Move up', 'storefront-bestsellers' ); ?>">↑</button>
									<button type="submit" class="button-link" name="sillage_action" value="<?php echo esc_attr( 'down:' . $at ); ?>" <?php disabled( count( $eans ) - 1 === $at ); ?> aria-label="<?php esc_attr_e( 'Move down', 'storefront-bestsellers' ); ?>">↓</button>
									<span class="description"><?php echo esc_html( (string) ( $at + 1 ) ); ?></span>
								</td>
								<td><code><?php echo esc_html( $ean ); ?></code></td>
								<td>
									<?php if ( $row['id'] ) : ?>
										<a href="<?php echo esc_url( (string) get_edit_post_link( $row['id'] ) ); ?>"><?php echo esc_html( '' !== $title ? $title : sprintf( /* translators: %d: product ID. */ __( 'Product #%d', 'storefront-bestsellers' ), $row['id'] ) ); ?></a>
									<?php else : ?>
										<em><?php esc_html_e( 'Nothing found', 'storefront-bestsellers' ); ?></em>
									<?php endif; ?>
									<br />
									<span class="description"><?php echo esc_html( sillage_bs_state_label( $row['state'] ) ); ?></span>
								</td>
								<td>
									<button type="submit" class="button" name="sillage_action" value="<?php echo esc_attr( 'remove:' . $ean ); ?>"><?php esc_html_e( 'Remove', 'storefront-bestsellers' ); ?></button>
								</td>
							</tr>
						<?php endforeach; ?>
					<?php endif; ?>
				</tbody>
			</table>

			<?php if ( $eans ) : ?>
				<p>
					<button type="submit" class="button button-link-delete" name="sillage_action" value="clear" onclick="return confirm('<?php echo esc_js( __( 'Remove every product from the list?', 'storefront-bestsellers' ) ); ?>');"><?php esc_html_e( 'Clear the list', 'storefront-bestsellers' ); ?></button>
				</p>
			<?php endif; ?>
		</form>
	</div>
	<?php
}
