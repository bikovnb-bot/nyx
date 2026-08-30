import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

// Profiles carry a vless:// link — the embedded UUID is effectively a
// credential, so at rest it's encrypted (see codec below) rather than
// stored as plain JSON.
export function profileStorePath(userDataDir) {
  return path.join(userDataDir, "profiles.dat");
}

function legacyProfileStorePath(userDataDir) {
  return path.join(userDataDir, "profiles.json");
}

// Identity codec: used by default (and by tests) when no encryption is
// wired in. The Electron app passes a safeStorage-backed codec instead.
const plaintextCodec = {
  encode: (str) => Buffer.from(str, "utf8"),
  decode: (buf) => buf.toString("utf8"),
};

export function createProfileStore(userDataDir, codec = plaintextCodec) {
  const file = profileStorePath(userDataDir);

  function save(profiles) {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(file, codec.encode(JSON.stringify(profiles, null, 2)));
  }

  function load() {
    if (existsSync(file)) {
      try {
        return JSON.parse(codec.decode(readFileSync(file)));
      } catch (err) {
        console.error(`Failed to read profiles from ${file}: ${err.message}`);
        return [];
      }
    }

    // One-time migration from the old unencrypted profiles.json.
    const legacy = legacyProfileStorePath(userDataDir);
    if (existsSync(legacy)) {
      try {
        const profiles = JSON.parse(readFileSync(legacy, "utf8"));
        save(profiles);
        unlinkSync(legacy);
        return profiles;
      } catch (err) {
        console.error(`Failed to migrate legacy profiles from ${legacy}: ${err.message}`);
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
