# REST API

All endpoints are under `/api`. Bodies are JSON unless stated. Errors always have this shape and never contain paths, stack traces or environment values:

```
{ "error": { "code": "queue_full", "message": "The build queue is full. Please try again later.", "details": null } }
```

## Authentication

- `X-Client-Token`: 32 to 128 characters from `A-Z a-z 0-9 _ -`. Required on every `/api/builds` endpoint. Builds belong to the SHA-256 hash of the token; only the owner can read, cancel, download or delete a build. Other tokens receive `build_not_found`. Treat the token like a password.
- `Authorization: Bearer <key>`: required on every endpoint except `GET /api/health` when the server sets `API_KEY`.

## Endpoints

### GET /api/health

`200 { "status": "ok", "version": "0.1.0", "uptimeSeconds": 12 }`. No authentication.

### GET /api/config

Public limits for clients: `limits` (`maxUploadBytes`, `maxExtractedBytes`, `maxHtmlBytes`, `maxImageBytes`, `maxImagePixels`, `maxZipFiles`, `maxStorageBytesPerClient`, `maxActiveBuildsPerClient`), `queue` (`maxQueued`, `concurrency`), `retentionHours`, `icon` (`legacyDensities`, `adaptiveDensities`), `signingModes`, `authenticationRequired`.

### POST /api/icons/preview

`multipart/form-data` with `icon` (PNG, JPEG or WebP) and optional `settings` (JSON string, see below). Returns `200`:

```
{ "source": { "format": "png", "width": 512, "height": 256, "hasTransparency": true, "orientation": 1 },
  "previews": { "square": "data:image/png;base64,...", "rounded": "...", "round": "...", "adaptive": "...", "transparency": "..." } }
```

The previews are produced by the same code that generates the resources compiled into the APK.

### POST /api/builds

Requires `X-Client-Token`. `multipart/form-data`:

| Field | Required | Description |
| --- | --- | --- |
| `config` | yes | JSON, see below. |
| `source` | for `html` and `zip` | The HTML file or ZIP archive. |
| `icon` | no | Icon image. A default icon is used without it. |

Returns `202` with `Location: /api/builds/<id>` and `{ "build": <build> }`. The configuration, the website and the icon are fully validated before the build is queued; nothing is kept when validation fails.

`config` fields:

| Field | Default | Rules |
| --- | --- | --- |
| `appName` | required | 1 to 30 characters, no control characters. |
| `packageId` | `dev.inconnuboy.apkbuilder` | At least two lowercase segments (`a-z`, digits, `_`), each starting with a letter, no Java keywords, 100 characters at most. |
| `versionName` | `1.0.0` | Up to 30 characters of letters, digits, `.`, `+`, `_`, `-`. |
| `versionCode` | `1` | Integer from 1 to 2100000000. |
| `orientation` | `unspecified` | `unspecified`, `portrait`, `landscape` or `sensor`. |
| `statusBarColor`, `navigationBarColor` | `#0B1020` | `#RRGGBB`. |
| `inputType` | required | `html`, `zip` or `url`. |
| `url` | required for `url` | `https` address, at most 2048 characters. Forbidden for other types. |
| `icon` | `{}` | Icon settings. |
| `signing` | `debug` | Only `debug` is accepted. |

Unknown fields are rejected. Icon settings: `background` (`transparent` or `#RRGGBB`), `adaptiveBackground` (`#RRGGBB`, used when `background` is transparent), `scale` 0.1 to 1, `padding` 0 to 0.4, `offsetX` and `offsetY` -0.5 to 0.5, `fit` (`contain` or `cover`).

### GET /api/builds

Query `limit` (1 to 100, default 20) and `offset`. Returns `{ "builds": [<build>], "stats": { "total", "succeeded", "failed", "active" }, "storageUsedBytes": 0 }` for the caller's token, newest first.

### GET /api/builds/:id

`{ "build": <build> }`.

A build:

```
{ "id": "32 hex characters", "appName": "...", "inputType": "html|zip|url", "state": "...", "stage": "...",
  "errorSummary": null, "signingMode": "debug", "config": { ... , "warnings": [{ "code", "message", "items" }] },
  "artifact": { "size": 123, "sha256": "..." } | null, "queuePosition": 2 | null,
  "createdAt": "...", "updatedAt": "...", "expiresAt": "..." | null }
```

States: `queued`, `preparing`, `compiling`, `validating`, `completed`, `failed`, `cancelled`. Allowed transitions only move forward, or to `failed` or `cancelled` from any active state. No percentage is reported because Gradle does not provide one.

### GET /api/builds/:id/events

Server-Sent Events (`text/event-stream`). Requires the token header, so browsers must read it with `fetch` streaming and not `EventSource`. Events:

| Event | Data |
| --- | --- |
| `state` | the build, sent on connect and on every transition |
| `log` | `{ "line", "at" }`, with `id:` set to the log sequence number |
| `heartbeat` | `{}` every 15 seconds |
| `end` | `{ "state" }`, after which the server closes the stream |

Send `Last-Event-ID` to resume without repeating log lines. Disconnections are detected and their resources released.

### POST /api/builds/:id/cancel

`200 { "build" }` when a queued build was cancelled, `202 { "build", "message" }` when a running build was asked to stop (the `cancelled` state arrives on the event stream), `409 build_finished` when it already ended.

### GET /api/builds/:id/download

Only for `completed` builds that have not expired. Returns the APK with `Content-Type: application/vnd.android.package-archive`, `Content-Disposition: attachment`, `Cache-Control: private, no-store` and `X-Artifact-Sha256`. The file is the stored artifact whose checksum was verified after copying.

### DELETE /api/builds/:id

`204`. Finished builds only; active builds answer `409 build_active`. Deletes the record, its logs and the APK.

## Error codes

| Code | Status | Meaning |
| --- | --- | --- |
| `invalid_config` | 422 | A configuration field is invalid. |
| `unknown_config_field` | 422 | The configuration has an unknown field. |
| `https_required` | 422 | A website application needs an https address. |
| `signing_unsupported` | 422 | Only debug signing is available. |
| `invalid_icon_settings` | 422 | Icon settings are out of range. |
| `missing_source` | 422 | No website file was sent. |
| `missing_icon` | 422 | No icon file was sent to the preview endpoint. |
| `invalid_json` | 422 or 400 | The `config` or `settings` field, or a JSON request body, is not valid JSON. |
| `validation_failed` | 422 | Query or settings failed schema validation; `details` lists the fields. |
| `upload_rejected` | 413 or 400 | The multipart upload exceeded a limit or was malformed. |
| `unauthorized` | 401 | The API key is missing or wrong. |
| `client_token_required` | 401 | The `X-Client-Token` header is missing or malformed. |
| `build_not_found` | 404 | No such build for this token. |
| `not_found` | 404 | Unknown endpoint. |
| `build_finished` | 409 | The build already ended. |
| `build_active` | 409 | Cancel the build before deleting it. |
| `artifact_unavailable` | 409 | The build has no APK. |
| `invalid_transition` | 409 | Internal state change refused. |
| `artifact_expired` | 410 | The retention period passed. |
| `artifact_missing` | 410 | The APK file is gone. |
| `queue_full` | 429 | The queue is full. |
| `too_many_active_builds` | 429 | Too many builds in progress for this token. |
| `rate_limited` | 429 | Rate limit reached. |
| `storage_quota_exceeded` | 413 | The token's storage quota is reached. |
| `internal_error` | 500 | Unexpected error; details are only in the server log. |
| `unsafe_path` | 400 | A path escaped its directory. |
| `html_too_large`, `image_too_large`, `image_too_many_pixels` | 413 | A size limit was exceeded. |
| `empty_html`, `invalid_html`, `invalid_encoding` | 422 | The HTML file is empty, binary or not UTF-8. |
| `unsupported_image` | 415 | Not PNG, JPEG or WebP by content. |
| `invalid_image`, `image_too_small` | 422 | The image is corrupted, undecodable or smaller than 8 pixels. |
| `invalid_zip`, `unsupported_zip`, `encrypted_zip`, `corrupt_entry`, `empty_archive` | 422 | The ZIP is malformed, ZIP64, encrypted, corrupted or empty. |
| `archive_too_large`, `archive_too_large_extracted`, `entry_too_large`, `too_many_files`, `too_deep`, `suspicious_compression_ratio` | 422 | A ZIP limit was exceeded. |
| `path_traversal`, `absolute_path`, `symlink_rejected`, `duplicate_entry`, `conflicting_entries`, `unsupported_compression` | 422 | A ZIP entry is unsafe or ambiguous. |
| `missing_entry_point`, `ambiguous_entry_point` | 422 | No HTML page, or several candidates (`details.candidates`). |
| `invalid_url`, `unsupported_scheme`, `credentials_not_allowed`, `port_not_allowed`, `blocked_host`, `blocked_address`, `dns_failure`, `invalid_redirect`, `too_many_redirects` | 422 | The website address is refused. |
| `connection_failed`, `connection_timeout` | 502, 504 | The website could not be reached. |
| `android_sdk_missing`, `gradle_unavailable`, `gradle_failed`, `workspace_missing` | 500 | Build failures recorded in `errorSummary`. |
| `invalid_apk`, `apk_unsigned`, `apk_metadata_mismatch`, `apk_metadata_unreadable`, `apk_signature_invalid`, `artifact_corrupted` | 500 | The generated APK failed validation. |
