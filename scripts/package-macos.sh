#!/usr/bin/env bash
# Builds a self-contained .app and wraps it in a .dmg. Unsigned: on first launch the user
# has to allow it through Gatekeeper (right-click, Open).
set -euo pipefail

ARCH="${1:-osx-arm64}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$ROOT/dist/stage"
APP="$STAGE/MQFaker.app"

rm -rf "$ROOT/dist"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

dotnet publish "$ROOT/src/MQFaker.Desktop" \
  -c Release -r "$ARCH" --self-contained true \
  -o "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>MQFaker</string>
  <key>CFBundleDisplayName</key><string>MQFaker</string>
  <key>CFBundleIdentifier</key><string>dev.mqfaker.desktop</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleExecutable</key><string>MQFaker</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

hdiutil create -volname MQFaker -srcfolder "$STAGE" -ov -format UDZO "$ROOT/dist/MQFaker.dmg"
rm -rf "$STAGE"
echo "dist/MQFaker.dmg"
