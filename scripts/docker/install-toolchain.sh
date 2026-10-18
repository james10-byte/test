#!/usr/bin/env bash
set -eu

GRADLE_VERSION="${GRADLE_VERSION:?}"
CMDLINE_TOOLS_VERSION="${CMDLINE_TOOLS_VERSION:?}"
ANDROID_PLATFORM="${ANDROID_PLATFORM:?}"
ANDROID_BUILD_TOOLS="${ANDROID_BUILD_TOOLS:?}"
ANDROID_HOME="${ANDROID_HOME:-/opt/android-sdk}"
WORKDIR="$(mktemp -d)"

download() {
  local url="$1" destination="$2" expected="${3:-}"
  curl -fsSL --retry 4 --retry-delay 3 -o "$destination" "$url"
  if [ -n "$expected" ]; then
    printf '%s  %s\n' "$expected" "$destination" | sha256sum --check --status \
      || { echo "Checksum mismatch for $url" >&2; exit 1; }
  else
    echo "No checksum supplied for $url; computed $(sha256sum "$destination" | cut -d' ' -f1)" >&2
  fi
}

download "https://services.gradle.org/distributions/gradle-${GRADLE_VERSION}-bin.zip" "$WORKDIR/gradle.zip" "${GRADLE_SHA256:-}"
unzip -q "$WORKDIR/gradle.zip" -d /opt
mv "/opt/gradle-${GRADLE_VERSION}" /opt/gradle

download "https://dl.google.com/android/repository/commandlinetools-linux-${CMDLINE_TOOLS_VERSION}_latest.zip" "$WORKDIR/tools.zip" "${CMDLINE_TOOLS_SHA256:-}"
mkdir -p "$ANDROID_HOME/cmdline-tools"
unzip -q "$WORKDIR/tools.zip" -d "$WORKDIR/tools"
mv "$WORKDIR/tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"

SDKMANAGER="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
yes | "$SDKMANAGER" --sdk_root="$ANDROID_HOME" --licenses > /dev/null || true
"$SDKMANAGER" --sdk_root="$ANDROID_HOME" "platforms;android-${ANDROID_PLATFORM}" "build-tools;${ANDROID_BUILD_TOOLS}"

rm -rf "$WORKDIR"
"/opt/gradle/bin/gradle" --version
