export interface SlashCommand {
  name: string;
  description?: string;
  hint?: string;
}

/** `/` 必须在开头（前面只能是空白）；返回 `/` 后的过滤串，不匹配则 null。 */
export function slashQuery(value: string): string | null {
  const match = /^[^\S\r\n]*\/([^\s]*)/.exec(value);
  return match ? match[1] : null;
}

/** `/` 全列；有字符时按 name 前缀过滤（不区分大小写），最多 100 条。 */
export function filterCommands<T extends { name: string }>(value: string, commands: T[]): T[] {
  const query = slashQuery(value);
  if (query === null) return [];
  const lower = query.toLowerCase();
  return commands
    .filter((command) => command.name.toLowerCase().startsWith(lower))
    .slice(0, 100);
}
