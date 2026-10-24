/**
 * 后端轨迹（`session_trace`）→ 轨迹面板的视图模型。
 *
 * 放在这里而不是面板里，是为了可测：这是纯映射，逻辑错了界面会「看起来还行但少一条」，
 * 只有用例能抓住。后端给的是「按轮 + 按 seq 的活动」，面板要的是「轮 + 每个 agent 一条支线」。
 */
import type { TraceTurnDto } from "./ipc/types";
import { MAIN_AGENT_ID } from "./main-agent.ts";
import type { Activity, ActivityKind, TraceTurn } from "@/types";

/** agent 的工具调用类型 → 面板的图标类别。 */
function activityKindOf(item: TraceTurnDto["items"][number]): ActivityKind | null {
  if (item.kind === "thought") return "thinking";
  if (item.kind === "permission") return "permission";
  if (item.kind === "tool_call") {
    const raw = String(item.payload.kind ?? "");
    if (raw === "edit" || raw === "execute" || raw === "read" || raw === "search") return raw;
    return "read";
  }
  // usage / mode 不进轨迹面板：它们是计量，不是「做了什么」
  return null;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function lineOf(value: unknown): number | undefined {
  const direct = numberOf(value);
  if (direct !== undefined) return direct;
  const obj = recordOf(value);
  return numberOf(obj?.line) ?? numberOf(obj?.lineNumber);
}

function locationPath(location: unknown): string | undefined {
  if (typeof location === "string") return stringOf(location);
  const loc = recordOf(location);
  return loc ? (stringOf(loc.path) ?? stringOf(loc.uri)) : undefined;
}

function locationLine(location: unknown): string | undefined {
  const path = locationPath(location);
  if (!path) return undefined;
  if (typeof location === "string") return path;

  const loc = recordOf(location);
  if (!loc) return path;
  const range = recordOf(loc.range);
  const start =
    numberOf(loc.line) ??
    numberOf(loc.startLine) ??
    lineOf(loc.start) ??
    lineOf(range?.start);
  const end = numberOf(loc.endLine) ?? lineOf(loc.end) ?? lineOf(range?.end);
  if (start === undefined) return path;
  return end === undefined || end === start ? `${path}:${start}` : `${path}:${start}-${end}`;
}

function permissionNames(payload: Record<string, unknown>): string[] {
  const options = Array.isArray(payload.options) ? payload.options : [];
  return options
    .map((option) => stringOf(recordOf(option)?.name))
    .filter((name): name is string => Boolean(name));
}

const BODY_SIDE_MAX_BYTES = 2 * 1024;

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function boundaryPrefix(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = utf8Bytes(char);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

function truncatedInfo(value: unknown): { bytes: number; preview?: string } | null {
  const obj = recordOf(value);
  if (!obj || obj.__truncated !== true) return null;
  return { bytes: numberOf(obj.bytes) ?? 0, preview: stringOf(obj.preview) };
}

function truncationLine(bytes: number): string {
  return `…已截断 ${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function rawInputValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

function rawInputLines(value: unknown): string[] {
  if (typeof value === "string") return value.split("\n");
  if (Array.isArray(value)) return value.map(rawInputValue);
  const obj = recordOf(value);
  if (obj) {
    return Object.entries(obj).map(([key, item]) => `${key}: ${rawInputValue(item)}`);
  }
  return [rawInputValue(value)];
}

function rawInputSide(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;

  const marker = truncatedInfo(value);
  const text = marker ? (marker.preview ?? "") : rawInputLines(value).join("\n");
  if (text.length === 0 && !marker) return undefined;

  const bytes = utf8Bytes(text);
  const clipped = bytes > BODY_SIDE_MAX_BYTES ? boundaryPrefix(text, BODY_SIDE_MAX_BYTES) : text;
  const line = marker
    ? truncationLine(marker.bytes)
    : bytes > BODY_SIDE_MAX_BYTES
      ? truncationLine(bytes)
      : undefined;
  return line ? [clipped, line].filter((part) => part.length > 0).join("\n") : clipped;
}

function rawInputFirstLine(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;

  const marker = truncatedInfo(value);
  const text = marker ? marker.preview : rawInputLines(value).join("\n");
  if (!text) return undefined;
  return text
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .find((line) => line.length > 0);
}

function contentLine(value: unknown): string | undefined {
  if (typeof value === "string") return stringOf(value);
  const obj = recordOf(value);
  if (!obj) return undefined;

  const type = stringOf(obj.type);
  const summary = stringOf(obj.name) ?? stringOf(obj.uri) ?? stringOf(obj.title);
  if (type) return summary ? `${type}: ${summary}` : type;
  return summary;
}

function contentSide(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;

  const marker = truncatedInfo(value);
  if (marker) {
    return [marker.preview ?? "", truncationLine(marker.bytes)]
      .filter((part) => part.length > 0)
      .join("\n");
  }
  if (typeof value === "string") return stringOf(value);
  if (!Array.isArray(value)) {
    const text = stringOf(recordOf(value)?.text);
    return text ?? contentLine(value);
  }

  const lines: string[] = [];
  let markerBytes: number | undefined;
  for (const entry of value) {
    const entryMarker = truncatedInfo(entry);
    if (entryMarker) {
      if (entryMarker.preview) lines.push(entryMarker.preview);
      markerBytes = entryMarker.bytes;
      continue;
    }
    const text = stringOf(recordOf(entry)?.text);
    if (text) {
      lines.push(text);
      continue;
    }
    const line = contentLine(entry);
    if (line) lines.push(line);
  }
  if (markerBytes !== undefined) lines.push(truncationLine(markerBytes));
  return lines.length > 0 ? lines.join("\n") : undefined;
}

/**
 * 卡片正文与列表摘要。
 * tool_call 的 `rawInput` / `content` 由后端 `trace.rs` 从 ACP 事件捕获，
 * 正文按 locations → rawInput → content 展开，摘要优先用 title。
 */
function summaryOf(item: TraceTurnDto["items"][number]): { body?: string; detail?: string } {
  const payload = (item.payload ?? {}) as Record<string, unknown>;

  if (item.kind === "thought") {
    // 后端 `trace.rs` 已按 8KB 截断；这里保留换行，不再二次切分。
    const body = stringOf(payload.text);
    const detail = body?.replace(/\s+/g, " ").trim().slice(0, 80) || undefined;
    return { body, detail };
  }

  if (item.kind === "tool_call" || item.kind === "tool_call_update") {
    const locations = Array.isArray(payload.locations) ? payload.locations : [];
    const lines = locations.map(locationLine).filter((line): line is string => Boolean(line));
    const sections = [lines.join("\n"), rawInputSide(payload.rawInput), contentSide(payload.content)]
      .filter((part): part is string => Boolean(part));
    const detailSource = stringOf(payload.title) ?? rawInputFirstLine(payload.rawInput);
    return {
      body: sections.length > 0 ? sections.join("\n") : undefined,
      detail: detailSource?.replace(/\s+/g, " ").trim().slice(0, 80) || undefined,
    };
  }

  if (item.kind === "permission") {
    const names = permissionNames(payload);
    return {
      body: names.length > 0 ? names.join("\n") : undefined,
      detail: names.length > 0 ? names.join(" / ") : undefined,
    };
  }

  return {};
}

function titleOf(item: TraceTurnDto["items"][number]): string {
  const p = item.payload as Record<string, unknown>;
  if (item.kind === "permission") {
    const tool = (p.toolCall ?? {}) as Record<string, unknown>;
    return `请求权限：${String(tool.title ?? "未知操作")}`;
  }
  if (item.kind === "thought") {
    const text = String(p.text ?? "").replace(/\s+/g, " ").trim();
    return text.length > 0 ? text.slice(0, 42) : "思考";
  }
  return String(p.title ?? "工具调用");
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export interface TraceView {
  turns: TraceTurn[];
  activities: Activity[];
}

/**
 * 转换。每个作者一条支线（多 agent 群聊各走各的），顺序保持后端给的 seq 顺序。
 *
 * 没有把「回答」放进支线：回答是对话正文，面板只画「思考与操作」——
 * 这也是把思考和工具调用移出聊天界面之后，它们唯一的落点。
 */
export function toTraceView(dtos: TraceTurnDto[]): TraceView {
  const activities: Activity[] = [];
  const turns: TraceTurn[] = [];

  // 后端按 startedAt 倒序给（最新的先），面板要正序读
  const ordered = [...dtos].sort((a, b) => a.startedAt - b.startedAt);

  for (const t of ordered) {
    const lanes = new Map<string, string[]>();
    // waiting_approval 只是「等用户批准」，这一轮还没结束：支线仍保持开放。
    const open = t.status === "running" || t.status === "waiting_approval";

    for (const item of t.items) {
      const kind = activityKindOf(item);
      if (!kind) continue;
      const summary = summaryOf(item);
      // 主 agent 没有 authorId（它就是「这个会话本身」），与聊天里的玩家表用同一个 id
      const playerId = item.authorId ?? MAIN_AGENT_ID;
      const id = `${t.id}-${item.seq}`;
      activities.push({
        id,
        playerId,
        kind,
        title: titleOf(item),
        detail: summary.detail,
        body: summary.body,
        truncated: item.truncated,
        at: clock(item.at),
        status:
          t.status === "failed" ? "error" : t.status === "cancelled" ? "cancelled" : "ok",
      });
      const list = lanes.get(playerId) ?? [];
      list.push(id);
      lanes.set(playerId, list);
    }

    turns.push({
      id: t.id,
      at: clock(t.startedAt),
      // 结局由抬头状态标签统一显示，不再把「已停止」拼进提问正文。
      userText: t.prompt,
      status: t.status as TraceTurn["status"],
      stopReason: t.stopReason,
      branches: [...lanes.entries()].map(([playerId, activityIds]) => ({
        playerId,
        activityIds,
        // 支线是否收尾由这一轮的状态决定；面板据此画实线/虚线
        reply: open ? undefined : "",
        status: open ? ("running" as const) : ("done" as const),
      })),
    });
  }

  return { turns, activities };
}
