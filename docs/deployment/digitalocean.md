# DigitalOcean

Not tested. This reuses the VPS installer on a Droplet.

1. Create an Ubuntu 24.04 Droplet on an Intel or AMD plan (not Arm) with at least 2 vCPUs and 4 GB of memory.
2. Add a Cloud Firewall allowing inbound TCP 22, 80 and 443.
3. Point your domain's A record at the Droplet, then follow `vps.md`.

To keep data on a Volume, mount it (for example at `/mnt/apk-data`), set `DATA_PATH=/mnt/apk-data` in `.env` before the first start, and `chown -R 10001:10001` it.

Spaces (object storage) and managed databases are not used: artifact storage is local and metadata is SQLite.
