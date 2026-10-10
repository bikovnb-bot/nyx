// Speed test through whatever route this app's traffic takes (with the VPN on,
// that is the tunnel). Uses Cloudflare's public speed-test endpoints, which are
// meant for exactly this. Only the user's own request starts it.
//
// Everything network-related is injected (`fetchFn`, `now`) so the arithmetic
// can be tested without a network.

export const DOWN_URL = "https://speed.cloudflare.com/__down?bytes=";
export const UP_URL = "https://speed.cloudflare.com/__up";

export function mbps(bytes, ms) {
  if (!(ms > 0) || !(bytes > 0)) return 0;
  return (bytes * 8) / 1e6 / (ms / 1000);
}

// Latency: average and jitter (mean change between neighbouring samples).
export function latencyStats(samples) {
  const s = samples.filter((x) => Number.isFinite(x));
  if (!s.length) return { avg: null, min: null, jitter: null };
  const avg = s.reduce((a, b) => a + b, 0) / s.length;
  let jitter = 0;
  if (s.length > 1) {
    for (let i = 1; i < s.length; i++) jitter += Math.abs(s[i] - s[i - 1]);
    jitter /= s.length - 1;
  }
  return { avg, min: Math.min(...s), jitter };
}

export async function measureLatency(fetchFn, { count = 6, now = () => performance.now(), onSample } = {}) {
  const samples = [];
  // the first request pays for DNS and the TLS handshake: not part of the figure
  for (let i = 0; i <= count; i++) {
    const t0 = now();
    const res = await fetchFn(DOWN_URL + "0");
    await res.arrayBuffer();
    const dt = now() - t0;
    if (i > 0) {
      samples.push(dt);
      onSample?.(latencyStats(samples));
    }
  }
  return latencyStats(samples);
}

// Reads a big download and reports the rate; stops after maxMs even if the file
// has not finished, so a slow link does not make the test last for minutes.
export async function measureDownload(fetchFn, { bytes = 30_000_000, maxMs = 8000, now = () => performance.now(), onProgress } = {}) {
  const res = await fetchFn(DOWN_URL + bytes);
  const reader = res.body.getReader();
  const t0 = now();
  let got = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    got += value.length;
    const elapsed = now() - t0;
    onProgress?.(mbps(got, elapsed));
    if (elapsed >= maxMs) {
      try {
        await reader.cancel();
      } catch {}
      break;
    }
  }
  const ms = now() - t0;
  return { bytes: got, ms, mbps: mbps(got, ms) };
}

export async function measureUpload(fetchFn, { bytes = 8_000_000, now = () => performance.now() } = {}) {
  const body = new Uint8Array(bytes);
  const t0 = now();
  const res = await fetchFn(UP_URL, { method: "POST", body });
  await res.arrayBuffer();
  const ms = now() - t0;
  return { bytes, ms, mbps: mbps(bytes, ms) };
}

// Runs the three stages and reports after each step through onUpdate({phase, ...}).
export async function runSpeedtest(fetchFn, { now = () => performance.now(), onUpdate = () => {}, isCancelled = () => false } = {}) {
  const result = { ping: null, jitter: null, down: null, up: null };
  onUpdate({ phase: "ping", ...result });
  const lat = await measureLatency(fetchFn, {
    now,
    onSample: (s) => onUpdate({ phase: "ping", ...result, ping: s.avg, jitter: s.jitter }),
  });
  result.ping = lat.avg;
  result.jitter = lat.jitter;
  if (isCancelled()) return { ...result, cancelled: true };

  onUpdate({ phase: "download", ...result });
  const down = await measureDownload(fetchFn, { now, onProgress: (v) => onUpdate({ phase: "download", ...result, down: v }) });
  result.down = down.mbps;
  if (isCancelled()) return { ...result, cancelled: true };

  onUpdate({ phase: "upload", ...result });
  const up = await measureUpload(fetchFn, { now });
  result.up = up.mbps;
  onUpdate({ phase: "done", ...result });
  return result;
}
