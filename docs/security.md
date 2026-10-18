# Security model

Everything a user sends is untrusted: configuration, files, ZIP archives, images and addresses. This page states what the code does and what it does not.

## Controls in place

| Threat | Control | Tests |
| --- | --- | --- |
| Path traversal, absolute paths, symlinks, duplicate names in ZIPs | In-repository ZIP reader validates every entry before extraction, rejects links, ZIP64, encryption and unsafe names, verifies CRC and declared sizes. | `tests/zipSafe.test.js` |
| ZIP bombs | Limits on archive size, extracted size, entry size, file count, depth and compression ratio; inflation is bounded by the declared size. | `tests/zipSafe.test.js` |
| SSRF through website addresses | Only http(s) on ports 80, 443, 8080, 8443; no credentials; blocked names and loopback, private, link-local, metadata, multicast and mapped IPv6 ranges; DNS results are validated, each redirect is revalidated and the validated address is pinned for the connection (no second lookup). | `tests/urlGuard.test.js` |
| Malicious images | Signature checks, pixel limit before decoding, strict decoding, re-encoding; nothing is renamed. | `tests/iconGenerator.test.js` |
| Injection into the Android build | The application name goes into a generated resource file with escaping. The package id, version, orientation and colors are validated by strict patterns and passed as `-P` arguments to a process started without a shell. Website files are copied to `assets/` and are never executed. Uploaded scripts and build files are never run. | `tests/buildConfig.test.js`, `tests/androidProject.test.js`, `tests/gradleRunner.test.js` |
| Reading other users' builds | Builds belong to the hash of the client token; anyone else gets `not found`. Ids are random but are not the protection. Downloads resolve the artifact path inside the artifact directory. | `tests/database.test.js`, browser tests |
| Secrets leaking into builds or logs | Gradle receives only `PATH`, `JAVA_HOME`, `LANG` and its own directories. Workspace and SDK paths are replaced in logs. Pino redacts authorization and token headers. | `tests/gradleRunner.test.js`, `tests/buildPipeline.test.js` |
| Resource exhaustion | Rate limits, bounded queue, per-token active build and storage limits, build timeout with process-group kill, container memory, CPU and process limits, retention cleanup. | `tests/buildQueue.test.js`, `tests/database.test.js` |
| Cross-site scripting in the interface | All dynamic content is inserted with `textContent`; the served policy is `default-src 'self'`, no inline script or style, no remote connections, no framing. | browser tests, `tests/configs.test.js` |
| Android app hardening | No cleartext traffic, no backup, no file or content access in the WebView, mixed content blocked, no JavaScript bridge, one permission (internet), external links open outside the app. | `tests/androidProject.test.js` |
| Privilege on the host | The container runs as uid 10001 with all capabilities dropped and `no-new-privileges`. The Docker socket is never mounted. | `tests/configs.test.js` |
| Installer and scripts | No download piped into a shell, Docker installed from the official apt repository, secrets in a mode 600 file, confirmation before destructive actions, validation of backup archives. | `tests/deploy.test.js` |

## Limits you should know about

- **The access token is not user authentication.** It separates visitors from each other. Anyone with a token can see its builds. Set `API_KEY`, or put the service behind your own access control, when the server must not be open to everyone.
- **Uploads are buffered in memory** (up to `MAX_UPLOAD_MB` per request) before validation. Many parallel large uploads can exhaust memory; rate limits reduce but do not remove that risk.
- **Gradle needs the internet.** Outbound traffic from the container is not restricted by the platform. Dependencies are downloaded at build time from Google Maven and Maven Central; the Docker build only verifies toolchain checksums when you supply them.
- **Isolation is a container, not a sandbox.** Builds run in the same container as the web service. The generated project comes from a fixed template and contains no user code, but a flaw in Gradle or its plugins would run with the container's privileges.
- **No malware scanning.** The website you package runs inside the application on the user's device with JavaScript enabled. You are responsible for its content.
- **Only debug signing.** Release signing with user-owned keys is not implemented; no keystore handling exists.
- **Rate limits count client addresses.** Behind a proxy without `TRUST_PROXY=true`, all users share one address.
- **Frontend-only deployments** keep the token and an optional API key in the browser's local storage.

## Deployment recommendations

Use HTTPS only (`NODE_ENV=production` enforces an https base URL), keep `.env` at mode 600, set `API_KEY` for private use, set `TRUST_PROXY=true` only behind a proxy you control, restrict the firewall to ports 22, 80 and 443, copy backups off the server, and update regularly with `scripts/update.sh`. Run `npm audit` regularly: the first CI audit reported advisories against the versions pinned when this project was written, and they had to be bumped. Keep dependencies updated and rebuild the image after every update.
