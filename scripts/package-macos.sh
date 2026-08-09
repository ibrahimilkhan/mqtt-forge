#!/usr/bin/env bash
# Builds a self-contained .app and wraps it in a .dmg. Unsigned: allow through Gatekeeper on first launch.
set -euo pipefail

ARCH="${1:-osx-arm64}"
# Not VERSION: MSBuild reads that one out of the environment and fails the restore
# on a tag like v1.0.0, which is not a valid package version. The v is stripped for
# the same reason on Apple's side — CFBundleShortVersionString has to be numeric.
VERSION="${APP_VERSION:-1.0}"
VERSION="${VERSION#v}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Named after the arch so building both slices in a row doesn't overwrite the first one.
LABEL="${ARCH#osx-}"
STAGE="$ROOT/dist/stage-$LABEL"
APP="$STAGE/MQTTForge.app"
DMG="$ROOT/dist/MQTTForge-macos-$LABEL.dmg"

rm -rf "$STAGE"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

dotnet publish "$ROOT/src/MqttForge.Desktop" \
  -c Release -r "$ARCH" --self-contained true \
  -o "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MQTTForge</string>
  <key>CFBundleDisplayName</key><string>MQTTForge</string>
  <key>CFBundleIdentifier</key><string>dev.mqttforge.desktop</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>MQTTForge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

hdiutil create -volname MQTTForge -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"
echo "${DMG#"$ROOT"/}"
