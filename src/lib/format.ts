export const now = () => new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

/** 旧版本写入库里的占位名；只用于迁移识别，不再作为新连接的显示名。 */
// i18n-ignore: 持久化历史数据值
export const LEGACY_DEFAULT_PROFILE_NAME = "新连接"; // i18n-ignore: 持久化历史数据值

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
  if (name && name !== LEGACY_DEFAULT_PROFILE_NAME) return name;
  const program = p.program?.trim() || "agent";
  const where =
    p.launch === "ssh" ? p.ssh?.host?.trim() || "ssh" : p.launch === "wsl" ? p.distro?.trim() || "wsl" : "本机"; // i18n-ignore: 调用点跨批次，保留显示值
  return `${program} · ${where}`;
}
