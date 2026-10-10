# Nyx for Android (work in progress)

A Capacitor shell: the web UI and the shared Nyx modules (`../src`: link parser,
sing-box config builder, ...) run in a WebView; a small native plugin
(`android/app/src/main/java/com/nyx/mobile`) runs the sing-box core (libbox) as an
Android `VpnService`.

## Licence note

The app links `libbox` (part of sing-box, GPL-3.0 with a name-use clause) and the
native VPN service follows the structure of the official sing-box Android client
(GPL-3.0). The mobile app is therefore distributed under GPL-3.0; the source must be
published with every APK.

## Build

Needs: JDK 21 (Gradle), JDK 17 (building libbox), Android SDK + NDK (27), Go (>= 1.25), Node 20+.

1. **libbox.aar** (the core). It is not committed (86 MB). Build it from the sing-box
   sources, tag v1.14.3:
   ```
   git clone --depth 1 --branch v1.14.3 https://github.com/SagerNet/sing-box.git
   cd sing-box
   go install github.com/sagernet/gomobile/cmd/gomobile@v0.1.13
   go install github.com/sagernet/gomobile/cmd/gobind@v0.1.13
   ```
   In `cmd/internal/build_libbox/main.go` reduce `sharedTags` to
   `with_gvisor, with_quic, with_wireguard, with_utls, with_clash_api, badlinkname, tfogo_checklinkname0`
   and drop the `with_tailscale` line (naive/cronet does not link with NDK 27 and the
   other extras are not needed). Then `go run ./cmd/internal/build_libbox -target android`
   (JAVA_HOME = JDK 17, ANDROID_HOME set) and copy `libbox.aar` to `android/app/libs/`.
2. `npm install` and `npm run bundle` (bundles `../src` into `www/nyx-core.js`).
3. `npx cap sync android`, then in `android/`: `gradlew assembleDebug` (JAVA_HOME = JDK 21).
   The repository folder name contains non-ASCII characters; `gradle.properties` sets
   `android.overridePathCheck=true` for that.
4. Install: `adb install -r android/app/build/outputs/apk/debug/app-debug.apk`.
