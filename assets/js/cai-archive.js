/**
 * FantinMaps – Archivio CAI
 * Adds an "Archivio CAI" tab to the WordPress media modal.
 *
 * Flow:
 * 1. User opens media modal → tab "Archivio CAI" appears.
 * 2. User signs in with Google (domain caibo.it required).
 * 3. App reads the FantinMaps metadata Google Sheet via Sheets API.
 * 4. Thumbnails are shown in a grid (loaded from Google Drive).
 * 5. User selects a photo → clicks "Importa" → PHP endpoint downloads
 *    the file from Drive and adds it to the WP media library.
 * 6. The newly imported attachment is inserted into the post / returned
 *    to the standard WP media picker callback.
 */

( function ( $, wp, settings ) {
	'use strict';

	if ( ! wp || ! wp.media ) {
		return;
	}

	/* ------------------------------------------------------------------ */
	/* Constants                                                            */
	/* ------------------------------------------------------------------ */

	var SHEET_ID      = settings.metadataSheetId;
	var CLIENT_ID     = settings.googleClientId;
	var ALLOWED_DOMAIN = settings.allowedDomain;

	// JSON schema (from Drive file):
	// { id, src, downloadUrl, lat, lon, regione, desc, tags[], uploadedBy, uploadedAt, author? }

	/* ------------------------------------------------------------------ */
	/* State                                                                */
	/* ------------------------------------------------------------------ */

	var state = {
		accessToken : null,
		userEmail   : null,
		photos      : [],      // parsed from Sheet
		filtered    : [],      // after search
		selected    : null,    // { fileId, title, … }
		importing   : false,
		page        : 1,
		perPage     : 30,
		searchQuery : '',
	};

	/* ------------------------------------------------------------------ */
	/* Google Identity Services bootstrap                                  */
	/* ------------------------------------------------------------------ */

	var tokenClient = null;

	function initGoogleClient() {
		if ( ! window.google || ! google.accounts ) {
			return;
		}
		tokenClient = google.accounts.oauth2.initTokenClient( {
			client_id : CLIENT_ID,
			scope     : 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/userinfo.email',
			callback  : onTokenResponse,
		} );
	}

	function onTokenResponse( tokenResponse ) {
		if ( tokenResponse.error ) {
			showError( 'Autorizzazione negata: ' + tokenResponse.error );
			return;
		}
		state.accessToken = tokenResponse.access_token;
		// Fetch user info to verify domain
		fetchUserInfo();
	}

	function fetchUserInfo() {
		$.ajax( {
			url     : 'https://www.googleapis.com/oauth2/v3/userinfo',
			headers : { Authorization: 'Bearer ' + state.accessToken },
			success : function ( info ) {
				var email = info.email || '';
				var domain = email.split( '@' )[ 1 ] || '';
				if ( domain !== ALLOWED_DOMAIN ) {
					state.accessToken = null;
					showError( 'Accesso consentito solo agli utenti @' + ALLOWED_DOMAIN + '. Email rilevata: ' + email );
					renderLoginScreen();
					return;
				}
				state.userEmail = email;
				renderLoggedIn( email );
				loadMetadataJSON();
			},
			error : function () {
				showError( 'Impossibile verificare l\'identità Google.' );
			},
		} );
	}

	/* ------------------------------------------------------------------ */
	/* Google Drive – JSON metadata file                                   */
	/* ------------------------------------------------------------------ */

	function loadMetadataJSON() {
		renderLoading( 'Caricamento archivio in corso…' );

		// Download the JSON file content via Drive API
		$.ajax( {
			url     : 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent( SHEET_ID ) + '?alt=media',
			headers : { Authorization: 'Bearer ' + state.accessToken },
			success : function ( data ) {
				var items = Array.isArray( data ) ? data : [];
				state.photos = items.map( function ( item, idx ) {
					// Build a display title: prefer desc, fall back to regione + tags
					var title = ( item.desc && item.desc.trim() )
						? item.desc.trim()
						: ( item.regione || '' ) + ( item.tags && item.tags.length ? ' – ' + item.tags[ 0 ] : '' );
					if ( ! title ) title = 'Foto CAI #' + ( idx + 1 );

					// Author: explicit field or extract name from email
					var author = item.author || ( item.uploadedBy ? item.uploadedBy.split( '@' )[ 0 ].replace( '.', ' ' ) : '' );

					// Date: format uploadedAt to YYYY-MM-DD
					var date = item.uploadedAt ? item.uploadedAt.substring( 0, 10 ) : '';

					return {
						index       : idx,
						fileId      : item.id      || '',
						src         : item.src     || '',
						downloadUrl : item.downloadUrl || '',
						title       : title,
						description : item.desc    || '',
						author      : author,
						date        : date,
						location    : item.regione || '',
						lat         : item.lat     || null,
						lon         : item.lon     || null,
						tags        : Array.isArray( item.tags ) ? item.tags : [],
						uploadedBy  : item.uploadedBy || '',
					};
				} ).filter( function ( p ) { return p.fileId; } );

				state.filtered = state.photos.slice();
				renderGrid();
			},
			error : function ( xhr ) {
				var msg = 'Errore durante il caricamento del JSON metadati.';
				try {
					var err = JSON.parse( xhr.responseText );
					if ( err.error && err.error.message ) msg += ' ' + err.error.message;
				} catch ( e ) {}
				showError( msg );
			},
		} );
	}

	/* ------------------------------------------------------------------ */
	/* WP Media modal tab                                                   */
	/* ------------------------------------------------------------------ */

	// We attach the UI into a dedicated <div> injected inside the media modal
	var $panel = null;

	/**
	 * Build the initial panel HTML and return the jQuery element.
	 * Called once when the modal is opened.
	 */
	function buildPanel() {
		$panel = $( '<div>', { id: 'fcai-panel', class: 'fcai-panel' } );
		renderLoginScreen();
		return $panel;
	}

	function getPanel() {
		return $panel || buildPanel();
	}

	/* ------------------------------------------------------------------ */
	/* Render helpers                                                       */
	/* ------------------------------------------------------------------ */

	function renderLoginScreen() {
		if ( ! $panel ) return;
		$panel.html(
			'<div class="fcai-login">' +
			'  <div class="fcai-logo">📷 Archivio CAI – FantinMaps</div>' +
			'  <p>Accedi con il tuo account Google <strong>@' + ALLOWED_DOMAIN + '</strong> per sfogliare l\'archivio fotografico.</p>' +
			'  <button id="fcai-signin-btn" class="button button-primary">Accedi con Google</button>' +
			'  <p class="fcai-hint">Solo gli utenti con dominio <em>' + ALLOWED_DOMAIN + '</em> possono accedere.</p>' +
			'</div>'
		);
		$panel.find( '#fcai-signin-btn' ).on( 'click', function () {
			if ( ! tokenClient ) {
				showError( 'Google Identity Services non ancora caricato. Ricarica la pagina.' );
				return;
			}
			tokenClient.requestAccessToken( { prompt: 'consent' } );
		} );
	}

	function renderLoggedIn( email ) {
		// Top bar with user info; grid content will be injected separately
		var $bar = $( '<div class="fcai-topbar">' +
			'<span class="fcai-user">👤 ' + escHtml( email ) + '</span>' +
			'<button id="fcai-signout-btn" class="button">Esci</button>' +
			'<input id="fcai-search" type="search" placeholder="Cerca per titolo, autore, luogo…" class="fcai-search" />' +
			'</div>'
		);
		$panel.html( '' ).append( $bar );
		$panel.append( '<div id="fcai-grid-container"></div>' );
		$panel.append( '<div id="fcai-pager" class="fcai-pager"></div>' );
		$panel.append( '<div id="fcai-detail" class="fcai-detail" style="display:none;"></div>' );

		$panel.find( '#fcai-signout-btn' ).on( 'click', function () {
			state.accessToken = null;
			state.userEmail   = null;
			state.photos      = [];
			state.selected    = null;
			renderLoginScreen();
		} );

		$panel.find( '#fcai-search' ).on( 'input', debounce( function () {
			state.searchQuery = $( this ).val().toLowerCase();
			state.page = 1;
			applyFilter();
			renderGrid();
		}, 300 ) );
	}

	function renderLoading( msg ) {
		$( '#fcai-grid-container' ).html( '<div class="fcai-loading">' + escHtml( msg ) + '</div>' );
	}

	function showError( msg ) {
		var $err = $( '#fcai-grid-container' );
		if ( ! $err.length && $panel ) {
			$panel.append( '<div id="fcai-grid-container"></div>' );
			$err = $( '#fcai-grid-container' );
		}
		$err.html( '<div class="fcai-error">⚠️ ' + escHtml( msg ) + '</div>' );
	}

	function applyFilter() {
		var q = state.searchQuery;
		if ( ! q ) {
			state.filtered = state.photos.slice();
			return;
		}
		state.filtered = state.photos.filter( function ( p ) {
			return (
				p.title.toLowerCase().indexOf( q ) !== -1 ||
				p.description.toLowerCase().indexOf( q ) !== -1 ||
				p.author.toLowerCase().indexOf( q ) !== -1 ||
				p.location.toLowerCase().indexOf( q ) !== -1 ||
				p.uploadedBy.toLowerCase().indexOf( q ) !== -1 ||
				p.tags.join( ' ' ).toLowerCase().indexOf( q ) !== -1
			);
		} );
	}

	function renderGrid() {
		var $container = $( '#fcai-grid-container' );
		if ( ! $container.length ) return;

		if ( state.filtered.length === 0 ) {
			$container.html( '<div class="fcai-empty">Nessuna foto trovata.</div>' );
			$( '#fcai-pager' ).html( '' );
			return;
		}

		var start  = ( state.page - 1 ) * state.perPage;
		var end    = start + state.perPage;
		var subset = state.filtered.slice( start, end );

		var html = '<div class="fcai-grid">';
		subset.forEach( function ( photo ) {
			// Prefer the src URL from JSON (already a Drive direct link); fall back to thumbnail API
		var thumbUrl = photo.src || ( 'https://drive.google.com/thumbnail?id=' + encodeURIComponent( photo.fileId ) + '&sz=w200' );
			var isSelected = state.selected && state.selected.fileId === photo.fileId ? ' fcai-selected' : '';
			html +=
				'<div class="fcai-thumb' + isSelected + '" data-file-id="' + escAttr( photo.fileId ) + '" data-index="' + photo.index + '">' +
				'  <img src="' + escAttr( thumbUrl ) + '" alt="' + escAttr( photo.title ) + '" loading="lazy" />' +
				'  <span class="fcai-thumb-title">' + escHtml( photo.title ) + '</span>' +
				'</div>';
		} );
		html += '</div>';
		$container.html( html );

		// Click on thumbnail → show detail panel
		$container.find( '.fcai-thumb' ).on( 'click', function () {
			var idx  = parseInt( $( this ).data( 'index' ), 10 );
			var photo = state.photos[ idx ];
			if ( ! photo ) return;
			state.selected = photo;
			$container.find( '.fcai-thumb' ).removeClass( 'fcai-selected' );
			$( this ).addClass( 'fcai-selected' );
			renderDetail( photo );
		} );

		renderPager();
	}

	function renderPager() {
		var total = state.filtered.length;
		var pages = Math.ceil( total / state.perPage );
		var $pager = $( '#fcai-pager' );
		if ( pages <= 1 ) { $pager.html( '' ); return; }

		var html = '<span class="fcai-pager-info">Pagina ' + state.page + ' di ' + pages + ' (' + total + ' foto)</span> ';
		if ( state.page > 1 ) {
			html += '<button class="button fcai-prev">← Precedente</button> ';
		}
		if ( state.page < pages ) {
			html += '<button class="button fcai-next">Successiva →</button>';
		}
		$pager.html( html );

		$pager.find( '.fcai-prev' ).on( 'click', function () {
			state.page--;
			renderGrid();
		} );
		$pager.find( '.fcai-next' ).on( 'click', function () {
			state.page++;
			renderGrid();
		} );
	}

	function renderDetail( photo ) {
		var $detail = $( '#fcai-detail' );
		if ( ! $detail.length ) return;

		var credits = buildCredits( photo );

		var previewSrc = photo.src || ( 'https://drive.google.com/thumbnail?id=' + encodeURIComponent( photo.fileId ) + '&sz=w400' );
		var coordsText = ( photo.lat && photo.lon ) ? photo.lat.toFixed( 5 ) + ', ' + photo.lon.toFixed( 5 ) : '';

		$detail.show().html(
			'<div class="fcai-detail-inner">' +
			'  <div class="fcai-detail-thumb">' +
			'    <img src="' + escAttr( previewSrc ) + '" alt="' + escAttr( photo.title ) + '" />' +
			'  </div>' +
			'  <div class="fcai-detail-meta">' +
			'    <h3>' + escHtml( photo.title ) + '</h3>' +
			'    <table class="fcai-meta-table">' +
			( photo.author      ? '<tr><th>Autore</th><td>'    + escHtml( photo.author )      + '</td></tr>' : '' ) +
			( photo.uploadedBy  ? '<tr><th>Caricato da</th><td>' + escHtml( photo.uploadedBy ) + '</td></tr>' : '' ) +
			( photo.date        ? '<tr><th>Data</th><td>'      + escHtml( photo.date )        + '</td></tr>' : '' ) +
			( photo.location    ? '<tr><th>Regione</th><td>'   + escHtml( photo.location )    + '</td></tr>' : '' ) +
			( photo.description ? '<tr><th>Descrizione</th><td>' + escHtml( photo.description ) + '</td></tr>' : '' ) +
			( coordsText        ? '<tr><th>Coordinate</th><td>' + escHtml( coordsText )        + '</td></tr>' : '' ) +
			( photo.tags.length ? '<tr><th>Tag</th><td>'       + escHtml( photo.tags.join( ', ' ) ) + '</td></tr>' : '' ) +
			'    </table>' +
			'    <div class="fcai-credits-preview">' +
			'      <strong>Crediti precompilati:</strong><br>' +
			'      <em>' + escHtml( credits ) + '</em>' +
			'    </div>' +
			'    <button id="fcai-import-btn" class="button button-primary button-large">⬇ Importa nella libreria media</button>' +
			'    <span id="fcai-import-status"></span>' +
			'  </div>' +
			'</div>'
		);

		$detail.find( '#fcai-import-btn' ).on( 'click', function () {
			if ( state.importing ) return;
			importPhoto( photo );
		} );
	}

	function buildCredits( photo ) {
		var parts = [ 'FantinMaps / CAI' ];
		// Use explicit author, or derive readable name from email
		var credit = photo.author || photo.uploadedBy;
		if ( credit ) parts.push( 'Foto: ' + credit );
		if ( photo.location ) parts.push( photo.location );
		if ( photo.date )     parts.push( photo.date );
		return parts.join( ' – ' );
	}

	/* ------------------------------------------------------------------ */
	/* Import                                                               */
	/* ------------------------------------------------------------------ */

	function importPhoto( photo ) {
		if ( ! state.accessToken ) {
			showError( 'Sessione scaduta. Effettua nuovamente l\'accesso.' );
			return;
		}

		state.importing = true;
		var $btn    = $( '#fcai-import-btn' );
		var $status = $( '#fcai-import-status' );
		$btn.prop( 'disabled', true ).text( '⏳ Importazione…' );
		$status.text( '' );

		var credits  = buildCredits( photo );
		var filename = sanitizeFilename( photo.title || photo.fileId ) + '.jpg';

		$.ajax( {
			url         : settings.restUrl + 'import',
			method      : 'POST',
			contentType : 'application/json',
			data        : JSON.stringify( {
				drive_file_id : photo.fileId,
				access_token  : state.accessToken,
				title         : photo.title,
				caption       : credits,
				alt_text      : photo.title + ( photo.location ? ' – ' + photo.location : '' ),
				filename      : filename,
			} ),
			beforeSend : function ( xhr ) {
				xhr.setRequestHeader( 'X-WP-Nonce', settings.restNonce );
			},
			success : function ( resp ) {
				state.importing = false;
				$btn.prop( 'disabled', false ).text( '⬇ Importa nella libreria media' );
				$status.text( '✅ Importata! (ID: ' + resp.id + ')' );

				// Notify WP media modal of the new attachment so it can be
				// selected immediately (works when the modal is open in "select" mode)
				if ( wp.media.frame && wp.media.frame.state ) {
					var selection = wp.media.frame.state().get( 'selection' );
					if ( selection ) {
						var attachment = wp.media.attachment( resp.id );
						attachment.fetch( { success : function () {
							selection.reset( [ attachment ] );
							wp.media.frame.close();
						} } );
					}
				}
			},
			error : function ( xhr ) {
				state.importing = false;
				$btn.prop( 'disabled', false ).text( '⬇ Importa nella libreria media' );
				var msg = 'Errore durante l\'importazione.';
				try { msg += ' ' + JSON.parse( xhr.responseText ).message; } catch ( e ) {}
				$status.text( '❌ ' + msg );
			},
		} );
	}

	/* ------------------------------------------------------------------ */
	/* Media modal integration                                              */
	/* ------------------------------------------------------------------ */

	// We extend the MediaFrame.Post to inject our custom state.
	var origInit = wp.media.view.MediaFrame.Post.prototype.initialize;
	wp.media.view.MediaFrame.Post.prototype.initialize = function () {
		origInit.apply( this, arguments );
		addCAIState( this );
	};

	// Also cover MediaFrame.Select (used by featured image / custom pickers)
	var origInitSelect = wp.media.view.MediaFrame.Select.prototype.initialize;
	wp.media.view.MediaFrame.Select.prototype.initialize = function () {
		origInitSelect.apply( this, arguments );
		addCAIState( this );
	};

	function addCAIState( frame ) {
		frame.states.add( [
			new wp.media.controller.State( {
				id      : 'cai-archive',
				title   : '📷 Archivio CAI',
				content : 'cai-archive',
				menu    : 'default',
				toolbar : 'select',
				router  : false,
			} ),
		] );

		frame.on( 'content:create:cai-archive', function ( content ) {
			var view = new wp.media.View( { controller: frame } );
			view.el.appendChild( getPanel()[ 0 ] );
			content.view = view;
		}, frame );

		// Add menu item
		frame.on( 'menu:create:default', function ( menu ) {
			menu.set( 'cai-archive', {
				text     : '📷 Archivio CAI',
				priority : 60,
			} );
		} );

		frame.on( 'menu:render:default', function ( view ) {
			view.set( 'cai-archive', {
				text     : '📷 Archivio CAI',
				priority : 60,
			} );
		} );
	}

	/* ------------------------------------------------------------------ */
	/* Bootstrap Google Identity Services after DOM ready                  */
	/* ------------------------------------------------------------------ */

	$( function () {
		// Load the GIS library dynamically
		if ( ! window.google || ! window.google.accounts ) {
			var script   = document.createElement( 'script' );
			script.src   = 'https://accounts.google.com/gsi/client';
			script.async = true;
			script.defer = true;
			script.onload = function () { initGoogleClient(); };
			document.head.appendChild( script );
		} else {
			initGoogleClient();
		}

		// Re-init if GIS was already loaded but tokenClient not yet built
		$( document ).on( 'click', '#fcai-signin-btn', function () {
			if ( ! tokenClient && window.google && window.google.accounts ) {
				initGoogleClient();
			}
		} );
	} );

	/* ------------------------------------------------------------------ */
	/* Utilities                                                            */
	/* ------------------------------------------------------------------ */

	function escHtml( str ) {
		return $( '<div>' ).text( String( str ) ).html();
	}

	function escAttr( str ) {
		return $( '<div>' ).attr( 'data-v', String( str ) ).attr( 'data-v' );
	}

	function sanitizeFilename( str ) {
		return str.replace( /[^a-zA-Z0-9_\-]/g, '_' ).toLowerCase().substring( 0, 60 );
	}

	function debounce( fn, delay ) {
		var timer;
		return function () {
			var ctx = this, args = arguments;
			clearTimeout( timer );
			timer = setTimeout( function () { fn.apply( ctx, args ); }, delay );
		};
	}

}( jQuery, wp, fcaiSettings ) );
