# Oracle Cloud Infrastructure

Not tested. Read the architecture warning first.

The Always Free Ampere A1 shapes are Arm and are not supported, because Android's `aapt2` is not available for Linux on Arm. The Always Free AMD micro shapes have 1 GB of memory, which is too little. Use an x86 flexible shape such as `VM.Standard.E4.Flex` with at least 2 OCPUs and 4 GB of memory (paid).

1. Create an Ubuntu 24.04 instance with a public IP and at least 50 GB boot volume.
2. In the VCN security list or network security group, allow ingress TCP 80 and 443 (and 22 from your address).
3. Ubuntu images on OCI also ship iptables rules that reject other inbound ports. Allow 80 and 443 there too, and persist the rules, otherwise HTTPS certificates cannot be issued.
4. Follow `vps.md`.
