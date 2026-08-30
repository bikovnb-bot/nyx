import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

export function profileStorePath(userDataDir) {
  return path.join(userDataDir, "profiles.json");
}

export function loadProfiles(userDataDir) {
  const file = profileStorePath(userDataDir);
  if (!existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    console.error(`Failed to read profiles from ${file}: ${err.message}`);
    return [];
  }
}

export function saveProfiles(userDataDir, profiles) {
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(profileStorePath(userDataDir), JSON.stringify(profiles, null, 2));
}

export function addProfile(userDataDir, { name, link }) {
  const profiles = loadProfiles(userDataDir);
  const id = Date.now().toString(36);
  profiles.push({ id, name, link });
  saveProfiles(userDataDir, profiles);
  return id;
}

export function removeProfile(userDataDir, id) {
  const profiles = loadProfiles(userDataDir).filter((p) => p.id !== id);
  saveProfiles(userDataDir, profiles);
}

export function updateProfile(userDataDir, id, { name, link }) {
  const profiles = loadProfiles(userDataDir);
  const profile = profiles.find((p) => p.id === id);
  if (!profile) return;
  if (name !== undefined) profile.name = name;
  if (link !== undefined) profile.link = link;
  saveProfiles(userDataDir, profiles);
}
