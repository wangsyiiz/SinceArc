const TURN_PLACEHOLDER_PREFIX = "turn-live-";

/** 占位 id 只做本地 key；拿到后端返回值后必须替换。 */
export function isPlaceholderTurnId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(TURN_PLACEHOLDER_PREFIX);
}

/** 落库前再过滤一次：后端 turn id 是唯一可持久化的来源。 */
export function turnIdForPersist(id: string | null | undefined): string | null {
  return typeof id === "string" && id.length > 0 && !isPlaceholderTurnId(id) ? id : null;
}

export function replaceTurnId<T extends { id: string }>(
  turns: T[],
  placeholder: string,
  realId: string,
): T[] {
  if (placeholder === realId || !isPlaceholderTurnId(placeholder) || isPlaceholderTurnId(realId)) {
    return turns;
  }
  return turns.map((turn) => (turn.id === placeholder ? { ...turn, id: realId } : turn));
}
