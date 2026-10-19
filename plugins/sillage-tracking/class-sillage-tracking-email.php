<?php
/**
 * The "your parcel has shipped" email.
 *
 * WooCommerce has no template for a tracking number, so this is a small `WC_Email` subclass rather
 * than a template file: the shop's parcel data is a short list, and building it here keeps the
 * markup next to the fields it prints. It still appears under WooCommerce > Settings > Emails, so
 * the subject, the heading and the on/off switch are editable there like any other email.
 *
 * @package Sillage_Tracking
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

if ( ! class_exists( 'WC_Email' ) ) {
	return;
}

/**
 * Sends the tracking number (and the carrier's link, when there is one) to the customer.
 */
class Sillage_Tracking_Email extends WC_Email {

	/**
	 * Parcels to print for the current send.
	 *
	 * @var array<int, array<string, mixed>>
	 */
	private $parcels = array();

	/**
	 * The customer note that triggered this send, so only its parcel is printed.
	 *
	 * @var string
	 */
	private $note = '';

	/**
	 * Set the email's identity, defaults and placeholders.
	 */
	public function __construct() {
		$this->id             = 'sillage_tracking';
		$this->customer_email = true;
		$this->enabled        = 'yes';
		$this->title          = __( 'Parcel shipped (tracking)', 'sillage-tracking' );
		$this->description    = __( 'Sent to the customer when a supplier gives us a tracking number for their parcel. Replaces WooCommerce\'s generic "note to customer" for that note.', 'sillage-tracking' );
		$this->template_html  = '';
		$this->template_plain = '';

		$this->subject = __( 'Your order {order_number} has shipped', 'sillage-tracking' );
		$this->heading = __( 'Your parcel is on its way', 'sillage-tracking' );

		$this->placeholders = array(
			'{order_number}' => '',
			'{order_date}'   => '',
		);

		parent::__construct();
	}

	/**
	 * Send the email for an order.
	 *
	 * @param WC_Order|int $order Order to report on.
	 * @param string       $note  The customer note that triggered the send, when there was one.
	 */
	public function trigger( $order, $note = '' ) {
		$this->setup_locale();
		$this->note = (string) $note;

		if ( ! $order instanceof WC_Order ) {
			$order = wc_get_order( $order );
		}

		if ( $order instanceof WC_Order ) {
			$this->object    = $order;
			$this->recipient = $order->get_billing_email();
			$this->parcels   = $this->parcels_for_note( sillage_tracking_parcels( $order ) );

			$this->placeholders['{order_number}'] = $order->get_order_number();
			$this->placeholders['{order_date}']   = $order->get_date_created()
				? wc_format_datetime( $order->get_date_created() )
				: '';
		}

		// WooCommerce 10.9 added `send_notification()`, which also reports the outcome to the
		// email log and to `woocommerce_email_disabled` / `woocommerce_email_skipped`. The
		// manual send below keeps the plugin working on an older WooCommerce.
		if ( method_exists( $this, 'send_notification' ) ) {
			$this->send_notification();
		} elseif ( $this->is_enabled() && $this->get_recipient() ) {
			$this->send( $this->get_recipient(), $this->get_subject(), $this->get_content(), $this->get_headers(), $this->get_attachments() );
		}

		$this->restore_locale();
	}

	/**
	 * Narrow the parcel list to the one the triggering note names.
	 *
	 * A mixed order ships from both warehouses and each parcel gets its own note, so a later note
	 * must not re-announce an earlier parcel. The note carries the tracking code verbatim, so the
	 * codes we already hold are the match. When no note was passed (a direct trigger) nothing is
	 * dropped.
	 *
	 * @param array<int, array<string, mixed>> $parcels Every parcel on the order.
	 * @return array<int, array<string, mixed>>
	 */
	private function parcels_for_note( array $parcels ): array {
		if ( '' === trim( $this->note ) ) {
			return $parcels;
		}

		$matched = array();
		foreach ( $parcels as $parcel ) {
			$code = (string) $parcel['code'];
			if ( '' !== $code && false !== strpos( $this->note, $code ) ) {
				$matched[] = $parcel;
			}
		}

		return $matched ? $matched : $parcels;
	}

	/**
	 * The email body, in HTML.
	 *
	 * @return string
	 */
	public function get_content_html() {
		ob_start();
		do_action( 'woocommerce_email_header', $this->get_heading(), $this );

		echo wp_kses_post( $this->intro_html() );
		echo $this->parcels_html(); // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped -- Built from escaped values below.
		echo wp_kses_post( $this->outro_html() );

		do_action( 'woocommerce_email_footer', $this );

		return ob_get_clean();
	}

	/**
	 * The email body, in plain text.
	 *
	 * @return string
	 */
	public function get_content_plain() {
		$lines = array( $this->get_heading(), '' );

		foreach ( $this->parcels as $parcel ) {
			$courier   = (string) $parcel['courier'];
			$code      = (string) $parcel['code'];
			$url       = (string) $parcel['url'];
			$warehouse = sillage_tracking_warehouse_name( (string) ( $parcel['location'] ?? '' ) );

			if ( '' !== $warehouse ) {
				$lines[] = $warehouse;
			}
			if ( '' !== $courier ) {
				$lines[] = $courier;
			}
			/* translators: %s: tracking number. */
			$lines[] = sprintf( __( 'Tracking number: %s', 'sillage-tracking' ), $code );
			if ( '' !== $url ) {
				$lines[] = $url;
			}
			$lines[] = '';
		}

		/* translators: %s: order number. */
		$lines[] = sprintf( __( 'Order %s', 'sillage-tracking' ), (string) $this->object->get_order_number() );
		$lines[] = '';
		/* translators: %s: tracking page address. */
		$lines[] = sprintf( __( 'Track your parcels any time: %s', 'sillage-tracking' ), home_url( '/order-tracking' ) );

		return implode( "\n", $lines );
	}

	/**
	 * The opening paragraph.
	 *
	 * @return string
	 */
	private function intro_html(): string {
		if ( 1 === count( $this->parcels ) ) {
			return '<p>' . esc_html__( 'Good news: we have a tracking number for your parcel, so you can follow its progress.', 'sillage-tracking' ) . '</p>';
		}

		return '<p>' . esc_html__( 'Good news: we have tracking numbers for your parcels, so you can follow their progress.', 'sillage-tracking' ) . '</p>';
	}

	/**
	 * One card per parcel: carrier, tracking number and, when the supplier gave us one, the link.
	 *
	 * @return string
	 */
	private function parcels_html(): string {
		$out = '';

		foreach ( $this->parcels as $parcel ) {
			$courier   = (string) $parcel['courier'];
			$code      = (string) $parcel['code'];
			$url       = (string) $parcel['url'];
			$warehouse = sillage_tracking_warehouse_name( (string) ( $parcel['location'] ?? '' ) );

			if ( '' === $code ) {
				continue;
			}

			$out .= '<table cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:0 0 16px;border:1px solid #e5e0da;border-radius:6px;">';
			$out .= '<tr><td style="padding:14px 16px;font-family:Helvetica,Roboto,Arial,sans-serif;font-size:14px;line-height:1.6;color:#2f2a26;">';

			if ( '' !== $warehouse ) {
				$out .= '<p style="margin:0 0 6px;font-size:11px;font-weight:bold;letter-spacing:0.08em;text-transform:uppercase;color:#8a6d3b;">' . esc_html( $warehouse ) . '</p>';
			}

			if ( '' !== $courier ) {
				$out .= '<p style="margin:0 0 6px;font-weight:bold;">' . esc_html( $courier ) . '</p>';
			}

			$out .= '<p style="margin:0 0 6px;">'
				. esc_html__( 'Tracking number', 'sillage-tracking' ) . ': <strong>' . esc_html( $code ) . '</strong></p>';

			if ( '' !== $url ) {
				$out .= '<p style="margin:0;"><a href="' . esc_url( $url ) . '" style="color:#8a6d3b;">'
					. esc_html__( 'Track this parcel with the carrier', 'sillage-tracking' ) . '</a></p>';
			}

			$out .= '</td></tr></table>';
		}

		return $out;
	}

	/**
	 * The closing paragraph, with a link to the shop's own tracking page.
	 *
	 * @return string
	 */
	private function outro_html(): string {
		$page = esc_url( home_url( '/order-tracking' ) );

		return '<p>'
			. sprintf(
				/* translators: %s: address of the shop's order tracking page. */
				wp_kses_post( __( 'You can follow every parcel at any time on our <a href="%s">order tracking page</a>.', 'sillage-tracking' ) ),
				$page
			)
			. '</p>';
	}

	/**
	 * WooCommerce builds its settings form from these; nothing is editable beyond the defaults.
	 *
	 * @return string
	 */
	public function get_default_subject() {
		return __( 'Your order {order_number} has shipped', 'sillage-tracking' );
	}

	/**
	 * The heading shown when the operator has not overridden it.
	 *
	 * @return string
	 */
	public function get_default_heading() {
		return __( 'Your parcel is on its way', 'sillage-tracking' );
	}
}
