# Deployment overview

INCONNU BOY APK BUILDER runs as one Node.js service that serves the web interface and the API, and runs each Android build as a Gradle child process. Every method below runs the same Docker image built from the same `Dockerfile`.

## Requirements for real builds

| Resource | Minimum | Notes |
| --- | --- | --- |
| CPU architecture | x86_64 | Android's `aapt2` build tool is not published for Linux on ARM. ARM hosts (Ampere, Graviton, Hetzner CAX, Apple silicon Linux VMs) are unsupported and untested. |
| Memory | 4 GB | One concurrent build uses about 1.5 GB for Gradle plus Kotlin compilation. Use 8 GB for `WORKER_CONCURRENCY=2`. |
| Disk | 20 GB free | The image is large because it contains the JDK, Gradle and the Android SDK. Gradle caches and APKs live in `/data`. |
| Network | Outbound HTTPS | Gradle downloads dependencies from Google Maven and Maven Central on the first build. |

## Architecture

Single service. The web server, the bounded build queue and the Gradle workers share one container. There is no separate worker service and no distributed queue in this version, so the "distributed" layout (separate frontend, API, workers and storage) is not available. Only the frontend can be hosted separately (see `frontend-only.md`).

Build isolation provided today: one workspace directory per build, an unprivileged user (uid 10001), a minimal environment for Gradle without application secrets, a process-group kill on cancel or timeout, and container limits on memory, CPU and process count. Gradle needs outbound access, so network egress is not blocked; restrict it at your firewall if your policy requires it.

Storage is the local filesystem under `/data` (SQLite metadata, APKs, Gradle cache). S3-compatible object storage is not implemented.

## Status of each target

| Target | Files | Verified |
| --- | --- | --- |
| Linux VPS (Ubuntu 20.04, 22.04, 24.04, Debian 11, 12) | `install.sh`, `scripts/` | Scripts exercised against a stubbed Docker in automated tests. Never run against a real Docker daemon or a real VPS. |
| Docker Compose | `docker-compose.yml`, `Dockerfile`, `Caddyfile` | YAML structure checked. Image never built here. |
| Railway | `railway.json` | Syntax only. |
| Render | `render.yaml` | YAML structure checked. One user reported a deployment whose build reached the Gradle stage; completion not confirmed. |
| Fly.io | `fly.toml` | TOML structure only. |
| Vercel, Netlify (frontend only) | `vercel.json`, `netlify.toml` | Config writer script tested. Never deployed. |
| DigitalOcean, Hetzner, Oracle Cloud, AWS, Google Cloud, Azure | Guides in this folder | Not tested. They reuse the VPS installer on an x86_64 virtual machine. |

Platform limits, plan names and prices change. Check the provider's current documentation before relying on a guide.

## Choosing

If you control a server, use the VPS installer: it handles Docker, HTTPS, backups and updates. Use a managed platform only if it offers a persistent volume and at least 4 GB of memory for the service.
