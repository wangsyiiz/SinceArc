/**
 * release 构建的窗口级行为（docs/desktop-ux.md §20）。
 *
 * Windows 上 WebView2 自带右键菜单：重新加载 / 另存为 / 打印 / 检查。
 * 桌面应用里露出来像浏览器，其中「重新加载」会把前端状态清空（标签、滚动位置），
 * 误触代价太大 —— release 一律屏蔽；dev 保留（排查时要用「检查」）。
 */
export function blockNativeContextMenu(target: EventTarget = document): void {
  target.addEventListener("contextmenu", (event) => event.preventDefault());
}
