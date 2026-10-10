// Builds the signed Android APK and (with --publish) puts it into a GitHub release
// tagged android-vX.Y.Z. The APK is built on this machine because it needs libbox.aar
// (built from the sing-box sources, see ../README.md) and the signing key, which
// never leaves it.
//
//   node scripts/release-android.mjs            build only
//   node scripts/release-android.mjs --publish  build, verify the signature, publish
//
// Signing: NYX_SIGNING_PROPERTIES (default C:/Users/<user>/.nyx-signing/signing.properties).
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const publish = process.argv.includes("--publish");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const signing = process.env.NYX_SIGNING_PROPERTIES || path.join(os.homedir(), ".nyx-signing", "signing.properties");
if (!existsSync(signing)) {
  console.error(`Signing properties not found: ${signing}`);
  process.exit(1);
}
const env = {
  ...process.env,
  NYX_SIGNING_PROPERTIES: signing,
  JAVA_HOME: process.env.JAVA_HOME_21 || "C:/Program Files/Eclipse Adoptium/jdk-21.0.12.101-hotspot",
};

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: true, env, ...opts });
  if (r.status !== 0) {
    console.error(`Failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status || 1);
  }
}

run("npm", ["run", "bundle"], { cwd: root });
run("npx", ["cap", "sync", "android"], { cwd: root });
run(`"${path.join(root, "android", "gradlew.bat")}"`, ["assembleRelease", "--console=plain"], { cwd: path.join(root, "android") });

const built = path.join(root, "android", "app", "build", "outputs", "apk", "release", "app-release.apk");
if (!existsSync(built)) {
  console.error("Release APK not found (is the signing configuration valid?)");
  process.exit(1);
}
const outDir = path.join(root, "..", "release-android");
mkdirSync(outDir, { recursive: true });
const name = `Nyx-Android-${version}-arm64.apk`;
const apk = path.join(outDir, name);
copyFileSync(built, apk);
const sha = createHash("sha256").update(readFileSync(apk)).digest("hex");
writeFileSync(`${apk}.sha256`, `${sha}  ${name}\n`);
console.log(`\n${name}  ${(readFileSync(apk).length / 1048576).toFixed(1)} MB  sha256 ${sha}`);

// the APK must carry our release certificate, not the debug one
const sdk = process.env.ANDROID_HOME || path.join(os.homedir(), "AppData", "Local", "Android", "Sdk");
const tools = path.join(sdk, "build-tools");
const latest = existsSync(tools) ? readdirSync(tools).sort().pop() : null;
const apksigner = latest ? path.join(tools, latest, "apksigner.bat") : null;
if (apksigner && existsSync(apksigner)) {
  const v = spawnSync(`"${apksigner}"`, ["verify", "--print-certs", `"${apk}"`], { shell: true, encoding: "utf8", env });
  console.log(v.stdout.trim());
  if (v.status !== 0 || /Android Debug/i.test(v.stdout)) {
    console.error("APK signature check failed");
    process.exit(1);
  }
} else {
  console.warn("apksigner not found: signature not verified");
}

// keep the direct APK link in the README table current (the change is left uncommitted)
function updateReadmeLink() {
  const readme = path.join(root, "..", "README.md");
  let text = readFileSync(readme, "utf8");
  const link = `<!-- android-direct -->[${name}](https://github.com/bikovnb-bot/nyx/releases/download/android-v${version}/${name})<!-- /android-direct -->`;
  const next = text.replace(/<!-- android-direct -->[\s\S]*?<!-- \/android-direct -->/, link);
  if (next !== text) {
    writeFileSync(readme, next);
    console.log("README: direct Android link updated, remember to commit it");
  }
}

if (publish) {
  const tag = `android-v${version}`;
  const notesFile = path.join(outDir, "notes.md");
  writeFileSync(
    notesFile,
    [
      `Nyx для Android ${version}.`,
      "",
      "Установка: скачайте APK и откройте его на телефоне (Android 7+, 64-битный процессор). Android спросит разрешение на установку из этого источника.",
      "Обновления приложение находит само (раздел «О программе»).",
      "",
      `SHA-256: ${sha}`,
      "",
    ].join("\n")
  );
  run("gh", ["release", "create", tag, `"${apk}"`, `"${apk}.sha256"`, "--repo", "bikovnb-bot/nyx", "--latest=false", "--title", `"Nyx для Android ${version}"`, "--notes-file", `"${notesFile}"`]);
  updateReadmeLink();
}
