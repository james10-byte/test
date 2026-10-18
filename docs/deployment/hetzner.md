# Hetzner Cloud

Not tested. This reuses the VPS installer on a Cloud server.

1. Create an Ubuntu 24.04 server on an x86 plan (Intel or AMD; avoid the Arm-based CAX line) with at least 4 GB of memory. Check current plan names.
2. Create a Cloud Firewall allowing inbound TCP 22, 80 and 443 and attach it to the server.
3. Point your domain at the server and follow `vps.md`, with `--domain`.

For extra storage attach a Volume, mount it, set `DATA_PATH` to the mount point in `.env` before first start and `chown -R 10001:10001` it. Keep backups on a different location from the server.
