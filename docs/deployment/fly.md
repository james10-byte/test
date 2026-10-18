# Fly.io

Files: `fly.toml` (Dockerfile build, volume at `/data`, health check, 4 GB performance VM).

Not tested. Check Fly.io's current machine sizes and pricing first.

```
fly launch --no-deploy --copy-config --name <unique-app-name>
fly volumes create inconnu_data --size 30 --region fra
fly secrets set PUBLIC_BASE_URL=https://<unique-app-name>.fly.dev
fly deploy
```

Edit `app` in `fly.toml` to your unique name. A Fly volume belongs to one machine, so run exactly one machine. `auto_stop_machines` is off because builds must not be interrupted. Optional secrets: `ALLOWED_ORIGINS`, `API_KEY`.

Resource needs: at least 4 GB of memory and 20 GB of disk. Workers are not separated from the web service.
