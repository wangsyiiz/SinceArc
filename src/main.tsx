import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { blockNativeContextMenu } from "./lib/release-ui";
import "./styles.css";

// release 构建屏蔽 WebView2 的默认右键菜单（docs/desktop-ux.md §20）；dev 保留，排查要用「检查」。
if (import.meta.env.PROD) blockNativeContextMenu();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
