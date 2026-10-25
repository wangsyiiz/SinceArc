export type AtomActor = "user" | "agent" | `member:${string}` | "system" | "tool";

/** 不可变、只追加的最低消息单位；块与消息都在运行时从它派生。 */
export interface Atom {
  id: string;
  sessionId: string;
  turnId: string | null;
  seq: number;
  at: number;
  actor: AtomActor;
  kind: string;
  schema: string;
  payload: unknown;
  refs: Record<string, string>;
  ext: Record<string, unknown>;
  source: "live" | "replay";
  truncated: boolean;
}

/** 只读取注册过的扩展命名空间；未知键留在 `atom.ext` 里，由调用方按需原样保存。 */
export function extValue<T>(atom: Atom, key: string, fallback: T): T {
  if (!key.startsWith("x.")) return fallback;
  const value = atom.ext[key];
  return value === undefined ? fallback : (value as T);
}

export function refOf(atom: Atom, name: string): string | undefined {
  const value = atom.refs[name];
  return typeof value === "string" ? value : undefined;
}
