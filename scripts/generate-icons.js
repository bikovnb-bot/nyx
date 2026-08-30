#!/usr/bin/env node
// Regenerates the Nyx app icon (build/icon.png, build/icon.ico) from the
// pure-JS icon renderer in src/makeIcon.js. Run after changing the mark.
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crescentMoonPng, pngToIco } from "../src/makeIcon.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const buildDir = path.join(__dirname, "..", "build");
mkdirSync(buildDir, { recursive: true });

// Indigo/violet crescent on transparent background — the Nyx (night) mark.
const png = crescentMoonPng(256, [167, 139, 250, 255]);
writeFileSync(path.join(buildDir, "icon.png"), png);
writeFileSync(path.join(buildDir, "icon.ico"), pngToIco(png, 256));

console.log("Wrote build/icon.png and build/icon.ico");
