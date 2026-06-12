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
		photos      : [],      // parsed from Drive
		filtered    : [],      // after search
		selected    : null,    // { fileId, title, … }
		importing   : false,
		page        : 1,
		perPage     : 30,
		searchQuery : '',
		viewMode    : 'grid',  // 'grid' | 'map'
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
			scope     : 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/userinfo.email',
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

		// Step 1: check the file mimeType to decide how to fetch it
		$.ajax( {
			url     : 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent( SHEET_ID ) + '?fields=id,name,mimeType',
			headers : { Authorization: 'Bearer ' + state.accessToken },
			success : function ( meta ) {
				var mime = meta.mimeType || '';
				if ( mime === 'application/vnd.google-apps.spreadsheet' ) {
					loadFromSheet();
				} else if ( mime === 'application/vnd.google-apps.folder' ) {
					loadFromFolder();
				} else {
					// Raw binary file (JSON, etc.) – download directly
					fetchRawJSON( SHEET_ID );
				}
			},
			error : function ( xhr ) {
				showError( 'Impossibile leggere i metadati del file Drive. Verifica i permessi.' );
			},
		} );
	}

	// Case A: file is a raw JSON binary on Drive
	function fetchRawJSON( fileId ) {
		$.ajax( {
			url     : 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent( fileId ) + '?alt=media',
			headers : { Authorization: 'Bearer ' + state.accessToken },
			success : function ( data ) {
				var items = Array.isArray( data ) ? data : ( data.photos || [] );
				parseAndRender( items );
			},
			error : function ( xhr ) {
				var msg = 'Errore nel download del JSON.';
				try { msg += ' ' + JSON.parse( xhr.responseText ).error.message; } catch(e){}
				showError( msg );
			},
		} );
	}

	// Case B: file is a Google Sheet – use Sheets API to read first sheet
	function loadFromSheet() {
		var url = 'https://sheets.googleapis.com/v4/spreadsheets/' +
			encodeURIComponent( SHEET_ID ) + '/values/A2:K?majorDimension=ROWS';
		$.ajax( {
			url     : url,
			headers : { Authorization: 'Bearer ' + state.accessToken },
			success : function ( data ) {
				var rows = ( data && data.values ) ? data.values : [];
				// Expected columns: A=id B=src C=downloadUrl D=lat E=lon F=regione G=desc H=tags I=uploadedBy J=uploadedAt K=author
				var items = rows.map( function( r ) {
					return {
						id          : r[0] || '',
						src         : r[1] || '',
						downloadUrl : r[2] || '',
						lat         : parseFloat( r[3] ) || null,
						lon         : parseFloat( r[4] ) || null,
						regione     : r[5] || '',
						desc        : r[6] || '',
						tags        : r[7] ? r[7].split( ',' ).map( function(t){ return t.trim(); } ) : [],
						uploadedBy  : r[8] || '',
						uploadedAt  : r[9] || '',
						author      : r[10] || '',
					};
				} );
				parseAndRender( items );
			},
			error : function() { showError( 'Errore lettura Google Sheet.' ); },
		} );
	}

	// Case C: file is a Drive folder – load all JSON files inside it
	function loadFromFolder() {
		var url = 'https://www.googleapis.com/drive/v3/files' +
			'?q=' + encodeURIComponent( '"' + SHEET_ID + '" in parents and mimeType="application/json" and trashed=false' ) +
			'&fields=files(id,name)&pageSize=50';
		$.ajax( {
			url     : url,
			headers : { Authorization: 'Bearer ' + state.accessToken },
			success : function( data ) {
				var files = ( data && data.files ) ? data.files : [];
				if ( ! files.length ) { showError( 'Nessun file JSON trovato nella cartella.' ); return; }
				var allItems = [];
				var done = 0;
				files.forEach( function( f ) {
					$.ajax( {
						url     : 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent( f.id ) + '?alt=media',
						headers : { Authorization: 'Bearer ' + state.accessToken },
						success : function( d ) {
							var arr = Array.isArray( d ) ? d : ( d.photos || [] );
							allItems = allItems.concat( arr );
						},
						complete : function() {
							done++;
							if ( done === files.length ) parseAndRender( allItems );
						},
					} );
				} );
			},
			error : function() { showError( 'Errore lettura cartella Drive.' ); },
		} );
	}

	// Shared parser: convert raw items array → state.photos and render
	function parseAndRender( items ) {
		state.photos = items.map( function ( item, idx ) {
			var title = ( item.desc && item.desc.trim() )
				? item.desc.trim()
				: ( item.regione || '' ) + ( item.tags && item.tags.length ? ' – ' + item.tags[ 0 ] : '' );
			if ( ! title ) title = 'Foto CAI #' + ( idx + 1 );

			var author = item.author || ( item.uploadedBy ? item.uploadedBy.split( '@' )[ 0 ].replace( /\./g, ' ' ) : '' );
			var date   = item.uploadedAt ? item.uploadedAt.substring( 0, 10 ) : '';

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

		if ( ! state.photos.length ) {
			showError( 'Archivio vuoto o formato non riconosciuto.' );
			return;
		}
		state.filtered = state.photos.slice();
		renderGrid();
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
			'<button id="fcai-view-toggle" class="button fcai-view-toggle" title="Passa alla mappa">🗺️ Mappa</button>' +
			'</div>'
		);
		$panel.html( '' ).append( $bar );
		$panel.append( '<div id="fcai-grid-container"></div>' );
		$panel.append( '<div id="fcai-map-container" style="display:none;"></div>' );
		$panel.append( '<div id="fcai-pager" class="fcai-pager"></div>' );
		$panel.append( '<div id="fcai-detail" class="fcai-detail" style="display:none;"></div>' );

		$panel.find( '#fcai-signout-btn' ).on( 'click', function () {
			state.accessToken = null;
			state.userEmail   = null;
			state.photos      = [];
			state.selected    = null;
			mapDestroy();
			renderLoginScreen();
		} );

		$panel.find( '#fcai-search' ).on( 'input', debounce( function () {
			state.searchQuery = $( this ).val().toLowerCase();
			state.page = 1;
			applyFilter();
			if ( state.viewMode === 'map' ) {
				renderMap();
			} else {
				renderGrid();
			}
		}, 300 ) );

		$panel.find( '#fcai-view-toggle' ).on( 'click', function () {
			if ( state.viewMode === 'grid' ) {
				switchToMap();
			} else {
				switchToGrid();
			}
		} );
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

	// Track which groups are expanded { groupKey: true }
	var expandedGroups = {};

	function buildGroups( photos ) {
		var groups = {};
		var order  = [];
		photos.forEach( function ( photo ) {
			var keys = state.groupBy === 'tags'
				? ( photo.tags.length ? photo.tags : [ '(senza tag)' ] )
				: [ photo.location || '(regione sconosciuta)' ];
			keys.forEach( function ( k ) {
				if ( ! groups[ k ] ) { groups[ k ] = []; order.push( k ); }
				groups[ k ].push( photo );
			} );
		} );
		order.sort();
		return { groups: groups, order: order };
	}

	function renderGrid() {
		var $container = $( '#fcai-grid-container' );
		if ( ! $container.length ) return;

		if ( state.filtered.length === 0 ) {
			$container.html( '<div class="fcai-empty">Nessuna foto trovata.</div>' );
			$( '#fcai-pager' ).html( '' );
			return;
		}

		var result = buildGroups( state.filtered );
		var groups = result.groups;
		var order  = result.order;

		// Render accordion cards
		var html = '<div class="fcai-accordion">';
		order.forEach( function ( key ) {
			var photos    = groups[ key ];
			var isOpen    = !! expandedGroups[ key ];
			var coverIdx  = photos[0].index;
			var coverId   = photos[0].fileId;

			html += '<div class="fcai-card' + ( isOpen ? ' fcai-card-open' : '' ) + '" data-group-key="' + escAttr( key ) + '">' +
				// Card header — always visible
				'<div class="fcai-card-header">' +
				'  <div class="fcai-card-cover">' +
				'    <img class="fcai-thumb-img fcai-thumb-loading" data-file-id="' + escAttr( coverId ) + '" alt="" />' +
				'  </div>' +
				'  <div class="fcai-card-info">' +
				'    <strong class="fcai-card-name">' + escHtml( key ) + '</strong>' +
				'    <span class="fcai-card-count">' + photos.length + ' foto</span>' +
				'  </div>' +
				'  <span class="fcai-card-arrow">' + ( isOpen ? '▲' : '▼' ) + '</span>' +
				'</div>' +
				// Expandable photo grid
				'<div class="fcai-card-body"' + ( isOpen ? '' : ' style="display:none;"' ) + '>' +
				'  <div class="fcai-grid">';

			photos.forEach( function ( photo ) {
				var isSelected = state.selected && state.selected.fileId === photo.fileId ? ' fcai-selected' : '';
				html += '<div class="fcai-thumb' + isSelected + '" data-file-id="' + escAttr( photo.fileId ) + '" data-index="' + photo.index + '">' +
					'<img class="fcai-thumb-img fcai-thumb-loading" data-file-id="' + escAttr( photo.fileId ) + '" alt="' + escAttr( photo.title ) + '" />' +
					'<span class="fcai-thumb-title">' + escHtml( photo.title ) + '</span>' +
					'</div>';
			} );

			html += '  </div></div></div>';
		} );
		html += '</div>';

		$container.html( html );

		// Load cover thumbnails (only card covers initially)
		$container.find( '.fcai-card-cover img' ).each( function () {
			loadThumbAuthenticated( this, $( this ).data( 'file-id' ) );
		} );

		// Toggle card open/close on header click
		$container.off( 'click', '.fcai-card-header' ).on( 'click', '.fcai-card-header', function () {
			var $card = $( this ).closest( '.fcai-card' );
			var key   = $card.data( 'group-key' );
			var isOpen = $card.hasClass( 'fcai-card-open' );

			if ( isOpen ) {
				expandedGroups[ key ] = false;
				$card.removeClass( 'fcai-card-open' );
				$card.find( '.fcai-card-body' ).slideUp( 180 );
				$card.find( '.fcai-card-arrow' ).text( '▼' );
			} else {
				expandedGroups[ key ] = true;
				$card.addClass( 'fcai-card-open' );
				$card.find( '.fcai-card-body' ).slideDown( 200, function () {
					// Load thumbnails for newly visible photos
					$card.find( '.fcai-grid img.fcai-thumb-img' ).each( function () {
						loadThumbAuthenticated( this, $( this ).data( 'file-id' ) );
					} );
				} );
				$card.find( '.fcai-card-arrow' ).text( '▲' );
			}
		} );

		// Select photo on thumbnail click
		$container.off( 'click', '.fcai-thumb' ).on( 'click', '.fcai-thumb', function () {
			var idx   = parseInt( $( this ).data( 'index' ), 10 );
>>>>>>> Stashed changes
			var photo = state.photos[ idx ];
			if ( ! photo ) return;
			state.selected = photo;
			$container.find( '.fcai-thumb' ).removeClass( 'fcai-selected' );
			$( this ).addClass( 'fcai-selected' );
			renderDetail( photo );
		} );

		renderPager();
	}

	// Cache of already-fetched blob URLs (fileId → objectURL) to avoid re-fetching on re-render
	var thumbCache = {};

	function loadThumbAuthenticated( imgEl, fileId ) {
		if ( ! fileId ) return;

		// Serve from cache immediately if available
		if ( thumbCache[ fileId ] ) {
			imgEl.src = thumbCache[ fileId ];
			imgEl.classList.remove( 'fcai-thumb-loading' );
			return;
		}

		// Drive thumbnail URL – requires Authorization header for private files
		var url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent( fileId ) + '?alt=media&mimeType=image/jpeg';
		// Use the smaller thumbnail via the thumbnail service (faster, lower bandwidth)
		var thumbUrl = 'https://drive.google.com/thumbnail?id=' + encodeURIComponent( fileId ) + '&sz=w300';

		window.fetch( thumbUrl, {
			headers : { Authorization: 'Bearer ' + state.accessToken },
		} )
		.then( function ( r ) {
			if ( ! r.ok ) throw new Error( r.status );
			return r.blob();
		} )
		.then( function ( blob ) {
			var objectUrl = URL.createObjectURL( blob );
			thumbCache[ fileId ] = objectUrl;
			imgEl.src = objectUrl;
			imgEl.classList.remove( 'fcai-thumb-loading' );
		} )
		.catch( function () {
			// Fall back to full file download if thumbnail service fails
			window.fetch( url, {
				headers : { Authorization: 'Bearer ' + state.accessToken },
			} )
			.then( function ( r ) {
				if ( ! r.ok ) throw new Error( r.status );
				return r.blob();
			} )
			.then( function ( blob ) {
				var objectUrl = URL.createObjectURL( blob );
				thumbCache[ fileId ] = objectUrl;
				imgEl.src = objectUrl;
				imgEl.classList.remove( 'fcai-thumb-loading' );
			} )
			.catch( function () {
				imgEl.classList.remove( 'fcai-thumb-loading' );
				imgEl.classList.add( 'fcai-thumb-error' );
			} );
		} );
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

		var coordsText = ( photo.lat && photo.lon ) ? photo.lat.toFixed( 5 ) + ', ' + photo.lon.toFixed( 5 ) : '';

		$detail.show().html(
			'<div class="fcai-detail-inner">' +
			'  <div class="fcai-detail-thumb">' +
			'    <img id="fcai-detail-img" class="fcai-thumb-loading" alt="' + escAttr( photo.title ) + '" />' +
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

		// Load preview image authenticated (larger thumbnail for detail panel)
		var detailImg = document.getElementById( 'fcai-detail-img' );
		if ( detailImg ) {
			// Use cached thumb if already loaded; otherwise fetch a larger version
			if ( thumbCache[ photo.fileId ] ) {
				detailImg.src = thumbCache[ photo.fileId ];
				detailImg.classList.remove( 'fcai-thumb-loading' );
			} else {
				loadThumbAuthenticated( detailImg, photo.fileId );
			}
		}

		$detail.find( '#fcai-import-btn' ).on( 'click', function () {
			if ( state.importing ) return;
			importPhoto( photo );
		} );
	}

	/**
	 * After import, insert the new attachment into the current editing context:
	 * - Featured image panel  → sets it as featured image
	 * - Gutenberg block       → inserts image block via block editor store
	 * - Classic editor        → inserts via wp.media.editor.insert()
	 * - Generic media frame   → selects the attachment and closes the modal
	 *
	 * Calls callback( true ) if successfully inserted into the post,
	 * callback( false ) if only added to media library.
	 */
	function insertAttachmentIntoContext( attachmentId, callback ) {
		var attachment = wp.media.attachment( attachmentId );

		attachment.fetch( {
			success: function () {
				var frame   = wp.media.frame;
				var handled = false;

				// ── 1. Featured image context ────────────────────────────────
				if ( frame && frame.options && frame.options.state === 'featured-image' ) {
					var postId = wp.media.view.settings.post && wp.media.view.settings.post.id;
					if ( postId ) {
						wp.media.featuredImage.set( attachmentId );
						// Update the featured image thumbnail in the sidebar
						$( '#set-post-thumbnail' ).find( 'img' ).replaceWith(
							$( '<img>', { src: attachment.get( 'url' ), style: 'max-width:100%' } )
						);
						handled = true;
					}
				}

				// ── 2. Gutenberg block editor ────────────────────────────────
				if ( ! handled && window.wp && wp.data && wp.data.select( 'core/editor' ) ) {
					try {
						var selectedBlock = wp.data.select( 'core/block-editor' ).getSelectedBlock();
						// If a specific image block is selected and empty, replace it
						if ( selectedBlock && selectedBlock.name === 'core/image' && ! selectedBlock.attributes.id ) {
							wp.data.dispatch( 'core/block-editor' ).updateBlockAttributes(
								selectedBlock.clientId,
								{ id: attachmentId, url: attachment.get( 'url' ), alt: attachment.get( 'alt' ) }
							);
						} else {
							// Insert a new image block at the current cursor position
							var block = wp.blocks.createBlock( 'core/image', {
								id  : attachmentId,
								url : attachment.get( 'url' ),
								alt : attachment.get( 'alt' ) || attachment.get( 'title' ),
								caption : attachment.get( 'caption' ) || '',
							} );
							wp.data.dispatch( 'core/block-editor' ).insertBlocks( block );
						}
						handled = true;
					} catch ( e ) {
						// Gutenberg not available or error – fall through
					}
				}

				// ── 3. Classic editor (TinyMCE / wp.media.editor) ────────────
				if ( ! handled && window.wp && wp.media.editor && wp.media.editor.insert ) {
					try {
						var imgHtml = wp.media.string.image( {
							model : attachment,
							size  : 'large',
						} );
						wp.media.editor.insert( imgHtml );
						handled = true;
					} catch ( e ) {
						// Classic editor not available – fall through
					}
				}

				// ── 4. Generic frame: select attachment and close ────────────
				if ( ! handled && frame && frame.state ) {
					try {
						var selection = frame.state().get( 'selection' );
						if ( selection ) {
							selection.reset( [ attachment ] );
							if ( frame.state().get( 'library' ) ) {
								frame.setState( 'insert' );
							}
							handled = true;
						}
					} catch ( e ) {}
				}

				// Close the modal after a short delay so the user sees the status message
				setTimeout( function () {
					if ( frame ) { try { frame.close(); } catch(e){} }
				}, 800 );

				callback( handled );
			},
			error: function () {
				callback( false );
			},
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
				download_url  : photo.downloadUrl || '',
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
				$status.text( '✅ Importata! Inserimento in corso…' );

				insertAttachmentIntoContext( resp.id, function ( inserted ) {
					$status.text( inserted ? '✅ Inserita nell\'articolo!' : '✅ Importata nella libreria media (ID: ' + resp.id + ')' );
				} );
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
	/* Map view (Leaflet + OpenStreetMap)                                   */
	/* ------------------------------------------------------------------ */

	var leafletMap     = null;
	var markerCluster  = null;
	var leafletLoaded  = false;

	function loadLeaflet( callback ) {
		if ( leafletLoaded ) { callback(); return; }

		// Leaflet CSS
		var cssLink  = document.createElement( 'link' );
		cssLink.rel  = 'stylesheet';
		cssLink.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
		document.head.appendChild( cssLink );

		// MarkerCluster CSS
		var cssCluster  = document.createElement( 'link' );
		cssCluster.rel  = 'stylesheet';
		cssCluster.href = 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css';
		document.head.appendChild( cssCluster );

		// Leaflet JS
		var script   = document.createElement( 'script' );
		script.src   = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
		script.onload = function () {
			// MarkerCluster JS
			var scriptCluster   = document.createElement( 'script' );
			scriptCluster.src   = 'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js';
			scriptCluster.onload = function () {
				leafletLoaded = true;
				callback();
			};
			document.head.appendChild( scriptCluster );
		};
		document.head.appendChild( script );
	}

	function switchToMap() {
		state.viewMode = 'map';
		$( '#fcai-view-toggle' ).text( '☰ Griglia' ).attr( 'title', 'Passa alla griglia' );
		$( '#fcai-grid-container' ).hide();
		$( '#fcai-pager' ).hide();
		$( '#fcai-map-container' ).show();
		loadLeaflet( renderMap );
	}

	function switchToGrid() {
		state.viewMode = 'grid';
		$( '#fcai-view-toggle' ).text( '🗺️ Mappa' ).attr( 'title', 'Passa alla mappa' );
		$( '#fcai-map-container' ).hide();
		$( '#fcai-grid-container' ).show();
		$( '#fcai-pager' ).show();
		renderGrid();
	}

	function mapDestroy() {
		if ( leafletMap ) {
			leafletMap.remove();
			leafletMap    = null;
			markerCluster = null;
		}
	}

	function renderMap() {
		var $container = $( '#fcai-map-container' );
		if ( ! $container.length || ! window.L ) return;

		var photos = state.filtered.filter( function ( p ) {
			return p.lat && p.lon;
		} );

		// Init map once
		if ( ! leafletMap ) {
			$container.html( '<div id="fcai-leaflet" class="fcai-leaflet"></div>' );

			leafletMap = L.map( 'fcai-leaflet', { zoomControl: true } );

			L.tileLayer( 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
				attribution : '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
				maxZoom     : 18,
			} ).addTo( leafletMap );

			markerCluster = L.markerClusterGroup( {
				showCoverageOnHover : false,
				maxClusterRadius    : 50,
			} );
			leafletMap.addLayer( markerCluster );
		} else {
			markerCluster.clearLayers();
		}

		if ( ! photos.length ) {
			$container.html( '<div class="fcai-empty">Nessuna foto con coordinate GPS trovata.</div>' );
			return;
		}

		// Build custom camera-icon marker
		var cameraIcon = L.divIcon( {
			className : 'fcai-map-marker',
			html      : '<div class="fcai-marker-pin">📷</div>',
			iconSize  : [ 36, 36 ],
			iconAnchor: [ 18, 36 ],
			popupAnchor: [ 0, -36 ],
		} );

		photos.forEach( function ( photo ) {
			var marker = L.marker( [ photo.lat, photo.lon ], { icon: cameraIcon } );

			// Popup with thumbnail (loaded authenticated) and basic info
			var popupId   = 'fcai-popup-img-' + photo.index;
			var popupHtml =
				'<div class="fcai-popup">' +
				'  <img id="' + popupId + '" class="fcai-popup-thumb fcai-thumb-loading" alt="' + escAttr( photo.title ) + '" />' +
				'  <div class="fcai-popup-title">' + escHtml( photo.title ) + '</div>' +
				'  <div class="fcai-popup-sub">' + escHtml( photo.location ) + ( photo.date ? ' · ' + escHtml( photo.date ) : '' ) + '</div>' +
				'  <button class="button button-primary fcai-popup-select">Seleziona foto</button>' +
				'</div>';

			marker.bindPopup( popupHtml, { minWidth: 200 } );

			marker.on( 'popupopen', function () {
				// Load thumbnail authenticated when popup opens
				var imgEl = document.getElementById( popupId );
				if ( imgEl ) loadThumbAuthenticated( imgEl, photo.fileId );

				// Wire up the "Seleziona" button
				setTimeout( function () {
					var btn = document.querySelector( '.fcai-popup-select' );
					if ( btn ) {
						btn.addEventListener( 'click', function () {
							marker.closePopup();
							state.selected = photo;
							renderDetail( photo );
							// Scroll detail panel into view
							var $detail = $( '#fcai-detail' );
							if ( $detail.length ) {
								$detail[ 0 ].scrollIntoView( { behavior: 'smooth', block: 'start' } );
							}
						} );
					}
				}, 50 );
			} );

			markerCluster.addLayer( marker );
		} );

		// Fit map to show all markers
		var bounds = L.latLngBounds( photos.map( function ( p ) { return [ p.lat, p.lon ]; } ) );
		leafletMap.fitBounds( bounds, { padding: [ 30, 30 ] } );

		// Invalidate size in case the modal resized after init
		setTimeout( function () { if ( leafletMap ) leafletMap.invalidateSize(); }, 200 );
	}

	/* ------------------------------------------------------------------ */
	/* Media modal integration                                              */
	/* ------------------------------------------------------------------ */

	function patchMediaFrame( FrameClass ) {
		var origInit = FrameClass.prototype.initialize;
		FrameClass.prototype.initialize = function () {
			origInit.apply( this, arguments );

			var frame = this;

			// Guard: don't add twice if frame is reused
			if ( frame.states.get( 'cai-archive' ) ) {
				return;
			}

			// WP automatically adds a menu item for every state that has
			// menu:'default' and a title — no manual menu.set() needed.
			frame.states.add( new wp.media.controller.State( {
				id      : 'cai-archive',
				title   : '📷 Archivio CAI',
				menu    : 'default',
				content : 'cai-archive',
				toolbar : 'select',
				router  : false,
			} ) );

			frame.on( 'content:create:cai-archive', function ( content ) {
				var view = new wp.media.View( { controller: frame } );
				view.$el.addClass( 'fcai-content-wrap' ).append( getPanel() );
				content.view = view;
			}, frame );
		};
	}

	patchMediaFrame( wp.media.view.MediaFrame.Post );
	patchMediaFrame( wp.media.view.MediaFrame.Select );

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
