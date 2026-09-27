// A vless:// link's UUID is the actual credential for that server. Writing
// it in full to the diagnostics log means anyone who reads that log (a
// support thread, a seized/inspected machine, a screenshot) gets a working
// copy of the user's server access — so log output shows only enough of it
// to recognize which profile it was, never enough to reuse.
export function redactVlessLink(link) {
  if (typeof link !== "string") return link;
  return link.replace(/^(vless:\/\/)([^@]+)(@)/i, (_match, scheme, uuid, at) => {
    const visible = uuid.slice(0, 4);
    return `${scheme}${visible}…redacted${at}`;
  });
}
