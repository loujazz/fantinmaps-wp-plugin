<?php
/**
 * Plugin Name: FantinMaps – Archivio CAI
 * Plugin URI:  https://caibo.it
 * Description: Aggiunge un tab "Archivio CAI" nel media browser di WordPress per sfogliare e importare foto FantinMaps con crediti precompilati.
 * Version:     1.0.0
 * Author:      CAI / FantinMaps
 * License:     GPL-2.0+
 * Text Domain: fantinmaps-cai
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'FCAI_VERSION',     '1.0.0' );
define( 'FCAI_PLUGIN_DIR',  plugin_dir_path( __FILE__ ) );
define( 'FCAI_PLUGIN_URL',  plugin_dir_url( __FILE__ ) );

// Google OAuth client ID (authorized for caibo.it and luigiparisi.com)
define( 'FCAI_GOOGLE_CLIENT_ID', '154301436895-rhadm2uuc5mj76ngevcvu5qgtgjdmj3n.apps.googleusercontent.com' );

// Google Drive file ID containing FantinMaps photo metadata (Google Sheet)
define( 'FCAI_METADATA_SHEET_ID', '1TrVkxJuSFGG232ix-Uus4ELmalFQRc2w' );

// Only users whose Google account belongs to this domain may use the archive
define( 'FCAI_ALLOWED_DOMAIN', 'caibo.it' );

require_once FCAI_PLUGIN_DIR . 'includes/class-ajax-handler.php';

/**
 * Enqueue assets only on pages that load the WP media modal.
 */
function fcai_enqueue_assets() {
	// Load on any admin page that may use the media modal
	$screen = get_current_screen();
	if ( ! $screen ) {
		return;
	}

	// Only enqueue where wp-media is needed
	wp_enqueue_media();

	wp_enqueue_style(
		'fcai-cai-archive',
		FCAI_PLUGIN_URL . 'assets/css/cai-archive.css',
		[],
		FCAI_VERSION
	);

	wp_enqueue_script(
		'fcai-cai-archive',
		FCAI_PLUGIN_URL . 'assets/js/cai-archive.js',
		[ 'jquery', 'media-views' ],
		FCAI_VERSION,
		true
	);

	wp_localize_script( 'fcai-cai-archive', 'fcaiSettings', [
		'googleClientId'   => FCAI_GOOGLE_CLIENT_ID,
		'metadataSheetId'  => FCAI_METADATA_SHEET_ID,
		'allowedDomain'    => FCAI_ALLOWED_DOMAIN,
		'ajaxUrl'          => admin_url( 'admin-ajax.php' ),
		'restUrl'          => rest_url( 'fantinmaps-cai/v1/' ),
		'nonce'            => wp_create_nonce( 'fcai_import' ),
		'restNonce'        => wp_create_nonce( 'wp_rest' ),
	] );
}
add_action( 'admin_enqueue_scripts', 'fcai_enqueue_assets' );

/**
 * Register REST API routes.
 */
function fcai_register_rest_routes() {
	register_rest_route( 'fantinmaps-cai/v1', '/import', [
		'methods'             => 'POST',
		'callback'            => [ 'FCAI_Ajax_Handler', 'rest_import_photo' ],
		'permission_callback' => function () {
			return current_user_can( 'upload_files' );
		},
		'args' => [
			'drive_file_id' => [
				'required'          => true,
				'sanitize_callback' => 'sanitize_text_field',
			],
			'download_url' => [
				'required'          => false,
				'sanitize_callback' => 'esc_url_raw',
			],
			'access_token' => [
				'required'          => true,
				'sanitize_callback' => 'sanitize_text_field',
			],
			'title' => [
				'required'          => false,
				'sanitize_callback' => 'sanitize_text_field',
			],
			'caption' => [
				'required'          => false,
				'sanitize_callback' => 'sanitize_textarea_field',
			],
			'alt_text' => [
				'required'          => false,
				'sanitize_callback' => 'sanitize_text_field',
			],
			'filename' => [
				'required'          => false,
				'sanitize_callback' => 'sanitize_file_name',
			],
		],
	] );
}
add_action( 'rest_api_init', 'fcai_register_rest_routes' );
