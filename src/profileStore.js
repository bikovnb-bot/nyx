import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { protectCurrentUser, unprotectCurrentUser, unprotectCurrentUserAsync } from "./dpapi.js";

export function profileStorePath(userDataDir) {
  return path.join(userDataDir, "profiles.json");
}

// A short-lived experiment stored profiles encrypted via Electron's
// safeStorage. That tied the encryption key to the specific build's signing
// identity — every auto-update (a new, differently-signed binary) made
// previously saved profiles undecryptable. This path is only consulted
// once, best-effort, to migrate whatever an already-decryptable leftover
// file from that era might still hold.
function legacyEncryptedStorePath(userDataDir) {
  return path.join(userDataDir, "profiles.dat");
}

const plaintextCodec = {
  encode: (str) => Buffer.from(str, "utf8"),
  decode: (buf) => buf.toString("utf8"),
};

const defaultCrypto = {
  protect: protectCurrentUser,
  unprotect: unprotectCurrentUser,
  unprotectAsync: unprotectCurrentUserAsync,
};

const FORMAT_TAG = "dpapi-currentuser";

// Profiles hold server addresses and UUIDs — real credentials. They're
// encrypted at rest with Windows DPAPI (CurrentUser scope), which ties the
// key to the Windows account rather than to the app's code-signing identity
// like safeStorage did, so it keeps working across every auto-update. If
// DPAPI itself fails for some reason, save() falls back to plaintext rather
// than silently discarding the user's servers.
export function createProfileStore(
  userDataDir,
  { legacyCodec = plaintextCodec, crypto = defaultCrypto } = {},
  logger = console.error
) {
  const file = profileStorePath(userDataDir);

  // Every uncached load() decrypts through a PowerShell process (~0.2s), and the
  // UI asks for the profile list often, so the decrypted list is kept in memory
  // and only trusted while the file's modification time is unchanged.
  let cache = null;

  // Modification time alone is too coarse on some file systems (two writes in
  // the same tick look identical), so the size is part of the fingerprint.
  function mtimeOf() {
    try {
      const st = statSync(file);
      return `${st.mtimeMs}:${st.size}`;
    } catch {
      return null;
    }
  }

  function remember(profiles) {
    cache = { mtime: mtimeOf(), profiles: structuredClone(profiles) };
  }

  function save(profiles) {
    mkdirSync(userDataDir, { recursive: true });
    const plaintext = Buffer.from(JSON.stringify(profiles), "utf8");
    try {
      const encrypted = crypto.protect(plaintext);
      writeFileSync(file, JSON.stringify({ v: 1, enc: FORMAT_TAG, data: encrypted.toString("base64") }));
    } catch (err) {
      logger(`profileStore.save(): DPAPI protect failed, writing plaintext: ${err.message}`);
      writeFileSync(file, JSON.stringify(profiles, null, 2));
    }
    remember(profiles);
  }

  function load() {
    if (cache && cache.mtime !== null && cache.mtime === mtimeOf()) return structuredClone(cache.profiles);
    logger(`profileStore.load(): file=${file} exists=${existsSync(file)}`);
    if (existsSync(file)) {
      try {
        const raw = JSON.parse(readFileSync(file, "utf8"));
        if (Array.isArray(raw)) {
          // Pre-encryption plaintext profiles.json — migrate in place.
          logger(`profileStore.load(): migrating ${raw.length} plaintext profile(s) to encrypted storage`);
          save(raw);
          return raw;
        }
        if (raw && raw.enc === FORMAT_TAG) {
          const decrypted = crypto.unprotect(Buffer.from(raw.data, "base64"));
          const profiles = JSON.parse(decrypted.toString("utf8"));
          logger(`profileStore.load(): parsed ${profiles.length} profile(s)`);
          remember(profiles);
          return profiles;
        }
        logger(`profileStore.load(): unrecognized format in ${file}`);
        return [];
      } catch (err) {
        logger(`Failed to read profiles from ${file}: ${err.message}`);
        return [];
      }
    }

    // One-time best-effort migration from the old safeStorage-encrypted profiles.dat.
    const legacy = legacyEncryptedStorePath(userDataDir);
    if (existsSync(legacy)) {
      try {
        const profiles = JSON.parse(legacyCodec.decode(readFileSync(legacy)));
        save(profiles);
        unlinkSync(legacy);
        return profiles;
      } catch (err) {
        logger(`Could not migrate legacy encrypted profiles from ${legacy}: ${err.message}`);
      }
    }

    return [];
  }

  // Decrypts in the background and fills the cache, so the first load() (tray menu,
  // first window state) does not have to wait for a PowerShell process. If load()
  // gets there first it simply decrypts on its own, as before.
  async function preload() {
    try {
      const stamp = mtimeOf();
      if (stamp === null || (cache && cache.mtime === stamp) || !crypto.unprotectAsync) return;
      const raw = JSON.parse(readFileSync(file, "utf8"));
      if (!raw || raw.enc !== FORMAT_TAG) return;
      const profiles = JSON.parse((await crypto.unprotectAsync(Buffer.from(raw.data, "base64"))).toString("utf8"));
      if (mtimeOf() === stamp) cache = { mtime: stamp, profiles: structuredClone(profiles) };
    } catch (err) {
      logger(`profileStore.preload(): ${err.message}`);
    }
  }

  return {
    preload,
    load,
    save,
    add({ name, link, subscriptionId }) {
      const profiles = load();
      const id = randomUUID();
      profiles.push(subscriptionId ? { id, name, link, subscriptionId } : { id, name, link });
      save(profiles);
      return id;
    },
    remove(id) {
      save(load().filter((p) => p.id !== id));
    },
    update(id, { name, link }) {
      const profiles = load();
      const profile = profiles.find((p) => p.id === id);
      if (!profile) return;
      if (name !== undefined) profile.name = name;
      if (link !== undefined) profile.link = link;
      save(profiles);
    },
  };
}
