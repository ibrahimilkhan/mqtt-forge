#!/usr/bin/env bash
# Builds a self-contained .app and wraps it in a .dmg. Unsigned: allow through Gatekeeper on first launch.
set -euo pipefail

ARCH="${1:-osx-arm64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/dist/stage"
APP="$STAGE/MQTTForge.app"

rm -rf "$ROOT/dist"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

dotnet publish "$ROOT/src/MqttForge.Desktop" \
  -c Release -r "$ARCH" --self-contained true \
  -o "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MQTTForge</string>
  <key>CFBundleDisplayName</key><string>MQTTForge</string>
  <key>CFBundleIdentifier</key><string>dev.mqttforge.desktop</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>MQTTForge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

hdiutil create -volname MQTTForge -srcfolder "$STAGE" -ov -format UDZO "$ROOT/dist/MQTTForge.dmg"
rm -rf "$STAGE"
echo "dist/MQTTForge.dmg"
