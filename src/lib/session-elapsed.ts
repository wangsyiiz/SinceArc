const pad = (value: number) => String(value).padStart(2, "0");

/** 会话累计时长：< 1h 用 m:ss，≥ 1h 用 h:mm:ss。 */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** 本地 HH:MM，用作 Tooltip 里的开始时刻。 */
export function clockHHMM(timestamp: number): string {
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
