# Linux VPS (one command)

Supported: Ubuntu 20.04, 22.04, 24.04 and Debian 11, 12 on x86_64 with 4 GB of memory and 20 GB of free disk.

## Install

The command below is the deployment target. It works only once the repository is published at that address.

```
curl -fsSL https://raw.githubusercontent.com/INCONNU-BOY/INCONNU-BOY-APK-BUILDER/main/install.sh -o install.sh && sudo bash install.sh
```

Read `install.sh` before running it. Useful options:

| Option | Effect |
| --- | --- |
| `--domain apk.example.com` | Serve HTTPS through Caddy with automatic certificates. The DNS A record must already point to the server and ports 80 and 443 must be open. |
| `--version v1.0.0` | Install a tag or branch instead of `main`. |
| `--dir /srv/apk` | Install somewhere else. |
| `--dry-run` | Run every check and print the plan without changing anything. |
| `--yes` | Never prompt. |

The installer checks the operating system, privileges, CPU architecture, memory, disk and connectivity. It installs Docker from the official Docker apt repository when it is missing, clones the repository, creates `.env` with mode 600, prepares `data/` for uid 10001, builds the image, starts the stack and waits for `/api/health`. The first build downloads the Android SDK and takes several minutes.

If the directory already contains an installation, the installer changes nothing and points to `update.sh`. An existing `.env` is never overwritten.

Without `--domain` the service listens on plain HTTP on port 3000. Enable HTTPS later with:

```
sudo bash /opt/inconnu-boy-apk-builder/scripts/set-domain.sh apk.example.com
```

If the service is not healthy afterwards the previous configuration is restored.

## Operate

```
sudo bash /opt/inconnu-boy-apk-builder/scripts/update.sh
sudo bash /opt/inconnu-boy-apk-builder/scripts/update.sh --version v1.1.0
sudo bash /opt/inconnu-boy-apk-builder/scripts/doctor.sh
sudo bash /opt/inconnu-boy-apk-builder/scripts/backup.sh
sudo bash /opt/inconnu-boy-apk-builder/scripts/restore.sh /var/backups/inconnu-boy-apk-builder/backup-YYYYmmdd-HHMMSS.tar.gz
sudo bash /opt/inconnu-boy-apk-builder/scripts/uninstall.sh
```

`update.sh` takes a backup, fast-forwards the checkout, rebuilds, restarts and checks health. If the build or the health check fails it returns to the previous revision. `.env` and `data/` are never touched. Local edits to tracked files make it stop.

`backup.sh` snapshots SQLite with `VACUUM INTO` while the service runs, then archives the snapshot, the artifacts and by default `.env` into `/var/backups/inconnu-boy-apk-builder` (mode 600, seven archives kept, `BACKUP_KEEP` to change). Copy archives off the server; a backup on the same disk does not protect against disk loss.

`restore.sh` validates the archive (safe paths, no links, manifest checksum, SQLite integrity) before stopping the service, moves the current data to `data/pre-restore-<time>`, restores, and reverts if the service is unhealthy.

`uninstall.sh` removes containers and images and keeps `data/`. `--purge --confirm DELETE` deletes the whole installation directory; backups are never deleted.

## Firewall

The installer does not change your firewall. Allow 22, 80 and 443 (`sudo ufw allow 22,80,443/tcp`). With a domain the app port is bound to 127.0.0.1 and Caddy publishes 80 and 443.
