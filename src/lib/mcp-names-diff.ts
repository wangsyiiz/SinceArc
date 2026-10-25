export interface McpNamesDiff {
  removed: string[];
  added: string[];
}

/**
 * 两份生效名单的差集。输出保留各自输入里的首次出现顺序，
 * 方便界面稳定地只说「少了几条 / 多了几条」。
 */
export function diffMcpNames(
  oldNames: readonly string[],
  newNames: readonly string[],
): McpNamesDiff {
  const before = new Set(oldNames);
  const after = new Set(newNames);
  const seenRemoved = new Set<string>();
  const seenAdded = new Set<string>();
  const removed: string[] = [];
  const added: string[] = [];

  for (const name of oldNames) {
    if (after.has(name) || seenRemoved.has(name)) continue;
    seenRemoved.add(name);
    removed.push(name);
  }
  for (const name of newNames) {
    if (before.has(name) || seenAdded.has(name)) continue;
    seenAdded.add(name);
    added.push(name);
  }

  return { removed, added };
}

/**
 * B 口径：名单变少才提示重连。agent 把 MCP 工具登记在进程上，
 * 减少不会自动注销；增加会随下一次 load / new 生效。
 */
export function needsReconnect(
  oldNames: readonly string[],
  newNames: readonly string[],
): boolean {
  return diffMcpNames(oldNames, newNames).removed.length > 0;
}
