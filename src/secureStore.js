import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { protectCurrentUser, unprotectCurrentUser } from "./dpapi.js";

const FORMAT_TAG = "dpapi-currentuser";
const defaultCrypto = { protect: protectCurrentUser, unprotect: unprotectCurrentUser };

// A JSON file encrypted at rest with Windows DPAPI (same envelope as the
// profile store). For data that is a credential in itself, such as
// subscription URLs, which usually carry the account's access token.
// If DPAPI itself fails, save() falls back to plain JSON rather than losing
// the data.
export function createSecureJsonStore(file, { crypto = defaultCrypto, fallback = null, logger = console.error } = {}) {
  const fresh = () => structuredClone(fallback);

  function load() {
    if (!existsSync(file)) return fresh();
    try {
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (raw && raw.enc === FORMAT_TAG) {
        return JSON.parse(crypto.unprotect(Buffer.from(raw.data, "base64")).toString("utf8"));
      }
      return raw;
    } catch (err) {
      logger(`secureStore: failed to read ${file}: ${err.message}`);
      return fresh();
    }
  }

  function save(value) {
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      const encrypted = crypto.protect(Buffer.from(JSON.stringify(value), "utf8"));
      writeFileSync(file, JSON.stringify({ v: 1, enc: FORMAT_TAG, data: encrypted.toString("base64") }));
    } catch (err) {
      logger(`secureStore: DPAPI protect failed for ${file}, writing plain JSON: ${err.message}`);
      writeFileSync(file, JSON.stringify(value));
    }
  }

  return { load, save };
}
