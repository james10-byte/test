# Architecture

One Node.js service serves the web interface and the REST API and runs Android builds as child processes. This is the "single VPS" layout. A distributed layout with separate API, workers and shared storage is not implemented.

```
Browser (frontend/)  --HTTPS-->  Express (backend/src/app.js)
                                   |- validation: config, ZIP, HTML, URL, image
                                   |- SQLite metadata (backend/src/db)
                                   |- bounded queue (backend/src/queue)
                                   '- build runner (backend/src/build)
                                         '- Gradle child process in an isolated workspace
                                               '- android-template/ + generated resources + website assets
```

## Layout

The original brief suggested a separate `build-worker/` directory. The worker is the in-process runner in `backend/src/build/`, so no such directory exists.

| Path | Role |
| --- | --- |
| `frontend/` | Static interface without a build step, in English, French and Portuguese. |
| `backend/src/security/` | SSRF guard, safe ZIP reader, path helpers. |
| `backend/src/project/` | HTML and ZIP ingestion, entry-point detection, packaging warnings. |
| `backend/src/icons/` | Smart Icon Generator. |
| `backend/src/android/` | Build configuration validation, project writer, APK validator. |
| `backend/src/build/` | Build service (submission), runner (lifecycle), Gradle process runner. |
| `backend/src/db/` | SQLite access and the build state machine. |
| `backend/src/queue/` | Bounded queue with concurrency, cancellation and timeout. |
| `backend/src/storage/` | Retention and workspace cleanup. |
| `android-template/` | Kotlin WebView application. Per-build values are passed as Gradle `-P` properties and generated resource files, never by editing code. |
| `scripts/`, `install.sh` | Installer and maintenance scripts, helpers for Docker and CI. |

## Build lifecycle

1. `POST /api/builds` validates the configuration, checks quotas, ingests the website or probes the URL, normalizes the icon, writes the workspace, stores the record as `queued` and enqueues it. Any failure removes the record and the workspace.
2. The queue starts the runner when a slot is free. The runner moves the record to `preparing`, generates icon resources, writes the Android project and checks that the SDK is configured.
3. `compiling`: Gradle runs `assembleDebug` with a minimal environment, in its own process group, with output streamed to the log and to event subscribers. Cancellation or the timeout signals the process group, then kills it after five seconds.
4. `validating`: the APK must be a valid archive containing the manifest, `classes.dex` and `resources.arsc`, and a signature. When `aapt2` and `apksigner` exist in the SDK, package name, version code and signature are verified too. The result states which checks ran.
5. The APK is copied to the artifact directory, its SHA-256 is verified after copying, the record becomes `completed` with an expiry, and the workspace is deleted in every outcome.

At startup, builds left active by a crash are marked failed. A cleanup task removes expired records and APKs and stale workspaces.

## Data

SQLite (`node:sqlite`) holds `builds` (configuration, state, error summary, artifact name, size, checksum, timestamps, signing mode, owner hash) and `build_logs`. State transitions run in transactions and are checked against an allowed-transitions table. Retention applies to every finished build.
