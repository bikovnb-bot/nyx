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
    ...(blockAds ? [{ rule_set: ["geosite-ads"], action: "reject" }] : []),
    ...(directRu ? [{ rule_set: ["geosite-ru"], server: "ru-dns" }, { domain_suffix: RU_TLDS, server: "ru-dns" }] : []),
  ];
  const tunAddress = opts.tunAddress || ["172.19.0.1/30", "fdfe:dcba:9876::1/126"];

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
        ...(directRu ? [{ type: "udp", tag: "ru-dns", server: RU_DNS_SERVER }] : []),
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
        mtu: 1500,
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
        uuid: profile.uuid,
        flow: profile.flow || undefined,
        transport: buildTransport(profile),
        tls: buildTls(profile, !!opts.fragment),
      },
      { type: "direct", tag: "direct" },
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
