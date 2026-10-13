import { isIP } from "node:net";
import path from "node:path";

export const DNS_PROVIDERS = {
  cloudflare: { label: "Cloudflare", server: "1.1.1.1" },
  google: { label: "Google", server: "8.8.8.8" },
  quad9: { label: "Quad9", server: "9.9.9.9" },
};

// DNS-over-HTTPS server address for the chosen provider. A custom entry must be
// an IP address (a hostname would itself need resolving first); anything
// invalid falls back to Cloudflare rather than leaving the tunnel without DNS.
export function resolveDnsServer(dns) {
  if (dns?.provider === "custom" && isIP(String(dns.custom || "").trim())) return String(dns.custom).trim();
  return (DNS_PROVIDERS[dns?.provider] || DNS_PROVIDERS.cloudflare).server;
}

export const RULE_SETS = {
  "geosite-ru": "geosite-category-ru.srs",
  "geoip-ru": "geoip-ru.srs",
  "geosite-ads": "geosite-category-ads-all.srs",
};
const RU_TLDS = ["ru", "su", "xn--p1ai"];
const RU_DNS_SERVER = "77.88.8.8";

function buildTransport(profile) {
  if (profile.type === "ws") {
    return {
      type: "ws",
      path: profile.path,
      headers: profile.wsHost ? { Host: profile.wsHost } : undefined,
    };
  }
  if (profile.type === "grpc") {
    return {
      type: "grpc",
      service_name: profile.serviceName || "",
    };
  }
  return undefined;
}

function buildTls(profile, fragment = false) {
  if (profile.security === "tls") {
    return {
      enabled: true,
      fragment: fragment || undefined,
      server_name: profile.sni || undefined,
      insecure: profile.allowInsecure,
      utls: { enabled: true, fingerprint: profile.fingerprint },
    };
  }
  if (profile.security === "reality") {
    return {
      enabled: true,
      fragment: fragment || undefined,
      server_name: profile.sni || undefined,
      utls: { enabled: true, fingerprint: profile.fingerprint },
      reality: {
        enabled: true,
        public_key: profile.publicKey,
        short_id: profile.shortId || undefined,
      },
    };
  }
  return undefined;
}

export const CLASH_API_ADDRESS = "127.0.0.1:9095";

function buildSplitTunnelRules(splitTunneling) {
  if (!splitTunneling?.enabled) return [];
  const rules = [];
  if (splitTunneling.domains?.length) {
    rules.push({ domain_suffix: splitTunneling.domains, outbound: "direct" });
  }
  if (splitTunneling.processes?.length) {
    rules.push({ process_name: splitTunneling.processes, outbound: "direct" });
  }
  return rules;
}

export function buildSingBoxConfig(profile, opts = {}) {
  const directRu = !!opts.routing?.directRu && !!opts.rulesDir;
  const blockAds = !!opts.routing?.blockAds && !!opts.rulesDir;
  const usedSets = [...(directRu ? ["geosite-ru", "geoip-ru"] : []), ...(blockAds ? ["geosite-ads"] : [])];
  const dnsRules = [
    // The tunnel is IPv4-only (most VPN servers have no IPv6 route): answering
    // AAAA would make browsers pick an address that hangs instead of falling
    // back, so Google/YouTube/Cloudflare sites stalled.
    { query_type: ["AAAA"], action: "predefined", rcode: "NOERROR" },
    ...(blockAds ? [{ rule_set: ["geosite-ads"], action: "reject" }] : []),
    // No per-rule `strategy: ipv4_only` here: sing-box 1.14 refuses it next to
    // the AAAA rule above, and that rule already keeps every answer IPv4-only.
    ...(directRu ? [{ rule_set: ["geosite-ru"], action: "route", server: "ru-dns" }, { domain_suffix: RU_TLDS, action: "route", server: "ru-dns" }] : []),
  ];
  // No IPv6 address on the TUN: with one, Windows treats IPv6 as working through
  // the tunnel and apps try it first, but the server cannot carry it.
  const hostIsName = !isIP(String(profile.host || "").replace(/^\[|\]$/g, ""));
  const tunAddress = opts.tunAddress || ["172.19.0.1/30"];

  return {
    log: { level: "warn", timestamp: true },
    experimental: {
      clash_api: { external_controller: CLASH_API_ADDRESS },
    },
    dns: {
      servers: [
        { type: "https", tag: "remote-dns", server: resolveDnsServer(opts.dns), detour: "proxy" },
        // Only for Russian sites that are sent directly: resolving them through
        // a foreign server would often return an address abroad.
        ...(directRu ? [{ type: "https", tag: "ru-dns", server: RU_DNS_SERVER }] : []),
        // Resolves the VPN server's own name before the tunnel exists. remote-dns
        // goes through the proxy, so using it for the proxy's address would wait
        // for the very connection that is being set up.
        ...(hostIsName ? [{ type: "https", tag: "bootstrap-dns", server: resolveDnsServer(opts.dns) }] : []),
      ],
      rules: dnsRules.length ? dnsRules : undefined,
      final: "remote-dns",
    },
    inbounds: [
      {
        type: "tun",
        tag: "tun-in",
        interface_name: opts.interfaceName || "vlessvpn0",
        address: tunAddress,
        // Below 1500 so the tunnel's own headers (TLS + WebSocket) still fit in a
        // single packet; at 1500 large TLS packets stall on some sites.
        mtu: 1400,
        auto_route: true,
        strict_route: true,
        stack: "system",
        // Without this, return traffic for anything routed to the "direct"
        // outbound (private-LAN traffic, and split-tunneled domains/apps)
        // loops back into the TUN under strict_route and gets no
        // connectivity at all — auto_detect_interface alone isn't enough on
        // Windows in practice (confirmed live: split-tunneled sites became
        // completely unreachable until this was added).
        exclude_interface: opts.defaultInterfaceName ? [opts.defaultInterfaceName] : undefined,
      },
    ],
    outbounds: [
      {
        type: "vless",
        tag: "proxy",
        server: profile.host,
        server_port: profile.port,
        domain_resolver: hostIsName ? { server: "bootstrap-dns", strategy: "ipv4_only" } : undefined,
        uuid: profile.uuid,
        flow: profile.flow || undefined,
        transport: buildTransport(profile),
        tls: buildTls(profile, !!opts.fragment),
      },
      // The direct outbound looks names up itself; without this it would use the
      // default resolver (through the tunnel), which defeats sending RU sites
      // directly and can fail outright. IPv4 only: Russian sites often answer
      // with IPv6 addresses, and without IPv6 on the PC that connection never
      // gets established (and is not retried over IPv4).
      { type: "direct", tag: "direct", domain_resolver: directRu ? { server: "ru-dns", strategy: "ipv4_only" } : undefined },
      { type: "block", tag: "block" },
    ],
    route: {
      rule_set: !usedSets.length ? undefined : usedSets.map((tag) => ({
        type: "local",
        tag,
        format: "binary",
        path: path.join(opts.rulesDir, RULE_SETS[tag]),
      })),
      rules: [
        { action: "sniff" },
        { port: 53, action: "hijack-dns" },
        // QUIC (UDP/443) is slow to fall back when the tunnel carries it over a
        // TCP transport (YouTube, Google); rejecting it makes the browser retry
        // right away over plain TCP.
        { protocol: "quic", action: "reject" },
        ...(blockAds ? [{ rule_set: ["geosite-ads"], action: "reject" }] : []),
        { ip_is_private: true, outbound: "direct" },
        ...buildSplitTunnelRules(opts.splitTunneling),
        ...(directRu
          ? [
              { rule_set: ["geosite-ru", "geoip-ru"], outbound: "direct" },
              { domain_suffix: RU_TLDS, outbound: "direct" },
            ]
          : []),
      ],
      final: "proxy",
      auto_detect_interface: true,
      default_domain_resolver: "remote-dns",
    },
  };
}
