<?php
/**
 * Writes the store identity (name and email addresses) from sillage-core into WordPress.
 *
 * sillage-core owns the identity record in sil_settings (identity_*). This class is the only
 * place that copies those values into WordPress, WooCommerce and the Purelymail sender, so an
 * adopted or restored database never keeps the addresses of the box it came from.
 *
 * @package Sillage_Bridge
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

final class Sillage_Identity {

	/** Purelymail plugin option that holds the connections and the default sender. */
	private const PURELYMAIL_OPTION = 'purelymail_smtp_settings';

	/** Fields the record may carry. Anything else in a request is ignored. */
	private const FIELDS = array( 'store_name', 'admin_email', 'sender_email', 'reply_to', 'smtp_username', 'support_email' );

	/**
	 * Read the identity WordPress currently uses, in the same field names as the record.
	 *
	 * @return array<string,string>
	 */
	public static function current(): array {
		$sender = self::active_connection();
		return array(
			'store_name'    => (string) get_option( 'blogname' ),
			'admin_email'   => (string) get_option( 'admin_email' ),
			'sender_email'  => (string) get_option( 'woocommerce_email_from_address' ),
			'reply_to'      => (string) ( $sender['reply_to'] ?? '' ),
			'smtp_username' => (string) ( $sender['username'] ?? '' ),
			'support_email' => (string) get_option( 'woocommerce_stock_email_recipient' ),
			'pos_email'     => (string) get_option( 'woocommerce_pos_store_email' ),
			'sender_name'   => (string) get_option( 'woocommerce_email_from_name' ),
			'purelymail'    => $sender ? 'connected' : 'none',
		);
	}

	/**
	 * Write the identity. Only the fields passed are changed; the Purelymail password is never read
	 * or written here.
	 *
	 * @param array<string,mixed> $identity Record values.
	 * @return array{ok:bool,changed:array<string,array{from:string,to:string}>,warnings:array<int,string>,error?:string}
	 */
	public static function apply( array $identity ): array {
		$clean = array();
		foreach ( self::FIELDS as $field ) {
			if ( isset( $identity[ $field ] ) && is_string( $identity[ $field ] ) ) {
				$clean[ $field ] = trim( wp_strip_all_tags( $identity[ $field ] ) );
			}
		}
		foreach ( array( 'admin_email', 'sender_email', 'reply_to', 'smtp_username', 'support_email' ) as $field ) {
			if ( isset( $clean[ $field ] ) && '' !== $clean[ $field ] && ! is_email( $clean[ $field ] ) ) {
				return array( 'ok' => false, 'changed' => array(), 'warnings' => array(), 'error' => "invalid email for {$field}" );
			}
		}
		if ( isset( $clean['store_name'] ) && '' === $clean['store_name'] ) {
			return array( 'ok' => false, 'changed' => array(), 'warnings' => array(), 'error' => 'store_name is empty' );
		}

		$before  = self::current();
		$changed = array();
		$warn    = array();

		$set_option = static function ( string $option, string $value ) use ( &$changed ): void {
			if ( (string) get_option( $option ) === $value ) {
				return;
			}
			$changed[ $option ] = array( 'from' => (string) get_option( $option ), 'to' => $value );
			update_option( $option, $value );
		};

		if ( isset( $clean['store_name'] ) ) {
			// Site name only. The sender name is owned by the Purelymail sender page.
			$set_option( 'blogname', $clean['store_name'] );
		}
		if ( isset( $clean['admin_email'] ) && '' !== $clean['admin_email'] ) {
			$set_option( 'admin_email', $clean['admin_email'] );
		}
		if ( isset( $clean['sender_email'] ) && '' !== $clean['sender_email'] ) {
			$set_option( 'woocommerce_email_from_address', $clean['sender_email'] );
		}
		if ( isset( $clean['support_email'] ) && '' !== $clean['support_email'] ) {
			$set_option( 'woocommerce_stock_email_recipient', $clean['support_email'] );
			$set_option( 'woocommerce_pos_store_email', $clean['support_email'] );
		}

		// Purelymail default sender. The sender name is not written here; the Purelymail page owns it.
		$pm = get_option( self::PURELYMAIL_OPTION, array() );
		$id = is_array( $pm ) ? ( $pm['active_connection'] ?? '' ) : '';
		if ( is_array( $pm ) && '' !== $id && isset( $pm['connections'][ $id ] ) ) {
			$conn = $pm['connections'][ $id ];
			$want = array(
				'from_email' => $clean['sender_email'] ?? '',
				'reply_to'   => $clean['reply_to'] ?? '',
				'username'   => $clean['smtp_username'] ?? '',
			);
			$dirty = false;
			foreach ( $want as $key => $value ) {
				if ( '' === $value ) {
					continue;
				}
				if ( ( $conn[ $key ] ?? '' ) !== $value ) {
					$changed[ "purelymail.{$key}" ] = array( 'from' => (string) ( $conn[ $key ] ?? '' ), 'to' => $value );
					$conn[ $key ] = $value;
					$dirty        = true;
				}
			}
			if ( $dirty ) {
				$pm['connections'][ $id ] = $conn;
				update_option( self::PURELYMAIL_OPTION, $pm );
			}
		} else {
			$warn[] = 'no default Purelymail sender; sender settings were not written there';
		}

		// Cached option values (alloptions and object cache) must not hide the change.
		wp_cache_flush();

		return array(
			'ok'       => true,
			'changed'  => $changed,
			'warnings' => $warn,
			'before'   => $before,
		);
	}

	/**
	 * The Purelymail connection used for outgoing mail, or null.
	 *
	 * @return array<string,mixed>|null
	 */
	private static function active_connection(): ?array {
		$pm = get_option( self::PURELYMAIL_OPTION, array() );
		if ( ! is_array( $pm ) ) {
			return null;
		}
		$id = $pm['active_connection'] ?? '';
		if ( '' === $id || ! isset( $pm['connections'][ $id ] ) || ! is_array( $pm['connections'][ $id ] ) ) {
			return null;
		}
		return $pm['connections'][ $id ];
	}
}
