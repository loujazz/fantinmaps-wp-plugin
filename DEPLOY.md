# FantinMaps – Archivio CAI: Deployment Notes

## Installazione

1. Scarica lo zip da GitHub:
   `https://github.com/loujazz/fantinmaps-wp-plugin/archive/refs/heads/main.zip`
2. Decomprimi e rinomina la cartella in `fantinmaps-cai-archive`
3. Carica via FTP in `wp-content/plugins/` oppure tramite WP Admin → Plugin → Carica
4. Attiva il plugin

---

## Configurazione Google Cloud Console

Per ogni nuovo dominio su cui viene installato il plugin, aggiungere l'URL nelle **Origini JavaScript autorizzate** del Client OAuth:

1. Vai su [console.cloud.google.com](https://console.cloud.google.com)
2. API e servizi → Credenziali → il Client ID OAuth (`154301436895-...`)
3. Modifica → Origini JavaScript autorizzate → Aggiungi URI:
   - `https://testwp.caibo.it` (sito test)
   - `https://caibo.it` (sito produzione)
4. Salva

Il plugin non richiede modifiche al codice per nuovi domini — solo questo passaggio su Google Cloud.

---

## Modifica necessaria per il sito nuovo (caibo.it)

Il sito nuovo usa **FileBird** + **ACF** con campi immagine. Questi plugin modificano il media modal di WordPress in modo che il tab "Archivio CAI" non compaia nel pannello laterale sinistro (dove FileBird prende il controllo).

**Fix da implementare prima del go-live su caibo.it:**
- Spostare il tab "Archivio CAI" dalla sidebar sinistra ai **tab in alto** del modal (accanto a "Carica file" / "Libreria media"), in modo che funzioni con qualsiasi tipo di modal (incluso quello di ACF e con FileBird attivo).
- Questo richiede una modifica in `assets/js/cai-archive.js`: cambiare il punto di aggancio da `menu` a `router` del media frame.

Comunicare a Claude Code di implementare questa modifica quando si è pronti per il deploy su caibo.it.

---

## Plugin presenti sul sito nuovo rilevanti

- **ACF** – usa `wp.media.view.MediaFrame.Select` (diverso dal modal standard degli articoli)
- **FileBird** – occupa il pannello sinistro del media modal con il suo file manager
- **Sugar Calendar** – per la gestione degli eventi (usa ACF per il campo immagine evento)

---

## Costanti nel plugin (fantinmaps-cai-archive.php)

```php
define( 'FCAI_GOOGLE_CLIENT_ID', '154301436895-rhadm2uuc5mj76ngevcvu5qgtgjdmj3n.apps.googleusercontent.com' );
define( 'FCAI_METADATA_SHEET_ID', '1TrVkxJuSFGG232ix-Uus4ELmalFQRc2w' ); // Drive file ID del JSON metadati
define( 'FCAI_ALLOWED_DOMAIN', 'caibo.it' ); // Solo utenti @caibo.it possono accedere
```

Nessuna modifica necessaria a queste costanti per il deploy su caibo.it.
