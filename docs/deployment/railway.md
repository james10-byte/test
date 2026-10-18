# Railway

Files: `railway.json` (Dockerfile build, health check `/api/health`, restart on failure).

Not tested. Check Railway's current limits before relying on this.

1. Create a project from the GitHub repository. Railway reads `railway.json` and builds the `Dockerfile`.
2. Add a volume to the service and mount it at `/data`. Without a volume the database and APKs are lost on every deploy.
3. Set variables: `NODE_ENV=production`, `DATA_DIR=/data`, `PUBLIC_BASE_URL=https://<your-service-domain>`, `TRUST_PROXY=true`, `WORKER_CONCURRENCY=1`. Railway provides `PORT`, which the server honors.
4. Give the service at least 4 GB of memory if your plan allows it. Builds fail with out-of-memory errors below that.
5. Generate a public domain in the service settings.

A single Railway service runs the web server and the Gradle workers together. Railway does not provide isolated build workers for this project, so every build shares the service's CPU and memory with the API.

A one-click deploy button requires publishing a Railway template, which has not been done.
