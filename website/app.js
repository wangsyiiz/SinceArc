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

  /* ---------------- 语言 ---------------- */

  const ZH = {
    tagline: "面向 ACP agent 的 Windows 桌面客户端，把<em>过程</em>留在明处：思考与工具调用进轨迹泳道，而不是埋进聊天流里。",
    taglineZh: "对话只讲人话，过程进轨迹；两者靠锚点互跳，出了问题能回查。",
    ctaDownload: "下载 Windows 版",
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
