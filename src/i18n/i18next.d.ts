import "i18next";
import type { zhCN } from "./zh-CN";

/**
 * `t()` 的 key 类型来自中文表（唯一事实源）：拼错的 key 是编译错误，不是运行时静默回落。
 * `keySeparator: false` 让点分 key 按字面量查，不做嵌套展开。
 */
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "app";
    keySeparator: false;
    nsSeparator: false;
    returnNull: false;
    resources: { app: typeof zhCN };
  }
}
