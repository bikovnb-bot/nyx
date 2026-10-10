// Builds the branded installer wizard (installer/). It downloads the regular
// NSIS setup from the latest GitHub release at run time, so it does not depend
// on `npm run dist`; the NSIS setup stays the engine and the file the in-app
// updater downloads, the wizard is only the friendlier first-install UI.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

const pkgPath = path.join(root, "installer", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = version;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const result = spawnSync("npx", ["electron-builder", "--projectDir", "installer", "--win", "portable", "--publish", "never"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
});
process.exit(result.status ?? 1);
