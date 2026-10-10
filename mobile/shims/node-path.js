// Minimal stand-in for node:path (the shared modules only join rule-set file paths).
export function join(...parts) {
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}
export default { join };
