// The Xray core as the carrier of the proxy connection. sing-box keeps doing the
// tunnel (TUN, routing, DNS, kill switch); when a profile needs Xray, sing-box
// hands the traffic to a local SOCKS port that Xray serves and Xray talks to the
// server. Pure functions only: starting the processes lives in the main process.
import { isIP } from "node:net";

export const CORES = ["auto", "singbox", "xray"];

export function normalizeCore(value) {
  return CORES.includes(value) ? value : "auto";
}

// Which core carries this profile. "auto" sends Reality and XHTTP profiles to
// Xray (the reference implementation of both: sing-box cannot do XHTTP at all,
// and its Reality handshake is refused by Xray servers from 26.9 on) and
// everything else to sing-box. `core` is null when the profile cannot be carried
// at all (XHTTP without an Xray binary); `note` says why a choice was overridden.
export function chooseCore(profile, preference, { xrayAvailable = true } = {}) {
  const pref = normalizeCore(preference);
  const needsXray = profile.type === "xhttp";
  if (needsXray) {
    return xrayAvailable
      ? { core: "xray", note: pref === "singbox" ? "xhttp-needs-xray" : null }
      : { core: null, note: "xhttp-needs-xray-missing" };
  }
  const wanted = pref === "auto" ? (profile.security === "reality" ? "xray" : "singbox") : pref;
  if (wanted === "xray" && !xrayAvailable) {
    return { core: "singbox", note: pref === "xray" ? "xray-missing" : null };
  }
  return { core: wanted, note: null };
}

const bare = (host) => String(host || "").replace(/^\[|\]$/g, "");

function buildStreamSettings(profile, opts) {
  const host = bare(profile.host);
  const serverName = profile.sni || (isIP(host) ? undefined : host);
  const stream = { network: profile.type };

  if (profile.type === "ws") {
    stream.wsSettings = { path: profile.path, host: profile.wsHost || undefined };
  } else if (profile.type === "grpc") {
    stream.grpcSettings = { serviceName: profile.serviceName || "" };
  } else if (profile.type === "xhttp") {
    stream.xhttpSettings = { path: profile.path, host: profile.wsHost || undefined, mode: profile.xhttpMode || "auto" };
  } else {
    stream.network = "tcp";
  }

  if (profile.security === "tls") {
    stream.security = "tls";
    stream.tlsSettings = {
      serverName,
      allowInsecure: !!profile.allowInsecure,
      fingerprint: profile.fingerprint || "chrome",
    };
  } else if (profile.security === "reality") {
    stream.security = "reality";
    stream.realitySettings = {
      serverName,
      fingerprint: profile.fingerprint || "chrome",
      publicKey: profile.publicKey,
      shortId: profile.shortId || "",
      spiderX: profile.spiderX || "",
    };
  } else {
    stream.security = "none";
  }

  // TLS fragment: the ClientHello is cut into pieces by a helper outbound.
  if (opts.fragment && stream.security !== "none") stream.sockopt = { dialerProxy: "fragment" };
  return stream;
}

// opts: { socksPort, socksAuth: {user, pass}, serverIp, fragment }
// serverIp is the already resolved address of a named server: Xray must not need
// DNS while the tunnel is being set up (its own lookups would go into the tunnel
// that waits for it). The name stays as TLS server name.
export function buildXrayConfig(profile, opts = {}) {
  const user = { id: profile.uuid, encryption: "none" };
  if (profile.flow) user.flow = profile.flow;

  const outbounds = [
    {
      tag: "proxy",
      protocol: "vless",
      settings: { vnext: [{ address: opts.serverIp || bare(profile.host), port: profile.port, users: [user] }] },
      streamSettings: buildStreamSettings(profile, opts),
    },
    { tag: "direct", protocol: "freedom" },
  ];
  if (opts.fragment) {
    outbounds.push({
      tag: "fragment",
      protocol: "freedom",
      settings: { fragment: { packets: "tlshello", length: "100-200", interval: "10-20" } },
    });
  }

  const socks = { udp: true, ip: "127.0.0.1" };
  if (opts.socksAuth) {
    socks.auth = "password";
    socks.accounts = [{ user: opts.socksAuth.user, pass: opts.socksAuth.pass }];
  } else {
    socks.auth = "noauth";
  }

  return {
    log: { loglevel: "warning" },
    inbounds: [{ tag: "socks-in", listen: "127.0.0.1", port: opts.socksPort, protocol: "socks", settings: socks }],
    outbounds,
  };
}
