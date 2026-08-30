#!/usr/bin/env node
import { Command } from "commander";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseVlessLink } from "../src/parseLink.js";
import { buildSingBoxConfig } from "../src/configBuilder.js";
import { runSingBox, isElevated } from "../src/singbox.js";

const program = new Command();

program
  .name("vlessvpn")
  .description("Minimal VLESS+WS+TLS VPN client (TUN mode) powered by sing-box");

program
  .command("connect <link>")
  .description("Connect using a vless:// share link")
  .option("-i, --interface <name>", "TUN interface name")
  .action((link, options) => {
    if (!isElevated()) {
      console.error("Administrator/root privileges are required to create a TUN interface. Re-run elevated.");
      process.exit(1);
    }

    let profile;
    try {
      profile = parseVlessLink(link);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }

    const config = buildSingBoxConfig(profile, { interfaceName: options.interface });

    const dir = mkdtempSync(path.join(tmpdir(), "vlessvpn-"));
    const configPath = path.join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    console.log(`Connecting to ${profile.name} (${profile.host}:${profile.port})...`);
    console.log(`Config written to ${configPath}`);

    const child = runSingBox(configPath, {
      onLog: (line) => process.stdout.write(line),
      onError: (err) => {
        console.error(`Failed to start sing-box: ${err.message}`);
        process.exit(1);
      },
    });

    child.on("exit", (code) => {
      console.log(`sing-box exited with code ${code}`);
      process.exit(code ?? 0);
    });

    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        console.log("\nStopping...");
        child.kill(sig);
      });
    }
  });

program.parse();
