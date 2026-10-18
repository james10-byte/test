FROM eclipse-temurin:21-jdk-jammy

ENV DEBIAN_FRONTEND=noninteractive \
    ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    GRADLE_USER_HOME=/opt/gradle-home \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    DATA_DIR=/data

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 python3-pip python3-venv unzip curl ca-certificates git \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Android SDK (command-line tools + platform 36 + build-tools 36)
RUN mkdir -p $ANDROID_HOME/cmdline-tools \
    && curl -fsSL -o /tmp/cmdtools.zip https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip \
    && unzip -q /tmp/cmdtools.zip -d $ANDROID_HOME/cmdline-tools \
    && mv $ANDROID_HOME/cmdline-tools/cmdline-tools $ANDROID_HOME/cmdline-tools/latest \
    && rm /tmp/cmdtools.zip
ENV PATH="${PATH}:${ANDROID_HOME}/cmdline-tools/latest/bin:${ANDROID_HOME}/platform-tools"
RUN yes | sdkmanager --licenses > /dev/null; \
    sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"

# Python deps
RUN python3 -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

# Node deps for the Capacitor template (cached layer)
COPY android-app-wrapper/package.json android-app-wrapper/package-lock.json android-app-wrapper/
RUN cd android-app-wrapper && npm ci

# Project files
COPY . .
RUN cd android-app-wrapper && npx cap sync android

# Warm the Gradle cache (downloads Gradle + all Android dependencies once)
RUN cd android-app-wrapper/android && chmod +x gradlew \
    && (./gradlew assembleDebug --no-daemon --console=plain -Dorg.gradle.jvmargs=-Xmx1200m --max-workers=2 \
        || echo "Gradle warm-up failed; dependencies will be fetched on first build") \
    && rm -rf build app/build .gradle

RUN mkdir -p /data
EXPOSE 5000
CMD ["sh", "-c", "gunicorn backend.app:app --bind 0.0.0.0:${PORT:-5000} --workers 1 --threads 8 --timeout 120"]
