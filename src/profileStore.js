import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

export function profileStorePath(userDataDir) {
  return path.join(userDataDir, "profiles.json");
}

// A short-lived experiment stored profiles encrypted via Electron's
// safeStorage. That turned out to tie the encryption key to the specific
// build's signing identity — every auto-update (a new, differently-signed
// binary) made previously saved profiles undecryptable, i.e. it silently
// discarded the user's servers on every single update. Back to plain JSON;
// this path is only consulted once, best-effort, to migrate whatever an
// already-decryptable leftover file might still hold.
function legacyEncryptedStorePath(userDataDir) {
  return path.join(userDataDir, "profiles.dat");
}

const plaintextCodec = {
  encode: (str) => Buffer.from(str, "utf8"),
  decode: (buf) => buf.toString("utf8"),
};

export function createProfileStore(userDataDir, codec = plaintextCodec, logger = console.error) {
  const file = profileStorePath(userDataDir);

  function save(profiles) {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(file, JSON.stringify(profiles, null, 2));
  }

  function load() {
    logger(`profileStore.load(): file=${file} exists=${existsSync(file)}`);
    if (existsSync(file)) {
      try {
        const profiles = JSON.parse(readFileSync(file, "utf8"));
        logger(`profileStore.load(): parsed ${profiles.length} profile(s)`);
        return profiles;
      } catch (err) {
        logger(`Failed to read profiles from ${file}: ${err.message}`);
        return [];
      }
    }

    // One-time best-effort migration from the old encrypted profiles.dat.
    const legacy = legacyEncryptedStorePath(userDataDir);
    if (existsSync(legacy)) {
      try {
        const profiles = JSON.parse(codec.decode(readFileSync(legacy)));
        save(profiles);
        unlinkSync(legacy);
        return profiles;
      } catch (err) {
        logger(`Could not migrate legacy encrypted profiles from ${legacy}: ${err.message}`);
      }
    }

    return [];
  }

  return {
    load,
    save,
    add({ name, link }) {
      const profiles = load();
      const id = randomUUID();
      profiles.push({ id, name, link });
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
