  const $ = (id) => document.getElementById(id);
  const api = window.nyxInstaller;
  const CIRC = 2 * Math.PI * 64;
  let dir = "";
let stageName = "";

  function screen(name) {
    document.body.dataset.screen = name;
    document.body.dataset.busy = name === "install" ? "1" : "0";
  }

  function setUpdateMode(update) {
    $("wTitle").textContent = update ? "Обновление Nyx" : "Установка Nyx";
    $("install").textContent = update ? "Обновить" : "Установить";
    $("wSub").textContent = update
      ? "Nyx уже установлен в эту папку. Он будет обновлён, профили и настройки сохранятся."
      : "Приложение будет установлено в вашу папку пользователя. Права администратора не нужны.";
  }

  function setPct(p) {
    $("fg").style.strokeDashoffset = String(CIRC * (1 - p / 100));
    $("pct").textContent = p + "%";
    if (stageName === "download") return;
    $("stage").textContent = p < 56 ? "Подготавливаю…" : p < 92 ? "Устанавливаю компоненты…" : "Создаю ярлыки…";
  }

  async function init() {
    const info = await api.info();
    dir = info.dir;
    $("dir").textContent = dir;
    $("ver").textContent = "Nyx " + info.version;
    setUpdateMode(info.update);
  }

  function start() {
    setPct(0);
    screen("install");
    api.install(dir);
  }

  $("change").onclick = async () => {
    const res = await api.chooseDir(dir);
    if (res) { dir = res.dir; $("dir").textContent = dir; setUpdateMode(res.update); }
  };
  $("install").onclick = start;
  $("retry").onclick = () => screen("welcome");
  $("launch").onclick = async () => { await api.launch(); api.close(); };
  $("finish").onclick = () => api.close();
  $("giveup").onclick = () => api.close();
  $("min").onclick = () => api.minimize();
  $("close").onclick = () => api.close();

  api.on("progress", setPct);
  api.on("stage", (s) => {
    stageName = s;
    if (s === "download") $("stage").textContent = "Скачиваю Nyx…";
    if (s === "install") $("stage").textContent = "Устанавливаю компоненты…";
  });
  api.on("bytes", ({ got, total }) => {
    const mb = (n) => (n / 1048576).toFixed(0);
    $("stage").textContent = total ? `Скачиваю… ${mb(got)} из ${mb(total)} МБ` : `Скачиваю… ${mb(got)} МБ`;
  });
  api.on("done", () => setTimeout(() => screen("done"), 500));
  api.on("failed", (e) => { $("errMsg").textContent = e.message; screen("error"); });

  init();
