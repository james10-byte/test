# Changelog

## 0.1.0 (unreleased)

### Fixed after the first Render deployment

- Gradle no longer forks a single-use daemon (JVM settings moved to `GRADLE_OPTS`, `org.gradle.jvmargs` and `file.encoding` removed from the template, Kotlin compiles in-process). This removes the local port that produced thousands of "Unexpected type tag 72" stack traces on Render and filled the build log.
- Any remaining occurrences of that message are collapsed into one notice and a final count.
- `GRADLE_JVM_ARGS` now defaults to `-Xmx2g` because the build and the Kotlin compiler share one JVM. Untested on a real build.

### Fixed after the first GitHub Actions run

- ShellCheck SC2034: `ASSUME_YES` is exported in `update.sh`, `restore.sh` and `uninstall.sh`.
- Security: bumped express to 4.22.3, multer to 2.4.0 and sharp to 0.35.5 after `npm audit` reported high and moderate advisories against the first pinned versions. Compatibility with these versions has not been tested here.
- CI: the Android job no longer uses `android-actions/setup-android` (it failed on the runner) and uses the preinstalled SDK instead.
- Tests no longer assume root, fixed sleeps or preserved executable bits, and `npm test` prints a failure summary. Three failing tests from that run remain unidentified.
- The installer no longer aborts if `hostname -I` fails.

First version. Everything below is implemented and covered by automated tests, except where marked.

### Added

- Backend: configuration validation, SQLite metadata with a build state machine and logs, bounded build queue with cancellation and timeout, retention cleanup, REST API with Server-Sent Events (written, not executed because dependencies could not be installed).
- Safe ZIP reader, HTML ingestion, entry-point detection, packaging warnings, SSRF-protected URL validation with redirect revalidation and address pinning.
- Smart Icon Generator: legacy, round, adaptive and monochrome launcher resources, previews, settings validation.
- Kotlin Android template using WebView and WebViewAssetLoader, build configuration validation, Gradle runner, APK validation, build runner.
- Frontend in English, French and Portuguese with dashboard, studio, live build monitor, history, settings, documentation and about pages.
- Dockerfile, Docker Compose with an HTTPS profile, one-command VPS installer, update, doctor, backup, restore, set-domain and uninstall scripts.
- Configurations for Railway, Render, Fly.io, Vercel and Netlify; deployment guides for ten targets; GitHub Actions workflows.

### Not verified

- No real Gradle build, no real APK, no installation on a device.
- No Docker image build, no run of the installer on a real server, no deployment to any platform, no passing GitHub Actions run.
- Express, Multer, Zod, Pino and express-rate-limit code was never executed.

### Not implemented

- Release signing, S3-compatible object storage, separate worker services, ARM build hosts.
