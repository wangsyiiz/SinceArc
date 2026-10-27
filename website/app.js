// SinceArc 官网的交互：主题切换、语言切换、亮暗对比滑块。
// 三件事都不引第三方库，状态只落在 localStorage。

(() => {
  const root = document.documentElement;
  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };

  /* ---------------- 主题 ---------------- */

  const themeBtn = document.getElementById("theme");

  function applyTheme(theme) {
    root.dataset.theme = theme;
    store.set("sincearc.theme", theme);
    themeBtn.setAttribute("aria-label", theme === "dark" ? "Switch to light theme" : "Switch to dark theme");
    themeBtn.setAttribute("aria-pressed", String(theme === "light"));
  }

  // 首屏前已经用内联脚本定过；这里只补上按钮文案
  applyTheme(root.dataset.theme === "light" ? "light" : "dark");

  themeBtn.addEventListener("click", () => {
    applyTheme(root.dataset.theme === "light" ? "dark" : "light");
  });

  /* ---------------- 下载按钮：默认项直接下载，右侧下拉换包 ---------------- */

  const VERSION = "0.0.0";
  const REL = "https://github.com/wangsyiiz/SinceArc/releases/latest/download/";

  // 只列真实存在的产物。没有构建的平台不放进菜单——给不存在的链接比给不出下载更糟。
  const ARTIFACTS = [
    { id: "win-x64-zip", file: `SinceArc-${VERSION}-win-x64.zip`, size: "3.7 MB", kind: { en: "Portable zip", zh: "便携 zip" } },
    { id: "win-x64-setup", file: `SinceArc_${VERSION}_x64-setup.exe`, size: "2.9 MB", kind: { en: "Installer (.exe)", zh: "安装包 (.exe)" } },
  ];

  const dlMain = document.getElementById("dlMain");
  const dlLabel = document.getElementById("dlLabel");
  const dlSub = document.getElementById("dlSub");
  const dlMore = document.getElementById("dlMore");
  const dlMenu = document.getElementById("dlMenu");
  const docLink = document.getElementById("docLink");

  const isZh = () => document.documentElement.lang.startsWith("zh");
  const pick = (v) => (typeof v === "string" ? v : v[isZh() ? "zh" : "en"]);

  let chosenId = null;
  try {
    chosenId = localStorage.getItem("sincearc.download");
  } catch {}
  const current = () => ARTIFACTS.find((a) => a.id === chosenId) ?? ARTIFACTS[0];

  // 副标题：平台 · 架构 · 版本（放在按钮主文案下面，同一颗按钮里）
  const SUBTITLE = { en: `Windows 10/11 · x64 · v${VERSION}`, zh: `Windows 10/11 · x64 · v${VERSION}` };

  function checkIcon() {
    return `<svg class="dl-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function renderMenu() {
    const cur = current();
    dlMenu.innerHTML =
      `<div class="dl-group">Windows x64</div>` +
      ARTIFACTS.map(
        (a) => `
      <button class="dl-item" role="menuitemradio" type="button" data-id="${a.id}" aria-checked="${a.id === cur.id}">
        <span class="dl-item-body">
          <span class="dl-item-title">${pick(a.kind)}</span>
          <span class="dl-item-note">${a.size} · ${a.file.split(".").pop()}</span>
        </span>
        ${checkIcon()}
      </button>`,
      ).join("");
  }

  function renderDownload() {
    const item = current();
    dlLabel.textContent = isZh() ? "下载 Windows 版" : "Download for Windows";
    dlSub.textContent = pick(SUBTITLE);
    dlMain.href = REL + item.file;
    dlMain.setAttribute("download", item.file);
    dlMore.setAttribute("aria-label", isZh() ? "其他安装包" : "Other downloads");
    if (docLink) {
      docLink.textContent = isZh() ? "读文档" : "Docs";
      docLink.href = isZh()
        ? "https://github.com/wangsyiiz/SinceArc/blob/master/README.zh-CN.md"
        : "https://github.com/wangsyiiz/SinceArc/blob/master/README.md";
    }
    renderMenu();
  }

  function openMenu(open) {
    dlMenu.hidden = !open;
    dlMore.setAttribute("aria-expanded", String(open));
    if (open) dlMenu.querySelector('[aria-checked="true"]')?.focus();
  }

  dlMore.addEventListener("click", () => openMenu(dlMenu.hidden));

  // 主按钮就是下载：点一次直接下当前默认包，不经过任何中间态
  dlMain.addEventListener("click", () => openMenu(false));

  dlMenu.addEventListener("click", (e) => {
    const btn = e.target.closest(".dl-item");
    if (!btn) return;
    chosenId = btn.dataset.id;
    try {
      localStorage.setItem("sincearc.download", chosenId);
    } catch {}
    renderDownload();
    openMenu(false);
    dlMore.focus();
  });

  dlMenu.addEventListener("keydown", (e) => {
    const items = [...dlMenu.querySelectorAll(".dl-item")];
    const i = items.indexOf(document.activeElement);
    if (e.key === "Escape") {
      openMenu(false);
      dlMore.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      items[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      items[(i - 1 + items.length) % items.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      items[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      items.at(-1)?.focus();
    }
  });

  document.addEventListener("pointerdown", (e) => {
    if (!dlMenu.hidden && !dlMenu.contains(e.target) && !dlMore.contains(e.target)) openMenu(false);
  });

  renderDownload();

  /* ---------------- 语言 ---------------- */

  const ZH = {
    tagline: "面向 ACP agent 的 Windows 桌面客户端，把<em>过程</em>留在明处：思考与工具调用进轨迹泳道，而不是埋进聊天流里。",
    dlMain: "下载 Windows 版",
    dlAll: "全部版本",
    ctaSource: "源码",
    ctaDocs: "读文档",
    tagDark: "暗色",
    tagLight: "亮色",
    whyTitle: "为什么再造一个客户端",
    why1Title: "过程与正文分离",
    why1Body:
      "回答留在对话里；思考、工具调用、权限请求进轨迹面板。两者靠锚点互跳，「它当时为什么这么干」永远查得到。",
    why2Title: "本地优先",
    why2Body: "会话、轨迹、设置都在 %APPDATA%\\com.sincearc.app，不上传；没有账号也能用完整功能。",
    why3Title: "多 agent 聚合，管在一处",
    why3Body:
      "几个 CLI agent、群聊成员和它们的会话都在同一条时间轴上。<code>@</code> 一个成员就让它单开支线并行跑，答完弯回主干——不用在几个终端窗口之间来回搬上下文，也不用分别去翻「刚才那个 agent 干了什么」。",
    why4Title: "GitHub 桌面客户端",
    why4Body: "把 PR、issue、评审搬进同一个窗口，agent 通过 ACP 参与评论与改动。目前只有设计稿，还没有可安装的版本。",
    plannedChip: "规划中",
  };

  // 英文取自页面初始 HTML，切换回来时用它复原，避免两处维护
  const EN = {};
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    EN[el.dataset.i18n] = el.innerHTML.trim();
  });

  const langBtn = document.getElementById("lang");

  function applyLang(lang) {
    const dict = lang === "zh" ? ZH : EN;
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const text = dict[el.dataset.i18n];
      if (typeof text === "string") el.innerHTML = text;
    });
    root.lang = lang === "zh" ? "zh-CN" : "en";
    langBtn.textContent = lang === "zh" ? "EN" : "中文";
    langBtn.setAttribute("aria-label", lang === "zh" ? "Switch to English" : "Switch to Chinese");
    store.set("sincearc.lang", lang);
    // 下载按钮的文案与下拉里的语言都要跟着换
    renderDownload();
  }

  applyLang(root.lang === "zh-CN" || root.lang === "zh" ? "zh" : "en");
  langBtn.addEventListener("click", () => {
    applyLang(root.lang.startsWith("zh") ? "en" : "zh");
  });

  /* ---------------- 亮暗对比滑块 ---------------- */

  const box = document.getElementById("compare");
  const MIN = 0;
  const MAX = 100;

  function setSplit(pct) {
    const v = Math.min(MAX, Math.max(MIN, pct));
    box.style.setProperty("--split", v.toFixed(2) + "%");
    box.setAttribute("aria-valuenow", String(Math.round(v)));
    return v;
  }

  function splitFromEvent(e) {
    const rect = box.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * 100;
  }

  let dragging = false;

  box.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    dragging = true;
    // 合成事件或已释放的 pointerId 会让 setPointerCapture 抛 NotFoundError，
    // 捕获失败也不该拖不动——拖拽本身不依赖捕获。
    try {
      box.setPointerCapture(e.pointerId);
    } catch {}
    setSplit(splitFromEvent(e));
  });

  box.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    setSplit(splitFromEvent(e));
  });

  const stop = (e) => {
    if (!dragging) return;
    dragging = false;
    try {
      if (box.hasPointerCapture?.(e.pointerId)) box.releasePointerCapture(e.pointerId);
    } catch {}
  };

  box.addEventListener("pointerup", stop);
  box.addEventListener("pointercancel", stop);

  // 键盘可达：左右各 2%，Home / End 到两端，Shift 加速到 10%
  box.addEventListener("keydown", (e) => {
    const cur = Number(box.getAttribute("aria-valuenow")) || 50;
    const step = e.shiftKey ? 10 : 2;
    let next = null;
    if (e.key === "ArrowLeft") next = cur - step;
    else if (e.key === "ArrowRight") next = cur + step;
    else if (e.key === "Home") next = MIN;
    else if (e.key === "End") next = MAX;
    if (next === null) return;
    e.preventDefault();
    setSplit(next);
  });

  setSplit(50);
})();
