import type { MessageKey } from "@/i18n/zh-CN";

/**
 * 权限请求的展示分类。
 *
 * 保留 ACP 的原始 kind（不做枚举化），这里只负责把已知取值映射成中文标签；
 * 未知或缺失一律归到「未分类」，不猜成更具体、更危险的类别。
 */
export function permissionKindKey(kind: string | null | undefined): MessageKey {
  switch (kind) {
    case "execute":
      return "permission.kind.execute";
    case "edit":
      return "permission.kind.edit";
    case "delete":
    case "move":
      return "permission.kind.deleteMove";
    case "read":
    case "search":
      return "permission.kind.read";
    default:
      return "permission.kind.uncategorized";
  }
}
