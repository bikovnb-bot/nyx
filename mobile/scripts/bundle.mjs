// Bundles the shared Nyx modules for the phone into www/nyx-core.js (global NyxCore)
// and copies the flag icons and routing lists next to the page.
import { build } from "esbuild";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
await build({
  entryPoints: [path.join(root, "src", "core.js")],
  outfile: path.join(root, "www", "nyx-core.js"),
  bundle: true,
  format: "iife",
  globalName: "NyxCore",
  platform: "browser",
  target: "chrome100",
  alias: {
    "node:net": path.join(root, "shims", "node-net.js"),
    "node:path": path.join(root, "shims", "node-path.js"),
  },
  logLevel: "info",
});
mkdirSync(path.join(root, "www", "flags"), { recursive: true });
cpSync(path.join(root, "..", "electron", "assets", "flags"), path.join(root, "www", "flags"), { recursive: true });
cpSync(path.join(root, "..", "installer", "assets", "logo.png"), path.join(root, "www", "logo.png"));
mkdirSync(path.join(root, "www", "rules"), { recursive: true });
cpSync(path.join(root, "..", "vendor", "rules"), path.join(root, "www", "rules"), { recursive: true });
cpSync(path.join(root, "..", "electron", "assets", "vendor", "jsQR.js"), path.join(root, "www", "jsQR.js"));
