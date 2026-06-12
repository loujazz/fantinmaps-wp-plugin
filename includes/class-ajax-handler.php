<?php
/**
 * Handles the REST endpoint that downloads a photo from Google Drive
 * and imports it into the WordPress media library.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class FCAI_Ajax_Handler {

	/**
	 * POST /wp-json/fantinmaps-cai/v1/import
	 *
	 * Expected body (JSON):
	 *   drive_file_id  – Google Drive file ID of the photo
	 *   download_url   – direct download URL from JSON (optional, preferred)
	 *   access_token   – user's OAuth access token (validated on client)
	 *   title          – photo title
	 *   caption        – credits / caption string
	 *   alt_text       – alt text
	 *   filename       – suggested filename (e.g. "foto-123.jpg")
	 *
	 * Returns: { id, url, title } on success, WP_Error on failure.
	 */
	public static function rest_import_photo( WP_REST_Request $request ) {
		$drive_file_id = $request->get_param( 'drive_file_id' );
		$download_url  = $request->get_param( 'download_url' ) ?: '';
		$access_token  = $request->get_param( 'access_token' );
		$title         = $request->get_param( 'title' ) ?: 'Foto FantinMaps';
		$caption       = $request->get_param( 'caption' ) ?: '';
		$alt_text      = $request->get_param( 'alt_text' ) ?: $title;
		$filename      = $request->get_param( 'filename' ) ?: sanitize_file_name( $title . '.jpg' );

		if ( empty( $drive_file_id ) || empty( $access_token ) ) {
			return new WP_Error( 'missing_params', __( 'drive_file_id e access_token sono obbligatori.', 'fantinmaps-cai' ), [ 'status' => 400 ] );
		}

		// Validate access token by fetching Drive file metadata before downloading
		$meta_response = wp_remote_get(
			'https://www.googleapis.com/drive/v3/files/' . rawurlencode( $drive_file_id ) . '?fields=id,name,mimeType,size,imageMediaMetadata(width,height)',
			[
				'headers' => [
					'Authorization' => 'Bearer ' . $access_token,
				],
				'timeout' => 15,
			]
		);

		if ( is_wp_error( $meta_response ) ) {
			return new WP_Error( 'drive_meta_error', $meta_response->get_error_message(), [ 'status' => 502 ] );
		}

		$meta_code = wp_remote_retrieve_response_code( $meta_response );
		if ( $meta_code !== 200 ) {
			$body = json_decode( wp_remote_retrieve_body( $meta_response ), true );
			$msg  = isset( $body['error']['message'] ) ? $body['error']['message'] : 'Errore Drive API';
			return new WP_Error( 'drive_meta_failed', $msg, [ 'status' => $meta_code ] );
		}

		$meta     = json_decode( wp_remote_retrieve_body( $meta_response ), true );
		$mime     = $meta['mimeType'] ?? 'image/jpeg';
		$src_w    = $meta['imageMediaMetadata']['width']  ?? 0;
		$src_h    = $meta['imageMediaMetadata']['height'] ?? 0;
		$src_size = isset( $meta['size'] ) ? (int) $meta['size'] : 0;

		// Only allow images
		if ( ! str_starts_with( $mime, 'image/' ) ) {
			return new WP_Error( 'not_an_image', __( 'Il file non è un\'immagine.', 'fantinmaps-cai' ), [ 'status' => 400 ] );
		}

		// Use Drive suggested name if filename was not provided explicitly
		if ( ! $request->get_param( 'filename' ) && ! empty( $meta['name'] ) ) {
			$filename = sanitize_file_name( $meta['name'] );
		}

		// Always use the Drive API v3 endpoint with Bearer token.
		// The downloadUrl from the JSON (drive.google.com/uc?export=download) is a
		// browser-only URL that does not accept Bearer token auth server-side.
		$fetch_url = 'https://www.googleapis.com/drive/v3/files/' . rawurlencode( $drive_file_id ) . '?alt=media';

		// Download the file content from Drive
		$tmp_file = wp_tempnam( $filename );

		$download_response = wp_remote_get(
			$fetch_url,
			[
				'headers' => [
					'Authorization' => 'Bearer ' . $access_token,
				],
				'timeout'  => 60,
				'stream'   => true,
				'filename' => $tmp_file,
			]
		);

		if ( is_wp_error( $download_response ) ) {
			return new WP_Error( 'drive_download_error', $download_response->get_error_message(), [ 'status' => 502 ] );
		}

		$dl_code = wp_remote_retrieve_response_code( $download_response );
		if ( $dl_code !== 200 ) {
			if ( file_exists( $tmp_file ) ) @unlink( $tmp_file );
			return new WP_Error( 'drive_download_failed', __( 'Download fallito dal Drive. Codice: ', 'fantinmaps-cai' ) . $dl_code, [ 'status' => $dl_code ] );
		}

		if ( ! file_exists( $tmp_file ) || filesize( $tmp_file ) === 0 ) {
			return new WP_Error( 'empty_file', __( 'File scaricato vuoto.', 'fantinmaps-cai' ), [ 'status' => 502 ] );
		}

		// Sideload into WP media library
		require_once ABSPATH . 'wp-admin/includes/image.php';
		require_once ABSPATH . 'wp-admin/includes/file.php';
		require_once ABSPATH . 'wp-admin/includes/media.php';

		$file_array = [
			'name'     => $filename,
			'tmp_name' => $tmp_file,
		];

		$attachment_id = media_handle_sideload( $file_array, 0, $title );

		// media_handle_sideload moves the temp file; clean up only if still present
		if ( file_exists( $tmp_file ) ) {
			@unlink( $tmp_file );
		}

		if ( is_wp_error( $attachment_id ) ) {
			return $attachment_id;
		}

		// Set caption and alt text
		wp_update_post( [
			'ID'           => $attachment_id,
			'post_excerpt' => $caption,
		] );
		update_post_meta( $attachment_id, '_wp_attachment_image_alt', $alt_text );

		// Gather imported file info for diagnostics
		$imp_meta      = wp_get_attachment_metadata( $attachment_id );
		$imp_path      = get_attached_file( $attachment_id );
		$imp_filesize  = ( $imp_path && file_exists( $imp_path ) ) ? filesize( $imp_path ) : 0;

		return rest_ensure_response( [
			'id'                  => $attachment_id,
			'url'                 => wp_get_attachment_url( $attachment_id ),
			'title'              => get_the_title( $attachment_id ),
			'source_dimensions'   => $src_w . 'x' . $src_h,
			'source_filesize'     => $src_size,
			'imported_dimensions' => ( $imp_meta['width'] ?? 0 ) . 'x' . ( $imp_meta['height'] ?? 0 ),
			'imported_filesize'   => $imp_filesize,
		] );
	}

}
