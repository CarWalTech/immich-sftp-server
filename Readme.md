# Immich File Bridge

Fork of the original Immich SFTP Server project with a full architectural rewrite and significant new features.

**SFTP/WebDAV bridge for Immich**: browse your Immich library like a folder tree and upload/download photos & videos using any standard client.

## What you can do

- Browse albums as nested folders (`/Albums/<album>/...`)
- Browse and recover trashed assets via `/Trash/`
- Browse assets not in any album via `/Unsorted/`
- Upload/download assets via SFTP or WebDAV
- Create, rename, and delete albums by creating, renaming, and deleting folders
- Move assets between albums, Unsorted, and Trash by moving files
- Edit album metadata (description, sharing) by writing `[ALBUM].yaml`
- Edit per-asset XMP metadata by writing the `.xmp` sidecar file next to each asset
- Adjust your per-user settings live by editing `[SETTINGS].json` at the root

## Root structure

```
/
├── Albums/                  ← all your Immich albums
│   └── <AlbumName>/
│       ├── [ALBUM].yaml     ← album metadata (read/write)
│       ├── [IMMICH].html    ← browser shortcut to open album in Immich
│       ├── photo.jpg
│       └── photo.jpg.xmp    ← XMP sidecar (read/write, if sidecars enabled)
├── Unsorted/                ← assets not in any album (read/write)
├── Trash/                   ← trashed assets (read/write)
│   └── [IMMICH].html        ← browser shortcut to Immich trash view
└── [SETTINGS].json          ← your per-user settings (read/write)
```

## Sub-albums (nested folders)

Albums whose names contain the sub-album separator (default `" / "`) are presented as nested folders:

```
Albums/
└── Vacations/
    ├── Italy/
    └── Japan/
```

These map to Immich albums named `Vacations / Italy` and `Vacations / Japan`. Creating a subfolder creates the corresponding album with the joined name. Renaming a subfolder renames all child albums.

The separator is configurable via `SERVER_USERDEFAULTS_ALBUM_SUBFOLDER_PATTERN`.

## Album metadata (`[ALBUM].yaml`)

Each album folder contains a `[ALBUM].yaml` file. Reading it shows:

```yaml
album:
  id: <uuid>
  name: My Album
  description: "Optional description"
  ownerUsername: user@example.com
sharing:
  canEditSharedUsers: true
  sharedUsers:
    - username: friend@example.com
      role: viewer
settings:
  hidden: false        # set true to add #nosync and hide from all clients
links:
  immichWeb: https://...
```

Writing back the file updates the album description, sharing settings, and visibility in Immich.

Add `#nosync` to an album description in Immich (or set `hidden: true` in the YAML) to hide the album from the network storage entirely.

## XMP sidecar files

When `SERVER_USERDEFAULTS_ASSET_ENABLE_SIDECAR_FILES=true` (default), each asset is accompanied by a `.xmp` file. Reading it returns the asset's metadata in XMP/XML format. Writing back a modified `.xmp` syncs metadata changes (rating, description, tags, etc.) back to Immich.

## Per-user settings (`[SETTINGS].json`)

The `[SETTINGS].json` file at the root reflects your user-specific preferences. Edit and save it to apply changes without restarting:

```json
{
  "assetFileNamePattern": "original",
  "assetDownloadSource": "original",
  "assetSidecarsEnabled": true,
  "subAlbumSeperator": " / "
}
```

Settings are stored per user in `/config/prefs/<userId>.json` (or `/config/prefs/<userId>.<viewId>.json` when a login view parameter is used — see Login section).

## Asset filename patterns

| Value | Example filename |
|---|---|
| `original` *(default)* | `IMG_1234` |
| `assetUuid` | `3f2a1b4c-...` |
| `shortUuid` | `img_3f2a1b4c` |
| `date` | `20240101_123456000` |
| `dateUuid` | `20240101_123456000_3f2a1b4c` |
| `original+assetUuid` | `IMG_1234_3f2a1b4c-...` |
| `original+shortUuid` | `IMG_1234_3f2a1b4c` |

## Upload / delete / move behavior

**Upload** (into any album folder or `/Unsorted/`):
- New file → new asset in Immich, added to that album
- Already exists → deduplicated and added to that album
- Previously trashed → restored and added to that album

**Delete**:
- File in an album → if the asset is in other albums, removed from this album only; if only in this album, moved to trash
- File in `/Unsorted/` → permanently deleted
- File in `/Trash/` → permanently deleted
- Album folder → deletes the album in Immich

**Move** (rename/drag across folders):
- Asset → `/Albums/<other>/` — moves asset to that album
- Asset → `/Unsorted/` — removes asset from all albums
- Asset → `/Trash/` — trashes the asset
- Asset from `/Trash/` → album — restores the asset and adds to that album

## Deployment (Docker Compose)

```yaml
services:
  immich-network-storage:
    container_name: immich_network_storage
    image: ghcr.io/demian98/immich-sftp-server:latest
    ports:
      - "22832:22"    # SFTP
      - "19000:1900"  # WebDAV
    environment:
      SERVER_IMMICH_HOST: https://<your-immich-server>
      SERVER_IMMICH_TIMEZONE: UTC
      SERVER_PROTOCOL_ALLOW_SFTP: "true"
      SERVER_PROTOCOL_ALLOW_WEBDAV: "false"
      SERVER_PROTOCOL_PORTS_SFTP: "22"
      SERVER_PROTOCOL_PORTS_WEBDAV: "1900"
      SERVER_PROTOCOL_HOST: "0.0.0.0"
    volumes:
      - ./config:/config
    restart: unless-stopped
```

> **Note:** FTP support has been removed in this fork. Only SFTP and WebDAV are available.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `SERVER_IMMICH_HOST` | *(required)* | Base URL of your Immich server (e.g. `http://immich-server:2283`). |
| `SERVER_IMMICH_TIMEZONE` | `UTC` | Timezone used for asset timestamps. |
| `SERVER_PROTOCOL_HOST` | `0.0.0.0` | Bind address. |
| `SERVER_PROTOCOL_ALLOW_SFTP` | `true` | Enable SFTP. |
| `SERVER_PROTOCOL_ALLOW_WEBDAV` | `false` | Enable WebDAV. |
| `SERVER_PROTOCOL_PORTS_SFTP` | `22` | SFTP listen port. |
| `SERVER_PROTOCOL_PORTS_WEBDAV` | `1900` | WebDAV listen port. |
| `SERVER_OPTION_ENABLE_UPLOAD_VALIDATION` | `true` | Deduplicate uploads using Immich bulk-check before uploading. |
| `SERVER_OPTION_ENABLE_LOCAL_FILES` | `false` | Serve asset content directly from the Immich upload path on disk instead of downloading via API. |
| `SERVER_OPTION_MAX_CONCURRENT_DOWNLOADS` | `6` | Max simultaneous asset downloads from Immich (shared across all connections). |
| `SERVER_OPTION_MAX_CACHE_BUFFER` | `4MB` | Max size of a single asset buffered in RAM. Larger assets are streamed to a tmp file. Supports suffixes: `B`, `KB`, `MB`, `GB`. |
| `SERVER_OPTION_MAX_READ_BATCH_SIZE` | `50` | Directory entries returned per SFTP READDIR reply. |
| `SERVER_USERDEFAULTS_ASSET_FILEPATTERN` | `original` | Asset filename style — see filename patterns table above. |
| `SERVER_USERDEFAULTS_ASSET_DOWNLOAD_SOURCE` | `original` | `original` or `preview` (`thumbnail` accepted as alias). |
| `SERVER_USERDEFAULTS_ASSET_ENABLE_SIDECAR_FILES` | `true` | Show `.xmp` sidecar files next to each asset. |
| `SERVER_USERDEFAULTS_ALBUM_SUBFOLDER_PATTERN` | ` / ` | Separator used to split album names into nested folders. |
| `SERVER_LOGS_DEBUG` | `false` | Enable debug-level logging. |
| `SERVER_LOGS_INFO` | `true` | Enable info-level logging. |
| `SERVER_LOGS_WARN` | `true` | Enable warn-level logging. |
| `SERVER_LOGS_ERROR` | `true` | Enable error-level logging. |
| `SERVER_LOGS_EXPLICIT` | `false` | Enable verbose API request/response logging. |

## Connect / test

**SFTP:**
- Host: your server hostname/IP
- Port: `22832` (or whatever you mapped)
- Login with email/password (your Immich credentials), or API key: username `apikey`, password = your Immich API key

**WebDAV:**
- URL: `http://your-server-hostname:19000`
- Login: same as SFTP

### Login view parameter

You can append `@<value>` to your username at login to select a named settings view. The suffix is stripped from the username before authentication and is used to load an alternate settings file:

| Login username | Authenticated as | Settings file |
|---|---|---|
| `user@example.com` | `user@example.com` | `/config/prefs/<userId>.json` |
| `user@example.com@0` | `user@example.com` | `/config/prefs/<userId>.0.json` |
| `apikey@54` | `apikey` | `/config/prefs/<userId>.54.json` |

This lets you connect multiple clients with different asset filename patterns or download sources without changing global settings.

## Caching

The server uses a multi-level cache to minimise API calls to Immich:

- **Album/asset list cache** — results are re-validated against Immich at most once every 30 seconds. Within that window all connections share the cached result with zero network I/O.
- **Asset buffer cache** — downloaded asset buffers are shared across all connections in an LRU cache (up to 1000 entries). Assets larger than `SERVER_OPTION_MAX_CACHE_BUFFER` are streamed to a per-session tmp file instead.
- **In-flight deduplication** — concurrent requests for the same asset share a single download promise; no asset is fetched twice simultaneously.
- **Persistent cache** — metadata is saved to `/config/cache` so warm data survives server restarts.

## Known limitations

- Renaming files is not supported (Immich `originalFileName` cannot be changed via the API).
- Sub-album folder creation/renaming requires the separator to be present in the name — the separator itself cannot appear in a real album name.
- Moving album folders between parents is not yet supported.
- If an album contains multiple assets with the same filename, some clients may not handle the listing correctly.
