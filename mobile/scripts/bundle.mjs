// Bundles the shared Nyx modules for the phone into www/nyx-core.js (global NyxCore).
import { build } from "esbuild";
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
