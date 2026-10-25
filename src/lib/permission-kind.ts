/**
 * 权限请求的展示分类。
 *
 * 保留 ACP 的原始 kind（不做枚举化），这里只负责把已知取值映射成中文标签；
 * 未知或缺失一律归到「未分类」，不猜成更具体、更危险的类别。
 */
export function permissionKindLabel(kind: string | null | undefined): string {
  switch (kind) {
    case "execute":
      return "执行命令";
    case "edit":
      return "编辑文件";
    case "delete":
    case "move":
      return "删除/移动";
    case "read":
    case "search":
      return "读取";
    default:
      return "未分类";
  }
}
