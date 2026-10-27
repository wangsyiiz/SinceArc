import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import App from "./App";
import { i18n, initI18n } from "./i18n";
import { normalizeLanguage } from "./i18n/normalize";
import { blockNativeContextMenu } from "./lib/release-ui";
import "./styles.css";

// release 构建屏蔽 WebView2 的默认右键菜单（docs/desktop-ux.md §20）；dev 保留，排查要用「检查」。
if (import.meta.env.PROD) blockNativeContextMenu();

// 首帧语言：先按系统语言渲染，落库值在设置读回来之后由 App 覆盖（docs/i18n.md §2.1）。
initI18n(normalizeLanguage(navigator.language));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nextProvider i18n={i18n}>
      <App />
    </I18nextProvider>
  </StrictMode>,
);
