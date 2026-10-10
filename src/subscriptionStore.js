import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSecureJsonStore } from "./secureStore.js";

// Subscriptions: [{ id, url, name, updatedAt, count, error }]. The URL is the
// secret, so the list lives in a DPAPI-encrypted file, not in settings.json.
export function createSubscriptionStore(userDataDir, options = {}) {
  const store = createSecureJsonStore(path.join(userDataDir, "subscriptions.json"), { fallback: [], ...options });

  const list = () => {
    const v = store.load();
    return Array.isArray(v) ? v : [];
  };

  return {
    list,
    add({ url, name }) {
      const items = list();
      const existing = items.find((s) => s.url === url);
      if (existing) return existing.id;
      const id = randomUUID();
      items.push({ id, url, name: name || url, updatedAt: null, count: 0, error: null });
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
  };
}
