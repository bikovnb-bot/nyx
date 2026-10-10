// Nyx core for the phone: the same link parser and config builder as the desktop
// app, with the few changes Android needs (the OS hands the tunnel to the core,
// there is no process/interface selection by name).
import { parseVlessLink } from "../../src/parseLink.js";
import { buildSingBoxConfig } from "../../src/configBuilder.js";

export { parseVlessLink };

export function buildMobileConfig(link, opts = {}) {
  const profile = parseVlessLink(link);
  const config = buildSingBoxConfig(profile, {
    dns: opts.dns,
    routing: opts.routing,
    fragment: opts.fragment,
    rulesDir: opts.rulesDir,
    splitTunneling: undefined,
  });
  const tun = config.inbounds.find((i) => i.type === "tun");
  delete tun.interface_name;
  delete tun.exclude_interface;
  delete tun.strict_route;
  tun.stack = "mixed";
  tun.mtu = 1400;
  config.log = { level: "warn", timestamp: true };
  return { config, profile };
}
