import type { Activity } from "@/types";

export const now = () => new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
export const isWrite = (a: Activity) => a.kind === "edit" || a.kind === "execute";

/**
 * 连接的显示名。默认名「新连接」是 addProfile 的占位符，对所有连接都一样，
 * 显示出来等于没信息 —— 这种占位名一律换成「程序 · 位置」。
 */
export function profileLabel(p: {
  name?: string;
  program?: string;
  launch?: string;
  distro?: string | null;
  ssh?: { host?: string } | null;
}): string {
  const name = p.name?.trim();
  if (name && name !== "新连接") return name;
  const program = p.program?.trim() || "agent";
  const where =
    p.launch === "ssh" ? p.ssh?.host?.trim() || "ssh" : p.launch === "wsl" ? p.distro?.trim() || "wsl" : "本机";
  return `${program} · ${where}`;
}
