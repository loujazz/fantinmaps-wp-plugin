# FantinMaps – Archivio CAI: TODO & Roadmap

## Necessario prima del go-live su caibo.it

- [ ] **Fix FileBird/ACF**: spostare il tab "Archivio CAI" dai tab in alto del modal
  (`router` invece di `menu` in `assets/js/cai-archive.js`) così funziona
  con FileBird attivo e con i campi immagine ACF

---

## Miglioramenti prioritari

- [ ] **Toggle citazione autore**: aggiungere un checkbox nel pannello dettaglio
  per includere o escludere la riga crediti (es. "FantinMaps / CAI – Foto: Luigi Parisi")
  dall'immagine inserita nell'articolo. Default: inclusa (comportamento attuale)

- [ ] **Cache locale del JSON**: salvare i metadati in `localStorage` con TTL
  configurabile (es. 2 ore) per evitare di ricaricare da Drive ad ogni apertura
  del modal

- [ ] **Selezione multipla**: permettere di selezionare più foto e importarle
  tutte con un click, invece di una per volta

---

## Funzionalità nuove

- [ ] **Filtri aggiuntivi**: aggiungere filtri per data e autore nella toolbar,
  oltre agli attuali regione e tag

- [ ] **Indicatore "già importata"**: mostrare un badge sulle foto già presenti
  nella libreria media WP per evitare duplicati

- [ ] **Scrittura metadati ACF**: al momento scrive titolo, alt e caption standard;
  valutare se scrivere anche campi ACF specifici del sito (es. campo "fotografo")
  in modo automatico al momento dell'importazione

---

## Allineamento con l'app FantinMaps

- [ ] Verificare quali dati aggiuntivi espone l'app che il plugin non usa ancora
  (es. difficoltà, percorso GPX associato, categoria) e valutare se mostrarli
  nel pannello dettaglio o scriverli come metadati

- [ ] Sincronizzazione automatica: valutare se notificare l'utente quando il JSON
  su Drive è stato aggiornato (nuove foto aggiunte nell'app)
