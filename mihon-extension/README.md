# Manga Library Mihon Extension

Personal Mihon/Tachiyomi-style source for the local Manga Library server.

This extension is intended to call the app's custom JSON API:

```text
GET /mihon/health
GET /mihon/catalog?page=0&size=50
GET /mihon/latest?page=0&size=50
GET /mihon/search?q=...
GET /mihon/work/:id
GET /mihon/work/:id/pages
GET /mihon/work/:id/pages/:page/raw
```

Default server URL in the source is:

```text
http://127.0.0.1:17099/mihon
```

For mobile Mihon, change it to the LAN address shown in the desktop app, for example:

```text
http://YOUR_PC_IP:17099/mihon
```

## Build Notes

This folder is a source template, not a full Android build environment.

To build an APK, place `src/all/mangalibrary/MangaLibrary.kt` into a Mihon/Tachiyomi extension build repo such as a private fork of an extensions repository, then add a source module using this package:

```text
eu.kanade.tachiyomi.extension.all.mangalibrary
```

Keep the desktop app running while using the extension.
