// Minimal stand-in for node:net, used when the shared Nyx modules run in the app.
export function isIPv4(s) {
  return /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(String(s));
}
export function isIPv6(s) {
  s = String(s);
  return s.includes(":") && /^[0-9a-fA-F:.]+$/.test(s) && s.split("::").length <= 2;
}
export function isIP(s) {
  return isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0;
}
export default { isIP, isIPv4, isIPv6 };
