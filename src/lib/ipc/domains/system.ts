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
