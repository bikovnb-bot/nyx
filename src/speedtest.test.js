import { test } from "node:test";
import assert from "node:assert/strict";
import { mbps, latencyStats, measureLatency, measureDownload, measureUpload, runSpeedtest, DOWN_URL, UP_URL } from "./speedtest.js";

test("rate arithmetic", () => {
  assert.equal(mbps(12_500_000, 1000), 100); // 12.5 MB in a second = 100 Mbit/s
  assert.equal(mbps(0, 1000), 0);
  assert.equal(mbps(1000, 0), 0);
});

test("latency statistics: average, best, jitter", () => {
  const s = latencyStats([40, 50, 60, 50]);
  assert.equal(s.avg, 50);
  assert.equal(s.min, 40);
  assert.equal(s.jitter, (10 + 10 + 10) / 3);
  assert.deepEqual(latencyStats([]), { avg: null, min: null, jitter: null });
  assert.equal(latencyStats([30]).jitter, 0);
});

// A fake clock that advances by a fixed step every time it is read.
const clock = (step) => {
  let t = 0;
  return () => {
    t += step;
    return t;
  };
};

const stream = (chunks, size) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < chunks; i++) c.enqueue(new Uint8Array(size));
        c.close();
      },
    })
  );

test("the first latency request (handshake) is not counted", async () => {
  const urls = [];
  const fetchFn = async (u) => {
    urls.push(u);
    return new Response(new Uint8Array(0));
  };
  const lat = await measureLatency(fetchFn, { count: 3, now: clock(20) });
  assert.equal(urls.length, 4);
  assert.ok(urls.every((u) => u === DOWN_URL + "0"));
  assert.equal(lat.avg, 20); // each request spans two clock reads, 20 ms apart
});

test("download rate is bytes over time, and stops at the time limit", async () => {
  // 10 chunks of 1 MB, 100 ms between reads: 10 MB over ~1 s = ~80 Mbit/s
  const fast = await measureDownload(async () => stream(10, 1_000_000), { now: clock(100), maxMs: 60_000 });
  assert.equal(fast.bytes, 10_000_000);
  assert.ok(fast.mbps > 70 && fast.mbps < 100, `got ${fast.mbps}`);

  // a slow link is cut at maxMs even though the file is not finished
  const slow = await measureDownload(async () => stream(1000, 100_000), { now: clock(500), maxMs: 2000 });
  assert.ok(slow.bytes < 100_000_000);
  assert.ok(slow.ms >= 2000);
});

test("upload posts the data and divides by the elapsed time", async () => {
  let seen;
  const res = await measureUpload(
    async (url, init) => {
      seen = { url, method: init.method, size: init.body.length };
      return new Response("ok");
    },
    { bytes: 1_250_000, now: clock(100) }
  );
  assert.deepEqual(seen, { url: UP_URL, method: "POST", size: 1_250_000 });
  assert.equal(res.mbps, 100);
});

test("the full run reports each phase and the final figures", async () => {
  const phases = [];
  const fetchFn = async (url, init) => (init?.method === "POST" ? new Response("ok") : url.endsWith("=0") ? new Response(new Uint8Array(0)) : stream(5, 500_000));
  const out = await runSpeedtest(fetchFn, { now: clock(50), onUpdate: (u) => phases.push(u.phase) });
  assert.ok(out.ping > 0 && out.down > 0 && out.up > 0);
  assert.deepEqual([...new Set(phases)], ["ping", "download", "upload", "done"]);
});

test("a cancelled run stops before the next stage", async () => {
  let calls = 0;
  const fetchFn = async () => {
    calls++;
    return new Response(new Uint8Array(0));
  };
  const out = await runSpeedtest(fetchFn, { now: clock(10), isCancelled: () => true });
  assert.equal(out.cancelled, true);
  assert.equal(out.down, null);
  assert.equal(calls, 7); // only the latency stage ran
});
