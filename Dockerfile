FROM node:22-bookworm-slim

ARG GRADLE_VERSION=8.9
ARG CMDLINE_TOOLS_VERSION=11076708
ARG ANDROID_PLATFORM=34
ARG ANDROID_BUILD_TOOLS=34.0.0
ARG GRADLE_SHA256=
ARG CMDLINE_TOOLS_SHA256=

ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    GRADLE_HOME=/opt/gradle

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl unzip openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/*

COPY scripts/docker/install-toolchain.sh /tmp/install-toolchain.sh
RUN GRADLE_VERSION="$GRADLE_VERSION" CMDLINE_TOOLS_VERSION="$CMDLINE_TOOLS_VERSION" \
    ANDROID_PLATFORM="$ANDROID_PLATFORM" ANDROID_BUILD_TOOLS="$ANDROID_BUILD_TOOLS" \
    GRADLE_SHA256="$GRADLE_SHA256" CMDLINE_TOOLS_SHA256="$CMDLINE_TOOLS_SHA256" \
    bash /tmp/install-toolchain.sh \
    && rm -f /tmp/install-toolchain.sh

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && npm cache clean --force

COPY backend ./backend
COPY frontend ./frontend
COPY android-template ./android-template
COPY scripts/snapshot-database.mjs scripts/check-database.mjs ./scripts/

RUN groupadd --gid 10001 builder \
    && useradd --uid 10001 --gid 10001 --home-dir /home/builder --create-home --shell /usr/sbin/nologin builder \
    && mkdir -p /data \
    && chown -R builder:builder /data /opt/android-sdk /app

USER builder

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    GRADLE_COMMAND=/opt/gradle/bin/gradle \
    PATH=/opt/gradle/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "backend/src/server.js"]
