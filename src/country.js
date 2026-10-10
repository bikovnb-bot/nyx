// Country detection for profiles. Lives in src/ (not in the window's script)
// so the tray menu and the window agree on what country a profile is in.

// Flags bundled as SVG under electron/assets/flags (flag-icons, MIT).
export const AVAILABLE_FLAGS = new Set(
  "de nl fi us ru fr tr se gb jp pl ee lv lt ch kz ca es it at be bg by cz dk gr hu ie il in kr no pt ro sg ua ae am az ge hk md br au cy lu mt is sk si ba al mk tw th vn id my ar cl za eg".split(" ")
);

// Short words (3 letters or fewer, e.g. country codes) only match as whole
// tokens; plain substring matching made names like "Reality" look Italian.
const COUNTRIES = [
  { code: "de", words: ["германия", "germany", "frankfurt", "франкфурт", "berlin", "берлин", "falkenstein", "nuremberg", "de"] },
  { code: "nl", words: ["нидерланды", "netherlands", "amsterdam", "амстердам", "holland", "nl"] },
  { code: "fi", words: ["финляндия", "finland", "helsinki", "хельсинки", "fi"] },
  { code: "us", words: ["сша", "usa", "united states", "america", "new york", "los angeles", "dallas", "miami", "us"] },
  { code: "ru", words: ["россия", "russia", "moscow", "москва", "petersburg", "ru"] },
  { code: "fr", words: ["франция", "france", "paris", "париж", "fr"] },
  { code: "tr", words: ["турция", "turkey", "istanbul", "стамбул", "tr"] },
  { code: "se", words: ["швеция", "sweden", "stockholm", "стокгольм", "se"] },
  { code: "gb", words: ["великобритания", "англия", "united kingdom", "london", "лондон", "england", "uk", "gb"] },
  { code: "jp", words: ["япония", "japan", "tokyo", "токио", "jp"] },
  { code: "pl", words: ["польша", "poland", "warsaw", "варшава", "pl"] },
  { code: "ee", words: ["эстония", "estonia", "tallinn", "таллин", "ee"] },
  { code: "lv", words: ["латвия", "latvia", "riga", "рига", "lv"] },
  { code: "lt", words: ["литва", "lithuania", "vilnius", "вильнюс", "lt"] },
  { code: "ch", words: ["швейцария", "switzerland", "zurich", "цюрих", "ch"] },
  { code: "kz", words: ["казахстан", "kazakhstan", "almaty", "алматы", "kz"] },
  { code: "ca", words: ["канада", "canada", "toronto", "торонто", "ca"] },
  { code: "es", words: ["испания", "spain", "madrid", "мадрид", "es"] },
  { code: "it", words: ["италия", "italy", "milan", "милан", "rome", "рим", "it"] },
];

export function fragmentOf(link) {
  const i = link.indexOf("#");
  if (i < 0) return "";
  try {
    return decodeURIComponent(link.slice(i + 1));
  } catch {
    return link.slice(i + 1);
  }
}

export function hostOf(link) {
  const afterAt = link.split("@")[1] || "";
  const hostPort = afterAt.split(/[?#]/)[0];
  return hostPort.replace(/:\d+$/, "");
}

// A flag emoji is two regional-indicator symbols, U+1F1E6..U+1F1FF.
export function emojiFlagCode(text) {
  const ri = [...text].map((ch) => ch.codePointAt(0)).filter((c) => c >= 0x1f1e6 && c <= 0x1f1ff);
  if (ri.length < 2) return null;
  return String.fromCharCode(97 + ri[0] - 0x1f1e6, 97 + ri[1] - 0x1f1e6);
}

function matchByWords(host, text) {
  const hay = (text + " " + host).toLowerCase();
  const tokens = hay.split(/[^a-zа-яё0-9]+/).filter(Boolean);
  const hit = COUNTRIES.find((c) => c.words.some((w) => (w.length <= 3 ? tokens.includes(w) : hay.includes(w))));
  return hit ? hit.code : null;
}

// The name after "#" in a vless:// link is where panels put things like
// "England-1-🇬🇧 Home", even when the profile was renamed locally.
export function profileCountryCode(profile) {
  const text = `${profile.name || ""} ${fragmentOf(profile.link || "")}`;
  const emoji = emojiFlagCode(text);
  if (emoji && AVAILABLE_FLAGS.has(emoji)) return emoji;
  return matchByWords(hostOf(profile.link || ""), text);
}
