# Microsoft Azure

Not tested. Use a virtual machine.

1. Create an Ubuntu 24.04 x86_64 VM with at least 4 GB of memory, for example `Standard_B2s`, or `Standard_D2s_v5` (8 GB) for two concurrent builds. Do not choose Arm-based sizes.
2. Use a Premium SSD or Standard SSD managed disk of at least 30 GB.
3. In the network security group allow inbound TCP 22 from your address, 80 and 443. Assign a static public IP and point your domain at it.
4. Follow `vps.md`.

Azure App Service and Container Apps are not suitable: Gradle builds need a long-running process, several gigabytes of memory and a persistent local disk. Blob Storage is not used.
