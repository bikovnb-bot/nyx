// Nyx core for the phone: the same link parser, subscription handling, config
// builder and helpers as the desktop app, with the few changes Android needs
// (the OS hands the tunnel to the core, there is no process/interface selection
// by name).
import { parseVlessLink } from "../../src/parseLink.js";
import { buildSingBoxConfig, DNS_PROVIDERS } from "../../src/configBuilder.js";

export { parseVlessLink, DNS_PROVIDERS };
export { parseSubscription, decodeSubscriptionBody, planSubscriptionSync, linkKey, nameFromLink } from "../../src/subscription.js";
export { profileCountryCode, hostOf, emojiFlagCode, AVAILABLE_FLAGS } from "../../src/country.js";
export { sortWithFavorites } from "../../src/selection.js";
export { explainSingBoxLine } from "../../src/errorHints.js";
export { parseIpInfo, leakVerdict, describeDns, IP_INFO_URL } from "../../src/leakCheck.js";
export { runSpeedtest } from "../../src/speedtest.js";

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
