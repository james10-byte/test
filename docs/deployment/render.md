# Render

Files: `render.yaml` (web service, Docker runtime, `/api/health` health check, 30 GB persistent disk at `/data`, `autoDeploy: false`).

One user reported deploying this on Render and starting a build that reached the Gradle stage; completion was not confirmed and nothing else is tested. Check Render's current plans before relying on this.

1. Publish the repository, then create a Blueprint from it in the Render dashboard. Render reads `render.yaml`.
2. Enter the values it asks for: `PUBLIC_BASE_URL` (the `https://...onrender.com` or custom address), `ALLOWED_ORIGINS` (empty unless the frontend is hosted elsewhere) and `API_KEY` (optional).
3. Persistent disks are available only on paid web services. The blueprint selects `plan: pro` for 4 GB of memory; change the plan if you need more or can accept less.

Do not rely on Render's ephemeral filesystem for SQLite or APKs: that is why the disk is part of the blueprint. A disk limits the service to a single instance and prevents zero-downtime deploys.

This is a web service only. There is no background worker, because builds run inside the web service process.

Deploy button, once the repository is public at the configured address:

```
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/INCONNU-BOY/INCONNU-BOY-APK-BUILDER)
```

## Lessons from the first deployment

- Pick an instance with at least 4 GB of memory. Smaller instances run the interface but the Gradle build is killed.
- Attach the persistent disk at `/data`, otherwise the database, the APKs and the Gradle cache are lost on every deploy and every first build is slow again.
- The first build downloads many dependencies and can take several minutes.
- Render probes local ports. Older versions of this project produced Gradle log noise (`Unexpected type tag 72`) because of a forked Gradle daemon; the current version runs Gradle in one process.
