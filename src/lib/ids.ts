/**
 * 消息/事件 id。
 *
 * 以前是 `u-${Date.now()}`：同一毫秒里连发两条会拿到同一个 id，而落库是
 * `ON CONFLICT(id) DO UPDATE` —— 后一条把前一条覆盖掉（正是回答丢失那类事故的孪生兄弟）。
 * 现在 = 前缀 + 毫秒 + 进程内单调序号 + 随机后缀，同一毫秒也不会重复。
 */
let seq = 0;

export function newId(prefix: string): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${seq.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}
