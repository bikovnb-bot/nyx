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
  if (opts.serverIp) {
    // connect by address; the name stays as SNI / WebSocket Host
    const name = profile.host;
    profile.sni = profile.sni || name;
    if (profile.type === "ws") profile.wsHost = profile.wsHost || name;
    profile.host = opts.serverIp;
  }
  const config = buildSingBoxConfig(profile, {
    dns: opts.dns,
    routing: opts.routing,
    fragment: opts.fragment,
    rulesDir: opts.rulesDir,
    splitTunneling: undefined,
    // on Android the separate bootstrap resolver stalls (libbox has no local resolver)
    bootstrapDns: false,
    tunAddress: ["172.19.0.1/30", "fdfe:dcba:9876::1/126"],
  });
  const tun = config.inbounds.find((i) => i.type === "tun");
  delete tun.interface_name;
  delete tun.exclude_interface;
  delete tun.strict_route;
  tun.stack = "mixed";
  tun.mtu = 1500;
  config.log = { level: "warn", timestamp: true };
  return { config, profile };
}
