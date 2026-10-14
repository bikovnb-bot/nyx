import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRoutePrint, pickDefaultInterface, getDefaultInterfaceName } from "./networkInterface.js";

const SAMPLE = `
IPv4 Route Table
===========================================================================
Active Routes:
Network Destination        Netmask          Gateway       Interface  Metric
          0.0.0.0          0.0.0.0      192.168.31.1    192.168.31.56     25
          0.0.0.0          0.0.0.0         10.1.1.1        10.1.1.20     45
===========================================================================
`;

test("default routes are read and sorted by metric", () => {
  const routes = parseRoutePrint(SAMPLE);
  assert.deepEqual(routes.map((r) => r.ip), ["192.168.31.56", "10.1.1.20"]);
  assert.equal(routes[0].gateway, "192.168.31.1");
  assert.deepEqual(parseRoutePrint(""), []);
});

test("localized 'on-link' gateways are read too", () => {
  const routes = parseRoutePrint("          0.0.0.0          0.0.0.0       На канале        10.8.0.2      5");
  assert.equal(routes[0].ip, "10.8.0.2");
});

const nets = (name, ip) => ({ [name]: [{ family: "IPv4", address: ip }], Loopback: [{ family: "IPv4", address: "127.0.0.1" }] });

test("the adapter holding the best route is named from its address", () => {
  const routes = parseRoutePrint(SAMPLE);
  assert.equal(pickDefaultInterface(routes, nets("Беспроводная сеть 2", "192.168.31.56")), "Беспроводная сеть 2");
});

test("virtual-looking adapters are skipped, unknown ones leave the decision to PowerShell", () => {
  const routes = parseRoutePrint(SAMPLE);
  assert.equal(pickDefaultInterface(routes, nets("vlessvpn0", "192.168.31.56")), null);
  assert.equal(pickDefaultInterface(routes, nets("vEthernet (WSL)", "192.168.31.56")), null);
  assert.equal(pickDefaultInterface(routes, nets("Wi-Fi", "1.2.3.4")), null);
  assert.equal(pickDefaultInterface([], nets("Wi-Fi", "192.168.31.56")), null);
  // our own tunnel holds the best route; the physical adapter behind it is chosen
  const both = { vlessvpn0: [{ family: "IPv4", address: "172.19.0.1" }], "Wi-Fi": [{ family: "IPv4", address: "192.168.31.83" }] };
  const withTun = [{ gateway: "172.19.0.2", ip: "172.19.0.1", metric: 0 }, { gateway: "192.168.31.1", ip: "192.168.31.83", metric: 35 }];
  assert.equal(pickDefaultInterface(withTun, both), "Wi-Fi");
});

test("the real lookup answers and does not block the event loop", async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 5);
  const name = await getDefaultInterfaceName();
  clearInterval(timer);
  assert.ok(name === null || typeof name === "string");
  if (process.platform === "win32") assert.ok(ticks > 0, "the event loop kept running");
});
