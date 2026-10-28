/**
 * 复制纯文本。WebView 不给 clipboard 权限时退回隐藏 textarea + execCommand。
 *
 * 只复制、不执行：安装指引里的 winget/scoop/gh 命令都走这里，绝不替用户起进程。
 */
export async function copyText(text: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}
