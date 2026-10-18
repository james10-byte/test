# Frontend on Vercel or Netlify

Only the static frontend can run on these platforms. The API, the build queue and Gradle need a long-running server with a persistent disk, so host them with the VPS installer or Docker and point the frontend at them.

Not deployed here: the configuration writer is tested, the platform builds are not.

## Steps

1. Run the API on a server with HTTPS, for example `https://api.example.com`.
2. On the API server set `ALLOWED_ORIGINS=https://your-frontend.example.com` in `.env` and restart. Without it browsers block the requests.
3. Create the Vercel or Netlify project from the repository and set the environment variable `API_BASE=https://api.example.com`.
4. The build command in `vercel.json` or `netlify.toml` runs `scripts/write-frontend-config.mjs`, which writes `frontend/config.js` and publishes `frontend/`.

Users can also change the API address in Settings. The API must use HTTPS; browsers block calls from an HTTPS page to HTTP.

## Authentication

Builds are tied to a random access token created in the browser. To keep strangers from using your server, set `API_KEY` on the server; each user then enters it once under Settings, Connection. The key is stored in that browser, so treat it as a shared passphrase and not as per-user authentication.

## Content Security Policy

The provided headers allow `connect-src 'self' https:`. Narrow it to your API origin in `vercel.json` or `netlify.toml` if you want a stricter policy.
