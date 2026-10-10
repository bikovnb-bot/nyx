// "Is the VPN really in use?" helpers: normalise an IP-geolocation answer and
// turn it into a plain verdict. The network call itself lives in the main
// process; everything here is pure so it can be tested.
import { isIP } from "node:net";
import { DNS_PROVIDERS, resolveDnsServer } from "./configBuilder.js";

export const IP_INFO_URL = "https://ipwho.is/";

export function parseIpInfo(json) {
  if (!json || json.success === false || !isIP(String(json.ip || ""))) return null;
  return {
    ip: String(json.ip),
    country: json.country ? String(json.country) : "",
    countryCode: json.country_code ? String(json.country_code).toLowerCase() : "",
    city: json.city ? String(json.city) : "",
    isp: json.connection?.isp ? String(json.connection.isp) : json.connection?.org ? String(json.connection.org) : "",
  };
}

// connected: is the tunnel up; info: parseIpInfo result; serverHost: host of the
// active profile; realIp: the IP seen earlier while the VPN was off (or null).
export function leakVerdict({ connected, info, serverHost, realIp }) {
  if (!info) return { level: "error", text: "Не удалось определить внешний IP. Проверьте подключение к интернету." };
  if (!connected) {
    return { level: "info", text: "Nyx не подключён: сайты видят IP, показанный выше (если включён другой VPN, это его адрес). Запомнил его для сравнения при следующей проверке." };
  }
  if (realIp && info.ip === realIp) {
    return {
      level: "warn",
      text: "Внешний IP совпадает с вашим реальным: трафик идёт мимо VPN. Проверьте, не включены ли «Сайты РФ напрямую» и раздельное туннелирование.",
    };
  }
  if (serverHost && info.ip === serverHost) {
    return { level: "ok", text: "Всё в порядке: сайты видят IP вашего VPN-сервера." };
  }
  if (realIp) {
    return {
      level: "ok",
      text: "Всё в порядке: внешний IP отличается от вашего реального. (Он не совпадает с адресом сервера, если сервер стоит за CDN или цепочкой.)",
    };
  }
  return {
    level: "info",
    text: "Реальный IP пока неизвестен, сравнивать не с чем. Выключите VPN и запустите проверку один раз, потом включите и повторите.",
  };
}

// One line about the DNS set-up, for the check window.
export function describeDns(settings) {
  const dns = settings?.dns || {};
  const server = resolveDnsServer(dns);
  const name = dns.provider === "custom" && server === String(dns.custom || "").trim() ? "свой сервер" : (DNS_PROVIDERS[dns.provider] || DNS_PROVIDERS.cloudflare).label;
  const parts = [`DNS-запросы идут через туннель по HTTPS: ${name} (${server})`];
  if (settings?.routing?.directRu) parts.push("для сайтов РФ — Яндекс DNS напрямую, мимо туннеля");
  return parts.join("; ");
}
