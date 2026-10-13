// Turns raw sing-box log lines about the proxy connection into something a
// person can act on. Lines about the "direct" outbound (Russian sites, LAN)
// are ignored: failures there say nothing about the VPN server itself.

const ANSI = /\u001b\[[0-9;]*m/g;

const RULES = [
  {
    kind: "admin",
    test: /access is denied|permission denied|requires elevat|operation requires/,
    title: "Нужны права администратора",
    hint: "Туннель создаётся только с правами администратора. Закройте Nyx и запустите его заново, подтвердив запрос Windows.",
  },
  {
    kind: "port",
    test: /address already in use|only one usage of each socket address/,
    title: "Порт занят другой программой",
    hint: "Закройте другие VPN-клиенты (Happ, v2rayN и подобные): они могут занимать нужные порты.",
  },
  {
    kind: "reality",
    test: /reality|processed invalid connection|verification failed/,
    title: "Ошибка Reality",
    hint: "Проверьте public key, short id и SNI в профиле: они должны совпадать с настройками сервера.",
  },
  {
    kind: "tls",
    test: /tls:|x509|certificate|handshake failure|unknown authority/,
    title: "Ошибка защищённого соединения (TLS)",
    hint: "Проверьте SNI и сертификат сервера в профиле. Если «Обход блокировок (TLS fragment)» включён, попробуйте его выключить: с Cloudflare и Reality он может мешать.",
  },
  {
    kind: "auth",
    test: /invalid user|unknown user|authentication fail|bad request|status (401|403)/,
    title: "Сервер не принял ключ",
    hint: "UUID или параметры профиля не подходят к этому серверу. Обновите подписку или попросите новую ссылку.",
  },
  {
    kind: "websocket",
    test: /websocket|bad handshake/,
    title: "Сервер не принял WebSocket-соединение",
    hint: "Проверьте path и host (для type=ws) в профиле, а также что порт сервера принимает WebSocket.",
  },
  {
    kind: "dns",
    test: /no such host|lookup .*(fail|timeout|refused)|server misbehaving/,
    title: "Не удалось найти адрес сервера",
    hint: "Проверьте доменное имя в профиле или используйте IP-адрес сервера. Попробуйте другой DNS в настройках.",
  },
  {
    kind: "refused",
    test: /actively refused|connection refused/,
    title: "Сервер отказал в подключении",
    hint: "Порт закрыт или сервис на сервере остановлен. Проверьте адрес и порт профиля или выберите другой сервер.",
  },
  {
    kind: "timeout",
    test: /i\/o timeout|timed out|deadline exceeded/,
    title: "Сервер не отвечает",
    hint: "Возможно, провайдер блокирует соединение: попробуйте другой профиль. Если «Обход блокировок (TLS fragment)» включён, выключите его: он помогает не везде, с Cloudflare и Reality бывает наоборот.",
  },
  {
    kind: "network",
    test: /unreachable network|network is unreachable|no route to host/,
    title: "Нет доступа к сети",
    hint: "Проверьте подключение к интернету и попробуйте ещё раз.",
  },
];

export function cleanLogLine(line) {
  return String(line || "").replace(ANSI, "").trim();
}

// Returns { kind, title, hint, raw } or null when the line is not worth
// showing to the user.
export function explainSingBoxLine(line) {
  const raw = cleanLogLine(line);
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const fatal = lower.includes("fatal");
  const proxyError = lower.includes("error") && lower.includes("outbound/vless[proxy]");
  if (!fatal && !proxyError) return null;
  for (const rule of RULES) {
    if (rule.test.test(lower)) return { kind: rule.kind, title: rule.title, hint: rule.hint, raw: raw.slice(0, 300) };
  }
  if (fatal) {
    return {
      kind: "other",
      title: "Не удалось запустить подключение",
      hint: "Подробности — в журнале («Настройки» → «Диагностика»). Если ошибка повторяется, отправьте журнал разработчику.",
      raw: raw.slice(0, 300),
    };
  }
  return null;
}

// Keeps one message per kind from flooding the UI: an error that repeats every
// few hundred milliseconds is reported once per window.
export function createIssueThrottle(windowMs = 60000, now = () => Date.now()) {
  const last = new Map();
  return (kind) => {
    const t = now();
    if (last.has(kind) && t - last.get(kind) < windowMs) return false;
    last.set(kind, t);
    return true;
  };
}
