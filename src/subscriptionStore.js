import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSecureJsonStore } from "./secureStore.js";

const MAX_NAME_LENGTH = 60;

// Subscriptions: [{ id, url, name, nameIsCustom, updatedAt, count, error, usage }].
// The URL is the secret, so the list lives in a DPAPI-encrypted file, not in
// settings.json. A name the user typed (nameIsCustom) is never replaced by the
// title the server sends; otherwise the server's title wins over the host name.
export function createSubscriptionStore(userDataDir, options = {}) {
  const store = createSecureJsonStore(path.join(userDataDir, "subscriptions.json"), { fallback: [], ...options });

  const list = () => {
    const v = store.load();
    return Array.isArray(v) ? v : [];
  };

  const cleanName = (name) => String(name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME_LENGTH);

  return {
    list,
    add({ url, name, custom = false }) {
      const items = list();
      const existing = items.find((s) => s.url === url);
      if (existing) return existing.id;
      const id = randomUUID();
      const typed = custom ? cleanName(name) : "";
      items.push({
        id,
        url,
        name: typed || name || url,
        nameIsCustom: !!typed,
        updatedAt: null,
        count: 0,
        error: null,
        usage: null,
      });
      store.save(items);
      return id;
    },
    remove(id) {
      store.save(list().filter((s) => s.id !== id));
    },
    patch(id, fields) {
      const items = list();
      const item = items.find((s) => s.id === id);
      if (!item) return;
      Object.assign(item, fields);
      store.save(items);
    },
    // The user's own name for it. An empty name is refused (returns false).
    rename(id, name) {
      const clean = cleanName(name);
      if (!clean) return false;
      const items = list();
      const item = items.find((s) => s.id === id);
      if (!item) return false;
      item.name = clean;
      item.nameIsCustom = true;
      store.save(items);
      return true;
    },
    // The title the server sent (Profile-Title): used unless the user named it.
    applyServerTitle(id, title) {
      const clean = cleanName(title);
      if (!clean) return false;
      const items = list();
      const item = items.find((s) => s.id === id);
      if (!item || item.nameIsCustom || item.name === clean) return false;
      item.name = clean;
      store.save(items);
      return true;
    },
  };
}
