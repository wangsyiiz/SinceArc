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
  }

  // 首屏前已经用内联脚本定过；这里只补上按钮文案
  applyTheme(root.dataset.theme === "light" ? "light" : "dark");

  themeBtn.addEventListener("click", () => {
    applyTheme(root.dataset.theme === "light" ? "dark" : "light");
  });

  /* ---------------- 下载按钮：按浏览器平台选默认包 ---------------- */

  const VERSION = "0.0.0";
  const REL = "https://github.com/wangsyiiz/SinceArc/releases/latest/download/";

  // 真实产物只有 Windows x64 两种；其余平台明写「未提供」，不做假链接。
  const ARTIFACTS = [
    {
      id: "win-x64-zip",
      os: "windows",
      arch: "x64",
      group: "win",
      title: { en: "Windows x64 · portable zip", zh: "Windows x64 · 便携 zip" },
      note: `SinceArc-${VERSION}-win-x64.zip · 3.7 MB`,
      href: `${REL}SinceArc-${VERSION}-win-x64.zip`,
      btn: { en: "Download for Windows", zh: "下载 Windows 版" },
    },
    {
      id: "win-x64-setup",
      os: "windows",
      arch: "x64",
      group: "win",
      title: { en: "Windows x64 · installer (.exe)", zh: "Windows x64 · 安装包 (.exe)" },
      note: `SinceArc_${VERSION}_x64-setup.exe · 2.9 MB`,
      href: `${REL}SinceArc_${VERSION}_x64-setup.exe`,
      btn: { en: "Download for Windows", zh: "下载 Windows 版" },
    },
    {
      id: "macos-arm64",
      os: "macos",
      arch: "arm64",
      group: "other",
      title: { en: "macOS (Apple silicon)", zh: "macOS（Apple 芯片）" },
      note: { en: "no build yet — build from source", zh: "暂无构建 —— 只能从源码编译" },
      disabled: true,
    },
    {
      id: "macos-x64",
      os: "macos",
      arch: "x64",
      group: "other",
      title: { en: "macOS (Intel)", zh: "macOS（Intel）" },
      note: { en: "no build yet — build from source", zh: "暂无构建 —— 只能从源码编译" },
      disabled: true,
    },
    {
      id: "linux-x64",
      os: "linux",
      arch: "x64",
      group: "other",
      title: { en: "Linux x64", zh: "Linux x64" },
      note: { en: "no build yet — build from source", zh: "暂无构建 —— 只能从源码编译" },
      disabled: true,
    },
    {
      id: "source",
      os: "any",
      arch: "any",
      group: "other",
      title: { en: "Source code (zip)", zh: "源代码 (zip)" },
      note: `v${VERSION} · Apache-2.0`,
      href: `https://github.com/wangsyiiz/SinceArc/archive/refs/tags/v${VERSION}.zip`,
      btn: { en: "Download source", zh: "下载源码" },
    },
  ];

  const dlMain = document.getElementById("dlMain");
  const dlMainLabel = document.getElementById("dlMainLabel");
  const dlMore = document.getElementById("dlMore");
  const dlMenu = document.getElementById("dlMenu");
  const dlMeta = document.getElementById("dlMeta");

  const isZh = () => document.documentElement.lang.startsWith("zh");
  const pick = (v) => (typeof v === "string" ? v : v[isZh() ? "zh" : "en"]);

  // 平台识别：优先 UA-CH（能拿到架构），降级到 UA 字符串
  const detected = { os: "unknown", arch: "unknown" };

  function detectFromUA() {
    const ua = navigator.userAgent;
    if (/Windows NT/i.test(ua)) detected.os = "windows";
    else if (/Mac OS X|Macintosh/i.test(ua)) detected.os = "macos";
    else if (/Linux|X11/i.test(ua)) detected.os = "linux";
    detected.arch = /arm64|aarch64/i.test(ua) ? "arm64" : "x64";
  }

  detectFromUA();

  if (navigator.userAgentData?.getHighEntropyValues) {
    navigator.userAgentData
      .getHighEntropyValues(["architecture", "bitness", "platform"])
      .then((v) => {
        if (v.platform === "Windows" || v.platform === "macOS" || v.platform === "Linux") {
          detected.os = v.platform.toLowerCase();
        }
        if (v.architecture === "arm") detected.arch = "arm64";
        else if (v.bitness === "64") detected.arch = "x64";
        renderDownload();
      })
      .catch(() => {});
  }

  function defaultArtifact() {
    return (
      ARTIFACTS.find((a) => a.os === detected.os && a.arch === detected.arch && !a.disabled) ??
      ARTIFACTS.find((a) => a.os === detected.os && !a.disabled) ??
      ARTIFACTS.find((a) => a.id === "source")
    );
  }

  let chosenId = null;
  try {
    chosenId = localStorage.getItem("sincearc.download");
  } catch {}
  const currentArtifact = () => ARTIFACTS.find((a) => a.id === chosenId) ?? defaultArtifact();

  const OS_LABEL = {
    windows: { en: "Windows 10/11", zh: "Windows 10/11" },
    macos: { en: "macOS", zh: "macOS" },
    linux: { en: "Linux", zh: "Linux" },
    unknown: { en: "Unknown platform", zh: "未知平台" },
  };

  // 副标题行：当前平台 / 架构 / 版本 / 包形态 / 体积
  // 平台与架构以「选中的产物」为准（用户可能手动切到别的平台），源码才回落到检测结果
  function metaLine(item) {
    const osKey = item.os !== "any" ? item.os : detected.os;
    const archKey = item.arch !== "any" ? item.arch : detected.arch;
    const os = pick(OS_LABEL[osKey]);
    const arch = archKey === "arm64" ? "arm64" : "x64";
    if (item.disabled || item.id === "source") {
      return isZh()
        ? `${os} · ${arch} · v${VERSION} · 暂无官方构建，只能从源码编译`
        : `${os} · ${arch} · v${VERSION} · no official build yet — build from source`;
    }
    const kind = item.id.endsWith("setup") ? (isZh() ? "安装包" : "installer") : isZh() ? "便携 zip" : "portable zip";
    const size = item.note.split(" · ").pop();
    return `${os} · ${arch} · v${VERSION} · ${kind} · ${size}`;
  }

  function checkIcon() {
    return `<svg class="dl-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5 10 17.5 19 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  function renderMenu() {
    const cur = currentArtifact();
    const win = ARTIFACTS.filter((a) => a.group === "win");
    const other = ARTIFACTS.filter((a) => a.group === "other");
    const row = (a) => `
      <button class="dl-item" role="menuitemradio" type="button" data-id="${a.id}"
              aria-checked="${a.id === cur.id}" aria-disabled="${a.disabled ? "true" : "false"}">
        <span class="dl-item-body">
          <span class="dl-item-title">${pick(a.title)}</span>
          <span class="dl-item-note">${pick(a.note)}</span>
        </span>
        ${checkIcon()}
      </button>`;
    dlMenu.innerHTML = `
      <div class="dl-group">${isZh() ? "Windows" : "Windows"}</div>
      ${win.map(row).join("")}
      <div class="dl-group">${isZh() ? "其他平台 / 源码" : "Other platforms / source"}</div>
      ${other.map(row).join("")}`;
  }

  function renderDownload() {
    const item = currentArtifact();
    dlMainLabel.textContent = pick(item.btn ?? ARTIFACTS.find((a) => a.id === "source").btn);
    if (item.href) {
      dlMain.href = item.href;
      dlMain.setAttribute("download", "");
      dlMain.removeAttribute("aria-disabled");
    } else {
      dlMain.href = "https://github.com/wangsyiiz/SinceArc/releases";
      dlMain.removeAttribute("download");
    }
    dlMeta.textContent = metaLine(item);
    dlMore.setAttribute("aria-label", isZh() ? "其他平台下载" : "Other downloads");
    renderMenu();
  }

  function openMenu(open) {
    dlMenu.hidden = !open;
    dlMore.setAttribute("aria-expanded", String(open));
    if (open) dlMenu.querySelector('[aria-checked="true"]')?.focus();
  }

  dlMore.addEventListener("click", () => openMenu(dlMenu.hidden));

  dlMenu.addEventListener("click", (e) => {
    const btn = e.target.closest(".dl-item");
    if (!btn || btn.getAttribute("aria-disabled") === "true") return;
    chosenId = btn.dataset.id;
    try {
      localStorage.setItem("sincearc.download", chosenId);
    } catch {}
    renderDownload();
    openMenu(false);
    dlMore.focus();
  });

  dlMenu.addEventListener("keydown", (e) => {
    const items = [...dlMenu.querySelectorAll('.dl-item:not([aria-disabled="true"])')];
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
    taglineZh: "对话只讲人话，过程进轨迹；两者靠锚点互跳，出了问题能回查。",
    dlMain: "下载 Windows 版",
    dlAll: "全部版本",
    ctaSource: "源码",
    ctaDocs: "读文档",
    showcaseTitle: "同一个窗口，两套主题",
    compareHint: "拖动中间的斜切滑块；聚焦后可用 ← → 键。",
    tagDark: "暗色",
    tagLight: "亮色",
    whyTitle: "为什么再造一个客户端",
    why1Title: "过程与正文分离",
    why1Body:
      "回答留在对话里；思考、工具调用、权限请求进轨迹面板。两者靠锚点互跳，「它当时为什么这么干」永远查得到。",
    why2Title: "本地优先",
    why2Body: "会话、轨迹、设置都在 %APPDATA%\\com.sincearc.app，不上传；没有账号也能用完整功能。",
    why3Title: "不替你处置数据",
    why3Body: "删除会话或文件必须显式授权；存储只做统计与提示，不自动动手。",
    notTitle: "它不是什么",
    not1: "<strong>只有 Windows x64。</strong>没有 macOS、Linux、ARM64 版本，也没有未验证的产物。",
    not2: "<strong>未签名。</strong>首次运行 SmartScreen 会提示一次，选「更多信息 → 仍要运行」。",
    not3: "<strong>还没有自动更新。</strong>升级靠手动下载新包。",
    not4: "<strong>轨迹翻页有限。</strong>面板一次只取 50 轮。",
    installTitle: "安装",
    install1: "从 Releases 下载便携 zip 或安装包 exe。",
    install2: "解压到真实目录（别在压缩包里直接双击），运行 SinceArc.exe。",
    install3: "需要 WebView2 运行时：Win11 与较新的 Win10 自带。",
    fine: "SinceArc 名称与图标不随代码授权，fork 必须改名换标。",
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
    langBtn.setAttribute("aria-label", lang === "zh" ? "Switch to English" : "切换到中文");
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
