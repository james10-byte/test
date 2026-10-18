# Configuration

All settings are environment variables, read once at startup by `backend/src/config.js`. Invalid values stop the server with a message naming the variable. `.env.example` lists every variable with its default; the Docker installer copies it to `.env` and sets the deployment-specific ones. Keep `.env` out of version control and readable only by root (`chmod 600`).

With `NODE_ENV=production`, `PUBLIC_BASE_URL` is required and must start with `https://`.

## Application

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enforces an https `PUBLIC_BASE_URL`. The VPS installer writes `staging` for installations without a domain. |
| `PORT` | `3000` | Port the server listens on inside its environment. Platforms such as Railway and Render inject their own value. |
| `PUBLIC_BASE_URL` | `http://localhost:3000` | Public address of the service. |
| `TRUST_PROXY` | `false` | Set `true` behind a reverse proxy so rate limits use the client address from `X-Forwarded-For`. Never set it when clients can reach the server directly. |
| `ALLOWED_ORIGINS` | `empty` | Comma-separated frontend origins allowed by CORS. Needed only when the frontend is hosted on another origin. |
| `API_KEY` | `empty` | When set, every endpoint except `/api/health` requires `Authorization: Bearer <key>`. |

## Docker Compose and installer

| Variable | Default | Description |
| --- | --- | --- |
| `DOMAIN` | `empty` | Domain served over HTTPS by the Caddy profile. |
| `BIND_ADDRESS` | `127.0.0.1` | Host address the application port is published on. The installer uses `0.0.0.0` without a domain. |
| `HTTP_PORT` | `3000` | Host port for the application. |
| `DATA_PATH` | `./data` | Host directory mounted at `/data` in the container. |
| `APP_MEMORY` | `4g` | Container memory limit. |
| `APP_CPUS` | `2` | Container CPU limit. |
| `APP_VERSION` | `local` | Tag of the image built by Compose. |

## Storage

| Variable | Default | Description |
| --- | --- | --- |
| `DATA_DIR` | `./data` | Root for the defaults below. |
| `DATABASE_FILE` | `./data/metadata.sqlite` | SQLite metadata file. |
| `ARTIFACT_DIR` | `./data/artifacts` | Generated APKs. |
| `WORKSPACE_DIR` | `./data/workspaces` | Temporary per-build workspaces, deleted after each build and swept after six hours. |
| `ARTIFACT_RETENTION_HOURS` | `72` | Hours a finished build, its record and its APK are kept. Applies to completed, failed and cancelled builds. |
| `MAX_STORAGE_MB_PER_CLIENT` | `500` | APK storage quota per access token. |

## Android build

| Variable | Default | Description |
| --- | --- | --- |
| `ANDROID_HOME` | `empty` | Android SDK directory. Builds fail with a clear message when it is empty. |
| `GRADLE_COMMAND` | `gradle` | Gradle executable. |
| `GRADLE_USER_HOME` | `./data/gradle-home` | Gradle cache, kept between builds. |
| `BUILD_HOME_DIR` | `./data/build-home` | Home directory given to Gradle. |
| `GRADLE_JVM_ARGS` | `-Xmx2g` | JVM arguments for Gradle, passed as `GRADLE_OPTS`. Builds run in the Gradle client process (no forked daemon), so this is also the heap used by the Kotlin compiler. Only letters, digits and `-=:.` and spaces are accepted. |
| `WORKER_CONCURRENCY` | `1` | Builds running at the same time. Plan about 4 GB of memory per concurrent build. |
| `QUEUE_LIMIT` | `20` | Builds allowed to wait. A full queue answers `queue_full`. |
| `BUILD_TIMEOUT_SECONDS` | `900` | A build that runs longer is killed and marked failed. |
| `MAX_ACTIVE_BUILDS_PER_CLIENT` | `3` | Queued or running builds per access token. |

## Uploads

| Variable | Default | Description |
| --- | --- | --- |
| `MAX_UPLOAD_MB` | `50` | Largest upload (ZIP archive). Uploads are held in memory while they are processed. |
| `MAX_EXTRACTED_MB` | `150` | Largest total size of an extracted ZIP. |
| `MAX_ZIP_FILES` | `2000` | Largest number of files in a ZIP. |
| `MAX_ZIP_DEPTH` | `12` | Deepest directory nesting in a ZIP. |
| `MAX_HTML_MB` | `5` | Largest single HTML file. |
| `MAX_IMAGE_MB` | `10` | Largest icon file. |
| `MAX_IMAGE_PIXELS` | `25000000` | Largest icon in pixels, checked before decoding. |

## Rate limits

| Variable | Default | Description |
| --- | --- | --- |
| `RATE_LIMIT_WINDOW_SECONDS` | `60` | Window length. |
| `RATE_LIMIT_MAX` | `120` | Requests per window and client address across the API. Build creation has its own limit of one sixth of this value, at least 5. |
