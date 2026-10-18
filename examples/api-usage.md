# API usage examples

Replace `BASE` with your server address and create a token once. Every request except `/api/health` and `/api/icons/preview` needs it, and builds belong to it.

```
BASE=http://localhost:3000
TOKEN=$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')
```

Add `-H "Authorization: Bearer $API_KEY"` to every request when the server sets `API_KEY`.

## Build a ZIP website

```
cd examples/sample-site && zip -r ../sample-site.zip . && cd ..
curl -sS -X POST "$BASE/api/builds" \
  -H "X-Client-Token: $TOKEN" \
  -F "config=<build-config-html.json" \
  -F "source=@sample-site.zip" \
  -F "icon=@/path/to/icon.png"
```

The response is `202` with `{ "build": { "id": "...", "state": "queued", ... } }`. The `icon` field is optional; a default icon is used without it.

## Build a website URL

```
curl -sS -X POST "$BASE/api/builds" \
  -H "X-Client-Token: $TOKEN" \
  -F "config=<build-config-url.json"
```

## Follow, download, delete

```
curl -sS "$BASE/api/builds/$ID" -H "X-Client-Token: $TOKEN"
curl -sN "$BASE/api/builds/$ID/events" -H "X-Client-Token: $TOKEN"
curl -sS -X POST "$BASE/api/builds/$ID/cancel" -H "X-Client-Token: $TOKEN"
curl -sS -OJ "$BASE/api/builds/$ID/download" -H "X-Client-Token: $TOKEN"
curl -sS -X DELETE "$BASE/api/builds/$ID" -H "X-Client-Token: $TOKEN"
```

After downloading, compare `sha256sum` of the file with `build.artifact.sha256` from the build record.

## Preview an icon

```
curl -sS -X POST "$BASE/api/icons/preview" \
  -F "icon=@/path/to/icon.png" \
  -F 'settings={"background":"#0A0D14","padding":0.15,"fit":"contain"}'
```
