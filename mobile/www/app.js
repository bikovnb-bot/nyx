// Nyx for Android: the user interface and its glue. The parsing, config building
// and helpers come from NyxCore (the same modules the desktop app uses).
(function () {
  const $ = (id) => document.getElementById(id);
  const vpn = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.NyxVpn;
  const core = window.NyxCore;
  const ClipboardPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Clipboard;

  // The WebView's own clipboard API is refused without a permission prompt, so the
  // native plugin is used, with the browser one as a fallback.
  async function clipRead() {
    if (ClipboardPlugin) {
      const r = await ClipboardPlugin.read();
      return r && r.value ? r.value : "";
    }
    return navigator.clipboard.readText();
  }
  async function clipWrite(text) {
    if (ClipboardPlugin) return ClipboardPlugin.write({ string: text });
    return navigator.clipboard.writeText(text);
  }

  // ------------------------------------------------------------------ storage
  const DEFAULTS = {
    profiles: [],            // { id, name, link, subscriptionId? }
    favorites: [],
    lastProfileId: null,
    stats: { days: {}, profiles: {} },
    subscriptions: [],       // { id, url, name, updatedAt }
    settings: {
      theme: "dark",
      dns: { provider: "cloudflare", custom: "" },
      routing: { directRu: false, blockAds: false },
      fragment: false,
      autoBest: false,
      apps: { mode: "all", exclude: [], include: [] },
    },
  };
  let data = load();

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem("nyx.data") || "null");
      if (raw) return merge(JSON.parse(JSON.stringify(DEFAULTS)), raw);
    } catch (e) {}
    return JSON.parse(JSON.stringify(DEFAULTS));
  }
  function merge(base, patch) {
    for (const k of Object.keys(patch)) {
      if (patch[k] && typeof patch[k] === "object" && !Array.isArray(patch[k]) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) merge(base[k], patch[k]);
      else base[k] = patch[k];
    }
    return base;
  }
  function save() {
    try { localStorage.setItem("nyx.data", JSON.stringify(data)); } catch (e) {}
  }

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function toast(text, kind = "", ms = 2600) {
    const el = document.createElement("div");
    el.className = "toast " + kind;
    el.textContent = text;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  // ------------------------------------------------------------------ theme
  function applyTheme(mode) {
    const light = mode === "light" || (mode === "system" && window.matchMedia("(prefers-color-scheme: light)").matches);
    document.documentElement.setAttribute("data-theme", light ? "light" : "dark");
    try { localStorage.setItem("nyxTheme", mode); } catch (e) {}
    document.querySelectorAll("#themeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.themeMode === mode));
  }

  // ------------------------------------------------------------------ VPN state
  let state = "stopped";
  let startedAt = 0;
  let ticker = null;

  function renderState(s, error) {
    state = s;
    document.body.dataset.state = s;
    const names = { stopped: "Отключено", starting: "Подключение…", started: "Защищено", stopping: "Отключение…", error: "Ошибка" };
    $("status").textContent = names[s] || s;
    if (s === "started") {
      if (!startedAt) startedAt = Date.now();
      if (!ticker) ticker = setInterval(renderSub, 1000);
    } else {
      startedAt = 0;
      if (ticker) { clearInterval(ticker); ticker = null; }
    }
    trafficOn(s === "started");
    if (s === "error") showIssue(error);
    else if (s === "starting" || s === "stopped") showIssue(null);
    renderSub(error);
    renderList();
  }

  function renderSub(error) {
    const p = currentProfile();
    let text = "";
    if (state === "started") {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      const t = [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60].map((n) => String(n).padStart(2, "0")).join(":");
      text = (p ? p.name + " · " : "") + t;
    } else if (state === "stopped") {
      text = p ? "Готов подключиться: " + p.name : "Добавьте сервер, чтобы начать";
    }
    $("sub").textContent = text;
  }

  function showIssue(error) {
    const box = $("issue");
    if (!error) { box.hidden = true; return; }
    const hint = core.explainSingBoxLine("FATAL " + error) || { title: "Не удалось подключиться", hint: String(error).slice(0, 200) };
    $("issueTitle").textContent = hint.title;
    $("issueHint").textContent = hint.hint;
    box.hidden = false;
  }

  // ------------------------------------------------------------------ profiles
  function currentProfile() {
    return data.profiles.find((p) => p.id === data.lastProfileId) || data.profiles[0] || null;
  }

  function addLinks(text) {
    const known = new Set(data.profiles.map((p) => core.linkKey(p.link)));
    let added = 0, skipped = 0;
    const lines = text.split(/\s+/).filter(Boolean);
    for (const raw of lines) {
      if (!raw.startsWith("vless://")) { skipped++; continue; }
      try { core.parseVlessLink(raw); } catch (e) { skipped++; continue; }
      const key = core.linkKey(raw);
      if (known.has(key)) continue;
      known.add(key);
      data.profiles.push({ id: uid(), name: core.nameFromLink(raw), link: raw });
      added++;
    }
    return { added, skipped };
  }

  async function addSubscription(url) {
    const res = await fetch(url, { headers: { "User-Agent": "Nyx-Android" } });
    if (!res.ok) throw new Error("Сервер подписки ответил " + res.status);
    const body = await res.text();
    const parsed = core.parseSubscription(body);
    const links = parsed.links;
    if (!links.length) throw new Error("В подписке нет ссылок vless://");
    let sub = data.subscriptions.find((s) => s.url === url);
    if (!sub) {
      let name = url;
      try { name = new URL(url).hostname; } catch (e) {}
      sub = { id: uid(), url, name, updatedAt: 0 };
      data.subscriptions.push(sub);
    }
    const existing = data.profiles.filter((p) => p.subscriptionId === sub.id);
    const otherKeys = new Set(data.profiles.filter((p) => p.subscriptionId !== sub.id).map((p) => core.linkKey(p.link)));
    const plan = core.planSubscriptionSync(existing, links, otherKeys);
    const removeIds = new Set(plan.toRemoveIds);
    data.profiles = data.profiles.filter((p) => !removeIds.has(p.id));
    for (const item of plan.toAdd) data.profiles.push({ id: uid(), name: item.name, link: item.link, subscriptionId: sub.id });
    for (const u of plan.toUpdate) {
      const p = data.profiles.find((x) => x.id === u.id);
      if (p) p.link = u.link;
    }
    sub.updatedAt = Date.now();
    save();
    return plan.toAdd.length;
  }

  // ------------------------------------------------------------------ list
  function typeTag(link) {
    try {
      const p = core.parseVlessLink(link);
      return p.security === "reality" ? ["REALITY", "reality"] : p.security === "tls" ? ["TLS", ""] : [p.type.toUpperCase(), ""];
    } catch (e) { return ["?", ""]; }
  }

  function renderList() {
    const profiles = core.sortWithFavorites(data.profiles, data.favorites);
    const active = state === "started" || state === "starting" ? data.lastProfileId : null;
    $("count").textContent = profiles.length ? String(profiles.length) : "";
    $("empty").hidden = profiles.length > 0;
    $("list").innerHTML = profiles.map((p) => {
      const cc = core.profileCountryCode(p);
      const flag = cc && core.AVAILABLE_FLAGS.has(cc) ? `<img class="flag" src="flags/${esc(cc)}.svg" alt="" />` : `<div class="flag none">🌐</div>`;
      const [tag, cls] = typeTag(p.link);
      const fav = data.favorites.includes(p.id);
      return `<div class="item ${p.id === active ? "active" : ""}" data-id="${esc(p.id)}">
        ${flag}
        <div class="name"><b>${esc(p.name)}</b><small>${esc(core.hostOf(p.link))}</small></div>
        <span class="tag ${cls}">${esc(tag)}</span>
        <button class="star ${fav ? "on" : ""}" data-fav="${esc(p.id)}" aria-label="Избранное"><svg viewBox="0 0 24 24" fill="${fav ? "currentColor" : "none"}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.9L12 17.8 5.8 21l1.2-6.9-5-4.9 6.9-1z"/></svg></button>
        <button class="more" data-more="${esc(p.id)}" aria-label="Меню">⋮</button>
      </div>`;
    }).join("");
  }

  $("list").addEventListener("click", (e) => {
    const fav = e.target.closest("[data-fav]");
    if (fav) { toggleFav(fav.dataset.fav); return; }
    const more = e.target.closest("[data-more]");
    if (more) { openItemSheet(more.dataset.more); return; }
    const item = e.target.closest(".item");
    if (item) connect(item.dataset.id);
  });

  function toggleFav(id) {
    data.favorites = data.favorites.includes(id) ? data.favorites.filter((x) => x !== id) : [...data.favorites, id];
    save();
    renderList();
  }

  // ------------------------------------------------------------------ connect
  // Picks the server with the shortest TCP connect time (measured outside the tunnel).
  async function bestProfile() {
    const targets = data.profiles.map((p) => {
      try { const x = core.parseVlessLink(p.link); return { id: p.id, host: x.host, port: x.port }; } catch (e) { return null; }
    }).filter(Boolean);
    if (targets.length < 2) return null;
    const res = (await vpn.pingServers({ targets })).results.filter((r) => r.ms != null).sort((a, b) => a.ms - b.ms);
    return res.length ? { id: res[0].id, ms: res[0].ms } : null;
  }

  async function connect(id, auto) {
    if (auto && data.settings.autoBest && vpn && state !== "starting") {
      renderState("starting");
      const best = await bestProfile();
      if (best) { id = best.id; toast("Лучший сервер: " + best.ms + " мс", "success"); }
      renderState("stopped");
    }
    const profile = data.profiles.find((p) => p.id === id) || currentProfile();
    if (!profile) { openSheet("addSheet"); return; }
    if (!vpn) { toast("VPN-служба недоступна", "error"); return; }
    if (state === "starting" || state === "stopping") return;
    data.lastProfileId = profile.id;
    save();
    try {
      if (state === "started") {
        await vpn.stop();
        await waitFor("stopped", 6000);
      }
      const s = data.settings;
      let rulesDir;
      if (s.routing.directRu || s.routing.blockAds) rulesDir = (await vpn.prepareRules()).dir;
      const { config } = core.buildMobileConfig(profile.link, { dns: s.dns, routing: s.routing, fragment: s.fragment, rulesDir });
      renderState("starting");
      await vpn.start({
        config: JSON.stringify(config),
        name: profile.name,
        includePackages: s.apps.mode === "include" ? s.apps.include : [],
        excludePackages: s.apps.mode === "exclude" ? s.apps.exclude : [],
      });
    } catch (err) {
      renderState("error", err && err.message ? err.message : String(err));
    }
  }

  function waitFor(target, ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (state === target || Date.now() - t0 > ms) { clearInterval(iv); resolve(); }
      }, 100);
    });
  }

  $("power").addEventListener("click", async () => {
    if (state === "started") { if (vpn) await vpn.stop(); return; }
    connect(data.lastProfileId, true);
  });

  // ------------------------------------------------------------------ sheets
  function openSheet(id) {
    $("backdrop").classList.add("open");
    $(id).classList.add("open");
  }
  function closeSheets() {
    $("backdrop").classList.remove("open");
    document.querySelectorAll(".sheet").forEach((s) => s.classList.remove("open"));
  }
  $("backdrop").addEventListener("click", closeSheets);
  $("addBtn").addEventListener("click", () => { $("addText").value = ""; openSheet("addSheet"); });

  $("pasteBtn").addEventListener("click", async () => {
    try { $("addText").value = await clipRead(); if (!$("addText").value) toast("Буфер обмена пуст", "error"); }
    catch (e) { toast("Не удалось прочитать буфер: вставьте вручную", "error"); }
  });

  $("addConfirm").addEventListener("click", async () => {
    const text = $("addText").value.trim();
    if (!text) { toast("Вставьте ссылку", "error"); return; }
    try {
      if (/^https?:\/\//i.test(text)) {
        const n = await addSubscription(text.split(/\s+/)[0]);
        toast("Подписка добавлена: " + n + " серверов", "success", 3200);
      } else {
        const { added, skipped } = addLinks(text);
        if (!added) { toast(skipped ? "Это не ссылка vless://" : "Эти серверы уже добавлены", "error"); return; }
        save();
        toast("Добавлено серверов: " + added, "success");
      }
      closeSheets();
      renderList();
      renderSubs();
    } catch (e) {
      toast("Не получилось: " + (e && e.message ? e.message : e), "error", 4200);
    }
  });

  let sheetProfileId = null;
  function openItemSheet(id) {
    const p = data.profiles.find((x) => x.id === id);
    if (!p) return;
    sheetProfileId = id;
    $("itemTitle").textContent = p.name;
    $("itemFav").textContent = data.favorites.includes(id) ? "Убрать из избранного" : "В избранное";
    openSheet("itemSheet");
  }
  $("itemConnect").addEventListener("click", () => { closeSheets(); connect(sheetProfileId); });
  $("itemFav").addEventListener("click", () => { toggleFav(sheetProfileId); closeSheets(); });
  $("itemCopy").addEventListener("click", async () => {
    const p = data.profiles.find((x) => x.id === sheetProfileId);
    try { await clipWrite(p.link); toast("Ссылка скопирована", "success"); }
    catch (e) { toast("Не удалось скопировать", "error"); }
    closeSheets();
  });
  let confirmDelete = false;
  $("itemDelete").addEventListener("click", () => {
    if (!confirmDelete) {
      confirmDelete = true;
      $("itemDelete").textContent = "Нажмите ещё раз, чтобы удалить";
      setTimeout(() => { confirmDelete = false; $("itemDelete").textContent = "Удалить"; }, 3000);
      return;
    }
    confirmDelete = false;
    $("itemDelete").textContent = "Удалить";
    data.profiles = data.profiles.filter((p) => p.id !== sheetProfileId);
    data.favorites = data.favorites.filter((x) => x !== sheetProfileId);
    if (data.lastProfileId === sheetProfileId) data.lastProfileId = null;
    save();
    closeSheets();
    renderList();
    renderSub();
  });

  // ------------------------------------------------------------------ settings
  function openScreen(id) { $(id).classList.add("open"); }
  function closeScreen(id) { $(id).classList.remove("open"); }
  $("openSettings").addEventListener("click", () => { renderSettings(); openScreen("settings"); });
  $("closeSettings").addEventListener("click", () => closeScreen("settings"));

  function renderSettings() {
    const s = data.settings;
    document.querySelectorAll("#themeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.themeMode === s.theme));
    document.querySelectorAll("#dnsSeg button").forEach((b) => b.classList.toggle("active", b.dataset.dns === s.dns.provider));
    document.querySelectorAll("#appModeSeg button").forEach((b) => b.classList.toggle("active", b.dataset.appmode === s.apps.mode));
    $("directRu").checked = s.routing.directRu;
    $("blockAds").checked = s.routing.blockAds;
    $("fragment").checked = s.fragment;
    $("autoBest").checked = !!s.autoBest;
    const list = s.apps.mode === "include" ? s.apps.include : s.apps.exclude;
    $("pickApps").hidden = s.apps.mode === "all";
    $("appCount").textContent = String(list.length);
    $("aboutText").textContent = "Nyx для Android · ядро sing-box · лицензия GPL-3.0. Изменения вступают в силу при следующем подключении.";
    renderSubs();
  }

  function changed(msg) {
    save();
    if (state === "started") toast(msg || "Сохранено. Применится при переподключении", "success", 3200);
  }

  $("themeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    data.settings.theme = b.dataset.themeMode;
    applyTheme(data.settings.theme);
    save();
  });
  $("dnsSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    data.settings.dns.provider = b.dataset.dns;
    renderSettings();
    changed();
  });
  $("directRu").addEventListener("change", (e) => { data.settings.routing.directRu = e.target.checked; changed(); });
  $("blockAds").addEventListener("change", (e) => { data.settings.routing.blockAds = e.target.checked; changed(); });
  $("autoBest").addEventListener("change", (e) => { data.settings.autoBest = e.target.checked; save(); });
  $("fragment").addEventListener("change", (e) => { data.settings.fragment = e.target.checked; changed(); });
  $("appModeSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    data.settings.apps.mode = b.dataset.appmode;
    renderSettings();
    changed();
  });
  window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => { if (data.settings.theme === "system") applyTheme("system"); });

  // ------------------------------------------------------------------ per-app routing
  let appCache = null;
  $("pickApps").addEventListener("click", async () => {
    const mode = data.settings.apps.mode;
    $("appsTitle").textContent = mode === "include" ? "Только эти через VPN" : "Эти мимо VPN";
    $("appList").innerHTML = '<p class="dim" style="padding:14px">Загружаю список…</p>';
    $("appSearch").value = "";
    openScreen("appsScreen");
    if (!appCache) {
      try { appCache = (await vpn.listApps()).apps.sort((a, b) => a.label.localeCompare(b.label, "ru")); }
      catch (e) { appCache = []; toast("Не удалось получить список приложений", "error"); }
    }
    renderApps();
  });
  function renderApps() {
    const mode = data.settings.apps.mode;
    const chosen = new Set(mode === "include" ? data.settings.apps.include : data.settings.apps.exclude);
    const q = $("appSearch").value.trim().toLowerCase();
    $("appList").innerHTML = (appCache || [])
      .filter((a) => !q || a.label.toLowerCase().includes(q) || a.package.toLowerCase().includes(q))
      .map((a) => `<label class="app-row"><span class="l"><img class="ico" data-pkg="${esc(a.package)}" alt="" /><span><b>${esc(a.label)}</b><small>${esc(a.package)}</small></span></span><input type="checkbox" data-pkg="${esc(a.package)}" ${chosen.has(a.package) ? "checked" : ""} /></label>`)
      .join("");
    observeIcons();
  }
  $("appSearch").addEventListener("input", renderApps);
  $("appList").addEventListener("change", (e) => {
    const pkg = e.target.dataset && e.target.dataset.pkg;
    if (!pkg) return;
    const key = data.settings.apps.mode === "include" ? "include" : "exclude";
    const set = new Set(data.settings.apps[key]);
    if (e.target.checked) set.add(pkg); else set.delete(pkg);
    data.settings.apps[key] = [...set];
    save();
  });
  $("closeApps").addEventListener("click", () => { closeScreen("appsScreen"); renderSettings(); });

  // ------------------------------------------------------------------ subscriptions
  function renderSubs() {
    $("subList").innerHTML = data.subscriptions.length
      ? data.subscriptions.map((s) => `<div class="sub-row"><span>${esc(s.name)}<small>${s.updatedAt ? "обновлена " + new Date(s.updatedAt).toLocaleString("ru-RU") : "не обновлялась"}</small></span><button data-rm="${esc(s.id)}">Удалить</button></div>`).join("")
      : '<p class="dim">Подписок нет. Добавьте адрес подписки кнопкой «+».</p>';
  }
  $("subList").addEventListener("click", (e) => {
    const id = e.target.dataset && e.target.dataset.rm;
    if (!id) return;
    data.subscriptions = data.subscriptions.filter((s) => s.id !== id);
    data.profiles = data.profiles.filter((p) => p.subscriptionId !== id);
    save();
    renderSubs();
    renderList();
  });
  $("syncSubs").addEventListener("click", async () => {
    if (!data.subscriptions.length) { toast("Подписок нет", "error"); return; }
    let ok = 0;
    for (const s of [...data.subscriptions]) {
      try { await addSubscription(s.url); ok++; } catch (e) { toast(s.name + ": " + e.message, "error", 3600); }
    }
    renderSubs();
    renderList();
    if (ok) toast("Подписки обновлены", "success");
  });

  // ------------------------------------------------------------------ QR scanner
  let scanStream = null;
  let scanRaf = 0;
  $("scanBtn").addEventListener("click", async () => {
    try {
      scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    } catch (e) {
      toast("Нет доступа к камере. Разрешите её в настройках приложения", "error", 4200);
      return;
    }
    closeSheets();
    const video = $("scanVideo");
    video.srcObject = scanStream;
    await video.play();
    openScreen("scanner");
    scanLoop();
  });
  function stopScan() {
    cancelAnimationFrame(scanRaf);
    if (scanStream) scanStream.getTracks().forEach((t) => t.stop());
    scanStream = null;
    closeScreen("scanner");
  }
  function scanLoop() {
    const video = $("scanVideo");
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const tick = () => {
      if (!scanStream) return;
      if (video.readyState >= 2 && window.jsQR) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (code && code.data) {
          stopScan();
          $("addText").value = code.data;
          openSheet("addSheet");
          toast("QR-код прочитан", "success");
          return;
        }
      }
      scanRaf = requestAnimationFrame(tick);
    };
    scanRaf = requestAnimationFrame(tick);
  }
  $("scanClose").addEventListener("click", stopScan);

  // ------------------------------------------------------------------ traffic and statistics
  // The core exposes its counters on a loopback HTTP port (Clash API); the totals
  // are polled once a second and turned into a speed, per-day and per-server sums.
  const CLASH = "http://127.0.0.1:9095/connections";
  let lastTotals = null;
  let pollTimer = null;
  let sessionBytes = 0;

  const fmtBytes = (n) => {
    const u = ["Б", "КБ", "МБ", "ГБ", "ТБ"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)) + " " + u[i];
  };
  const dayKey = (d = new Date()) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");

  async function pollTraffic() {
    try {
      const r = await fetch(CLASH);
      const j = await r.json();
      const down = j.downloadTotal || 0, up = j.uploadTotal || 0;
      if (lastTotals) {
        const dd = Math.max(0, down - lastTotals.down), du = Math.max(0, up - lastTotals.up);
        $("trDown").textContent = "↓ " + fmtBytes(dd) + "/с";
        $("trUp").textContent = "↑ " + fmtBytes(du) + "/с";
        sessionBytes += dd + du;
        $("trTotal").textContent = "Σ " + fmtBytes(sessionBytes);
        const day = (data.stats.days[dayKey()] = data.stats.days[dayKey()] || { up: 0, down: 0 });
        day.down += dd; day.up += du;
        const pid = data.lastProfileId;
        if (pid) {
          const pr = (data.stats.profiles[pid] = data.stats.profiles[pid] || { up: 0, down: 0 });
          pr.down += dd; pr.up += du;
        }
        statsDirty = true;
      }
      lastTotals = { down, up };
    } catch (e) { /* core not ready yet */ }
  }
  let statsDirty = false;
  setInterval(() => {
    if (statsDirty) {
      // keep ~90 days
      const keys = Object.keys(data.stats.days).sort();
      while (keys.length > 90) delete data.stats.days[keys.shift()];
      save();
      statsDirty = false;
    }
  }, 10000);

  function trafficOn(on) {
    $("traffic").hidden = !on;
    if (on && !pollTimer) { lastTotals = null; sessionBytes = 0; pollTimer = setInterval(pollTraffic, 1000); }
    if (!on && pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  let statsDays = 7;
  function renderStats() {
    const days = [];
    for (let i = statsDays - 1; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i);
      const v = data.stats.days[dayKey(d)] || { up: 0, down: 0 };
      days.push({ label: d.getDate(), up: v.up, down: v.down });
    }
    const totalUp = days.reduce((a, d) => a + d.up, 0), totalDown = days.reduce((a, d) => a + d.down, 0);
    $("statsTotals").innerHTML = `<span class="d">↓ ${fmtBytes(totalDown)}</span><span class="u">↑ ${fmtBytes(totalUp)}</span>`;
    const max = Math.max(1, ...days.map((d) => d.up + d.down));
    $("statsChart").innerHTML = days.map((d) => `<div class="col" title="${d.label}"><i class="u" style="height:${(d.up / max) * 100}%"></i><i class="d" style="height:${(d.down / max) * 100}%"></i></div>`).join("");
    const names = Object.fromEntries(data.profiles.map((p) => [p.id, p.name]));
    const rows = Object.entries(data.stats.profiles).map(([id, v]) => ({ name: names[id] || "удалённый сервер", total: v.up + v.down, up: v.up, down: v.down })).sort((a, b) => b.total - a.total);
    $("statsProfiles").innerHTML = rows.length
      ? rows.map((r) => `<div class="prof-row"><span>${esc(r.name)}</span><span>${fmtBytes(r.total)} <small>↓${fmtBytes(r.down)} ↑${fmtBytes(r.up)}</small></span></div>`).join("")
      : '<p class="dim">Данных пока нет: статистика копится, пока VPN включён.</p>';
  }
  $("openStats").addEventListener("click", () => { renderStats(); openScreen("statsScreen"); });
  $("closeStats").addEventListener("click", () => closeScreen("statsScreen"));
  $("statsPeriod").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    statsDays = Number(b.dataset.days);
    document.querySelectorAll("#statsPeriod button").forEach((x) => x.classList.toggle("active", x === b));
    renderStats();
  });

  // ------------------------------------------------------------------ leak check
  async function runLeakCheck() {
    const body = $("leakBody");
    body.innerHTML = '<p class="dim">Проверяю…</p>';
    $("leakAgain").disabled = true;
    let info = null;
    try {
      const r = await fetch(core.IP_INFO_URL);
      info = core.parseIpInfo(await r.json());
    } catch (e) { /* offline */ }
    $("leakAgain").disabled = false;
    const connected = state === "started";
    const p = currentProfile();
    let serverHost = null;
    try { serverHost = p ? core.parseVlessLink(p.link).host : null; } catch (e) {}
    let realIp = null;
    try { realIp = localStorage.getItem("nyx.realIp"); } catch (e) {}
    const verdict = core.leakVerdict({ connected, info, serverHost, realIp });
    if (info && !connected) { try { localStorage.setItem("nyx.realIp", info.ip); } catch (e) {} }
    const row = (k, v) => `<div class="r"><span>${esc(k)}</span><span>${esc(v || "—")}</span></div>`;
    body.innerHTML = row("VPN", connected ? "включён" + (p ? " · " + p.name : "") : "выключен") +
      row("Внешний IP", info && info.ip) +
      row("Страна", info && [info.country, info.city].filter(Boolean).join(", ")) +
      row("Провайдер", info && info.isp) +
      `<div class="verdict ${esc(verdict.level)}">${esc(verdict.text)}</div>` +
      `<p class="dim" style="margin-top:8px;font-size:11.5px">${esc(core.describeDns(data.settings))}</p>`;
  }
  $("openLeak").addEventListener("click", () => { openSheet("leakSheet"); runLeakCheck(); });
  $("leakAgain").addEventListener("click", runLeakCheck);
  $("leakClose").addEventListener("click", closeSheets);

  // ------------------------------------------------------------------ speed test
  let speedRunning = false;
  let speedAbort = null;
  const PHASE = { ping: ["Измеряю задержку…", 12], download: ["Измеряю загрузку…", 45], upload: ["Измеряю отдачу…", 80], done: ["Готово", 100] };
  const fmtRate = (v) => (v == null ? "—" : v >= 100 ? String(Math.round(v)) : v.toFixed(1));
  function renderSpeed(u) {
    $("spPing").textContent = u.ping == null ? "—" : Math.round(u.ping);
    $("spJitter").textContent = u.jitter == null ? "мс" : "мс ± " + u.jitter.toFixed(1);
    $("spDown").textContent = fmtRate(u.down);
    $("spUp").textContent = fmtRate(u.up);
    const ph = PHASE[u.phase];
    if (ph) { $("spStatus").textContent = ph[0]; $("spBar").style.width = ph[1] + "%"; }
  }
  async function startSpeed() {
    if (speedRunning) return;
    speedRunning = true;
    speedAbort = new AbortController();
    $("spStart").disabled = true;
    $("spPing").textContent = $("spDown").textContent = $("spUp").textContent = "—";
    $("speedRoute").textContent = state === "started" ? "Через VPN" : "Без VPN: напрямую через ваше соединение";
    // The WebView's own fetch can stream the body; the native-HTTP replacement cannot.
    const webFetch = window.CapacitorWebFetch || window.fetch.bind(window);
    const fetchFn = (url, init) => webFetch(url, { ...init, signal: speedAbort.signal, cache: "no-store" });
    try {
      const r = await core.runSpeedtest(fetchFn, { onUpdate: renderSpeed, isCancelled: () => speedAbort.signal.aborted });
      if (r.cancelled) $("spStatus").textContent = "Остановлено";
    } catch (e) {
      $("spStatus").textContent = speedAbort.signal.aborted ? "Остановлено" : "Нет связи с сервером теста";
      $("spBar").style.width = "0%";
    }
    speedRunning = false;
    $("spStart").disabled = false;
    $("spStart").textContent = "Повторить";
  }
  $("openSpeed").addEventListener("click", () => { openSheet("speedSheet"); startSpeed(); });
  $("spStart").addEventListener("click", startSpeed);
  $("spClose").addEventListener("click", () => { if (speedAbort) speedAbort.abort(); closeSheets(); });

  // ------------------------------------------------------------------ app icons in the picker
  const iconCache = {};
  let iconObserver = null;
  function observeIcons() {
    if (iconObserver) iconObserver.disconnect();
    iconObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const img = en.target;
        iconObserver.unobserve(img);
        const pkg = img.dataset.pkg;
        if (iconCache[pkg]) { img.src = iconCache[pkg]; continue; }
        vpn.appIcon({ package: pkg }).then((r) => { iconCache[pkg] = r.icon; img.src = r.icon; }).catch(() => {});
      }
    }, { root: $("appList"), rootMargin: "200px" });
    document.querySelectorAll("#appList img.ico").forEach((img) => iconObserver.observe(img));
  }

  // ------------------------------------------------------------------ boot
  applyTheme(data.settings.theme);
  renderList();
  renderSub();
  if (vpn) {
    vpn.addListener("status", (e) => renderState(e.state, e.error));
    vpn.status().then((e) => renderState(e.state, e.error));
  } else {
    renderState("stopped");
  }
})();
