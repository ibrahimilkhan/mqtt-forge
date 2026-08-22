#!/usr/bin/env bash
# Builds a self-contained .app and wraps it in a .dmg. Unsigned: allow through Gatekeeper on first launch.
set -euo pipefail

ARCH="${1:-osx-arm64}"
# Not VERSION: MSBuild reads that one out of the environment and fails the restore
# on a tag like v1.0.0, which is not a valid package version. The v is stripped for
# the same reason on Apple's side — CFBundleShortVersionString has to be numeric.
VERSION="${APP_VERSION:-1.0}"
VERSION="${VERSION#v}"
# A workflow_dispatch run passes a branch name, which MSBuild rejects outright.
[[ "$VERSION" =~ ^[0-9]+(\.[0-9]+)*$ ]] || VERSION="0.0.0"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Named after the arch so building both slices in a row doesn't overwrite the first one.
LABEL="${ARCH#osx-}"
STAGE="$ROOT/dist/stage-$LABEL"
APP="$STAGE/MQTTForge.app"
DMG="$ROOT/dist/MQTTForge-macos-$LABEL.dmg"

rm -rf "$STAGE"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# -p: rather than the environment, for the reason above: passed as a property it is read as a
# version, so the executable stops reporting 1.0.0 while the plist beside it says something else.
dotnet publish "$ROOT/src/MqttForge.Desktop" \
  -c Release -r "$ARCH" --self-contained true \
  -p:Version="$VERSION" \
  -o "$APP/Contents/MacOS"

# The Dock, Finder and the app switcher all read this one file. Named without its extension in
# the plist, which is how CFBundleIconFile is written.
cp "$ROOT/src/MqttForge.Desktop/Resources/MQTTForge.icns" "$APP/Contents/Resources/MQTTForge.icns"

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
  <key>CFBundleIconFile</key><string>MQTTForge</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST

# dotnet ad-hoc signs the executable alone, under the identifier "apphost". Inside a bundle
# macOS reads that as the BUNDLE's signature, looks for the _CodeSignature directory it
# implies, finds none, and reports the app as damaged — with no way past it but xattr. Signing
# the assembled bundle seals the resources and turns that into the ordinary unidentified-
# developer prompt, which right-click → Open answers. Must run last: any later write reopens
# the same hole.
codesign --force --deep --sign - --identifier dev.mqttforge.desktop "$APP"
codesign --verify --deep --strict "$APP"

# Gatekeeper refuses to launch an unsigned app from the read-only image and says to move it
# to Applications first. Without somewhere to drop it, that instruction is a dead end — this
# is the drop target, and it is why every other .dmg on the platform ships one.
ln -s /Applications "$STAGE/Applications"

hdiutil create -volname MQTTForge -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"
echo "${DMG#"$ROOT"/}"
