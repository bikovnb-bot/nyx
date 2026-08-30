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

function buildTls(profile) {
  if (profile.security === "tls") {
    return {
      enabled: true,
      server_name: profile.sni || undefined,
      insecure: profile.allowInsecure,
      utls: { enabled: true, fingerprint: profile.fingerprint },
    };
  }
  if (profile.security === "reality") {
    return {
      enabled: true,
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

export function buildSingBoxConfig(profile, opts = {}) {
  const tunAddress = opts.tunAddress || ["172.19.0.1/30", "fdfe:dcba:9876::1/126"];

  return {
    log: { level: "warn", timestamp: true },
    experimental: {
      clash_api: { external_controller: CLASH_API_ADDRESS },
    },
    dns: {
      servers: [{ type: "https", tag: "remote-dns", server: "1.1.1.1", detour: "proxy" }],
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
        tls: buildTls(profile),
      },
      { type: "direct", tag: "direct" },
      { type: "block", tag: "block" },
    ],
    route: {
      rules: [
        { action: "sniff" },
        { port: 53, action: "hijack-dns" },
        { ip_is_private: true, outbound: "direct" },
      ],
      final: "proxy",
      auto_detect_interface: true,
      default_domain_resolver: "remote-dns",
    },
  };
}
