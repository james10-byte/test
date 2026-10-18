# Security policy

## Supported versions

Only the latest 0.1.x release receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting on the repository: https://github.com/INCONNU-BOY/INCONNU-BOY-APK-BUILDER/security/advisories/new (available once the repository is published and the feature is enabled).

Include the affected version or commit, the steps to reproduce, the impact you expect and, if you have one, a suggested fix. Do not include real credentials or data from other people.

Reports are handled on a best-effort basis by volunteers. No response time is guaranteed. Please allow time for a fix before disclosing details.

## Scope

In scope: the web interface, the REST API, upload and URL handling, the build pipeline, the Android template, the Docker setup and the installer scripts. Out of scope: vulnerabilities in third-party software that are already public and fixed upstream, denial of service by sheer traffic volume, and issues that require an already compromised server.

## Hardening

The security model, what is protected and the known limits are described in `docs/security.md`. Deployment recommendations are in `docs/deployment/`.
