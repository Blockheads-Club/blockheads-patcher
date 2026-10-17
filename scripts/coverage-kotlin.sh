#!/usr/bin/env bash
# Robolectric + JaCoCo unit tests for the Android plugin, enforcing 100% line AND branch coverage.
# Needs: JDK 17/21 (not 26), Android SDK (platform 36), and a generated Android project
# (`cd app && bun tauri android init` / any `tauri android build`) so tauri.settings.gradle exists.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
gen="$root/app/src-tauri/gen/android"
if [ -z "${JAVA_HOME:-}" ]; then
  for j in /usr/lib/jvm/java-21-openjdk /usr/lib/jvm/java-17-openjdk; do
    [ -d "$j" ] && export JAVA_HOME="$j" && break
  done
fi
[ -f "$gen/local.properties" ] || echo "sdk.dir=${ANDROID_HOME:-$HOME/Android/Sdk}" > "$gen/local.properties"
cd "$gen"
./gradlew --no-configuration-cache :tauri-plugin-apk-tools:jacocoDebugVerify "$@"
echo "report: $root/plugins/tauri-plugin-apk-tools/android/build/reports/jacoco/jacocoDebugReport/html/index.html"
