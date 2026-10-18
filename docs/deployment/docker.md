# Docker Compose on any Linux server

Use this when you manage Docker yourself.

```
git clone https://github.com/INCONNU-BOY/INCONNU-BOY-APK-BUILDER.git
cd INCONNU-BOY-APK-BUILDER
cp .env.example .env
mkdir -p data && sudo chown -R 10001:10001 data
docker compose build
docker compose up -d
```

Set in `.env`: `NODE_ENV=production`, `PUBLIC_BASE_URL=https://your.domain`, `TRUST_PROXY=true` behind a proxy, and `ALLOWED_ORIGINS` if a separate frontend is used. `NODE_ENV=production` refuses a base URL that is not https.

## HTTPS

Set `DOMAIN` in `.env` and start with the `https` profile. Caddy requests certificates automatically.

```
docker compose --profile https up -d
```

Behind your own reverse proxy, keep `BIND_ADDRESS=127.0.0.1`, proxy to `127.0.0.1:3000`, disable response buffering for `/api/builds/*/events` (Server-Sent Events) and allow request bodies up to `MAX_UPLOAD_MB`.

## Build arguments

`docker build --build-arg GRADLE_SHA256=<sha> --build-arg CMDLINE_TOOLS_SHA256=<sha> .` makes the toolchain download fail unless the checksums match. Without them the build prints the computed checksums so you can pin them. Obtain the expected values from Gradle's and Google's download pages.

## Persistent data

`DATA_PATH` (default `./data`) is mounted at `/data` and holds `metadata.sqlite`, `artifacts/`, `workspaces/` and the Gradle cache. Back it up with `scripts/backup.sh` rather than copying files from a running service.

## Hardening already applied

Non-root user, all Linux capabilities dropped, `no-new-privileges`, memory, CPU and process limits, no Docker socket. Gradle can still reach the internet.
