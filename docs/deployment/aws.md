# AWS

Not tested. Use a single EC2 instance; AWS services beyond EC2 are optional and none is required.

1. Launch an Ubuntu 24.04 x86_64 instance (not Graviton) with at least 4 GB of memory, for example `t3.medium`, or 8 GB (`t3.large`, `m6i.large`) for two concurrent builds.
2. Use a gp3 EBS volume of at least 30 GB.
3. Security group: inbound TCP 22 from your address, 80 and 443 from anywhere. Attach an Elastic IP and point your domain at it.
4. Follow `vps.md`.

IAM roles are not needed. S3 for APK artifacts is not implemented. Elastic Beanstalk, ECS Fargate and App Runner are not suitable: they lack a simple persistent local volume for SQLite and APK storage with long-running Gradle processes.
