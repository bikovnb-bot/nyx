# Nyx

Minimal cross-platform VPN client for VLESS+WS+TLS configs (the kind 3x-ui
generates). It does not reimplement the protocol — it generates a
[sing-box](https://sing-box.sagernet.org/) config and runs `sing-box` as a
subprocess with a TUN inbound, so all system traffic gets routed through the
proxy.

## Prerequisites

1. Node.js 18+
2. `sing-box` binary on PATH, or set `SINGBOX_PATH` to its full path.
   Download: https://github.com/SagerNet/sing-box/releases
3. Administrator/root privileges (required to create a TUN interface).

## Install

```bash
npm install
npm link   # exposes the `vlessvpn` (and `nyx`) command globally
```

## Usage

```bash
# Windows (as Administrator) / Linux & macOS (as root)
vlessvpn connect "vless://<uuid>@5.145.176.51:443?type=ws&security=tls&path=%2F&encryption=none&fp=chrome#Test"
```

Ctrl+C disconnects and tears down the TUN interface.

## Notes

- Only `vless://` links with `type=ws` and `security=tls|none` are parsed
  today. `reality` and `grpc` transports are not implemented yet.
- DNS is resolved through the proxy by default (`remote-dns` in the
  generated config) to avoid leaks.
