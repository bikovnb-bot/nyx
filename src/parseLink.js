export function parseVlessLink(link) {
  if (!link.startsWith("vless://")) {
    throw new Error("Only vless:// links are supported");
  }

  const withoutScheme = link.slice("vless://".length);
  const [authAndHost, fragment = ""] = withoutScheme.split("#");
  const [uuid, hostPart] = splitOnce(authAndHost, "@");
  if (!uuid || !hostPart) {
    throw new Error("Malformed vless link: missing uuid or host");
  }

  const [hostAndPort, query = ""] = splitOnce(hostPart, "?");
  const [host, portStr] = splitLastColon(hostAndPort);
  const port = Number(portStr);
  if (!host || !portStr || !Number.isFinite(port)) {
    throw new Error("Malformed vless link: missing host or port");
  }

  const params = new URLSearchParams(query);
  const security = params.get("security") || "none";
  const type = params.get("type") || "tcp";
  const publicKey = params.get("pbk") || "";
  const serviceName = params.get("serviceName") ? decodeURIComponent(params.get("serviceName")) : "";

  if (security === "reality" && !publicKey) {
    throw new Error("Malformed vless link: security=reality requires a pbk (public key) parameter");
  }
  if (type === "grpc" && !serviceName) {
    throw new Error("Malformed vless link: type=grpc requires a serviceName parameter");
  }

  return {
    uuid,
    host,
    port,
    name: decodeURIComponent(fragment) || host,
    type,
    security,
    path: params.get("path") ? decodeURIComponent(params.get("path")) : "/",
    wsHost: params.get("host") || "",
    sni: params.get("sni") || "",
    fingerprint: params.get("fp") || "chrome",
    allowInsecure: params.get("allowInsecure") === "1",
    flow: params.get("flow") || "",
    // reality
    publicKey,
    shortId: params.get("sid") || "",
    spiderX: params.get("spx") ? decodeURIComponent(params.get("spx")) : "",
    // grpc
    serviceName,
  };
}

function splitOnce(str, sep) {
  const idx = str.indexOf(sep);
  if (idx === -1) return [str, ""];
  return [str.slice(0, idx), str.slice(idx + sep.length)];
}

function splitLastColon(str) {
  const idx = str.lastIndexOf(":");
  if (idx === -1) return [str, ""];
  return [str.slice(0, idx), str.slice(idx + 1)];
}
