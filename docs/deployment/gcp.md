# Google Cloud

Not tested. Use Compute Engine.

1. Create a VM with an Ubuntu 24.04 x86_64 image and at least 4 GB of memory, for example `e2-medium`, or `e2-standard-2` (8 GB) for two concurrent builds. Use an x86 machine family, not the Arm-based `t2a`.
2. Use a balanced persistent disk of at least 30 GB.
3. Allow HTTP and HTTPS with the `http-server` and `https-server` network tags or equivalent firewall rules. Reserve a static external IP and point your domain at it.
4. Follow `vps.md`.

Cloud Storage and service accounts are not used. Cloud Run and App Engine are not suitable because the service needs a persistent local disk and long-running processes.
