import { invokeCmd } from "../client";

/**
 * 在系统默认浏览器里打开外链。
 *
 * scheme 白名单（http / https / mailto）由后端判定 —— 这是第二道闸，前端那道的降级在
 * `src/lib/markdown.ts` 里。起进程是 fire-and-forget：成功拿不到「浏览器真的开了」，
 * 所以这里只在失败时 reject，调用方不要假装成功。
 */
export function openExternal(url: string): Promise<void> {
  return invokeCmd<void>("open_external", { url });
}

/**
 * 当前构建渠道（docs/distribution.md §13.4）：`store` = 微软商店包，`direct` = NSIS/便携。
 *
 * 后端从 Cargo feature `store` 回报，前端不信任何本地配置 —— 否则会出现
 * 「后端是商店版、前端以为是直装版」这种两边对不上的状态。
 */
export function buildChannel(): Promise<string> {
  return invokeCmd<string>("build_channel");
}

/**
 * 打开 Microsoft Store 里的产品页（商店版的「更新」入口）。
 *
 * 和 `openExternal` 分开：那个放行 http / https / mailto，而这里必须用 `ms-windows-store:`
 * 协议才能落到商店应用里。产品 ID 是编译期注入的，缺失时后端退回商店搜索页。
 */
export function openStoreUpdate(): Promise<void> {
  return invokeCmd<void>("open_store_update");
}
