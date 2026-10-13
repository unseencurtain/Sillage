<?php
/**
 * Test-store seed. Idempotent: products are matched by name, zones are rebuilt.
 * All names, prices and shipping amounts are TEST DATA.
 * Run: wp eval-file /seed/seed.php
 */
if ( ! class_exists( 'WooCommerce' ) ) { echo "WooCommerce not active\n"; return; }

// Country sets. BTS = 18 countries, BeautyFort = 8, overlapping (NL BE CZ DE ES IT PL).
// GB is BeautyFort only; AT is BTS only; US is served by neither.
$bts_countries = array( 'AT', 'BE', 'CZ', 'DE', 'DK', 'ES', 'FI', 'FR', 'GR', 'HU', 'IE', 'IT', 'LU', 'NL', 'PL', 'PT', 'SE', 'SK' );
$bf_countries  = array( 'BE', 'CZ', 'DE', 'ES', 'GB', 'IT', 'NL', 'PL' );

$products = array(
	array( 'Test Eau de Parfum A1', 'bts', '49.90' ),
	array( 'Test Body Lotion A2', 'bts', '12.50' ),
	array( 'Test Deodorant A3', 'bts', '8.20' ),
	array( 'Test Eau de Toilette B1', 'beautyfort', '64.00' ),
	array( 'Test Shower Gel B2', 'beautyfort', '9.80' ),
	array( 'Test Hair Mist B3', 'beautyfort', '14.00' ),
);

foreach ( $products as $row ) {
	list( $name, $vendor, $price ) = $row;
	$existing = get_posts( array( 'post_type' => 'product', 'title' => $name, 'post_status' => 'any', 'numberposts' => 1, 'fields' => 'ids' ) );
	if ( $existing ) {
		$id = (int) $existing[0];
	} else {
		$p = new WC_Product_Simple();
		$p->set_name( $name );
		$p->set_status( 'publish' );
		$p->set_catalog_visibility( 'visible' );
		$p->set_regular_price( $price );
		$p->set_manage_stock( true );
		$p->set_stock_quantity( 50 );
		$p->set_stock_status( 'instock' );
		$p->set_sku( strtoupper( sanitize_title( $name ) ) );
		$p->set_description( 'Test product for the two-warehouse checks.' );
		$id = $p->save();
	}
	update_post_meta( $id, '_sillage_vendor', $vendor );
	update_post_meta( $id, '_sillage_ship_countries', wp_json_encode( $vendor === 'bts' ? $bts_countries : $bf_countries ) );
	update_post_meta( $id, '_external_thumbnail_url', 'https://example.com/test/' . sanitize_title( $name ) . '.jpg' );
	echo "product $id $name [$vendor]\n";
}

foreach ( array( 'Fragrance', 'Body Care' ) as $cat ) {
	if ( ! term_exists( $cat, 'product_cat' ) ) { wp_insert_term( $cat, 'product_cat' ); }
}

// Offline gateways only. Orders are created in WooCommerce and never dispatched to any vendor.
update_option( 'woocommerce_cod_settings', array( 'enabled' => 'yes', 'title' => 'Cash on delivery (test)' ) );
update_option( 'woocommerce_bacs_settings', array( 'enabled' => 'yes', 'title' => 'Bank transfer (test)' ) );

// Shipping: one zone covering every served country, flat rate per package. Each warehouse package
// is charged separately, so a mixed cart pays the rate twice. Amount is a TEST value.
foreach ( WC_Shipping_Zones::get_zones() as $z ) {
	$zone = new WC_Shipping_Zone( $z['zone_id'] );
	$zone->delete();
}
$zone = new WC_Shipping_Zone();
$zone->set_zone_name( 'Test delivery (served countries)' );
$zone->set_locations( array_map( fn( $c ) => array( 'type' => 'country', 'code' => $c ), array_values( array_unique( array_merge( $bts_countries, $bf_countries ) ) ) ) );
$zone->save();
$method_id = $zone->add_shipping_method( 'flat_rate' );
update_option( 'woocommerce_flat_rate_' . $method_id . '_settings', array( 'title' => 'Standard delivery (test)', 'tax_status' => 'none', 'cost' => '5.00' ) );
echo "zones: ", count( WC_Shipping_Zones::get_zones() ), "\n";
