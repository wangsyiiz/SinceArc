/**
 * 后端轨迹（`session_trace`）→ 轨迹面板的视图模型。
 *
 * 放在这里而不是面板里，是为了可测：这是纯映射，逻辑错了界面会「看起来还行但少一条」，
 * 只有用例能抓住。后端给的是「按轮 + 按 seq 的活动」，面板要的是「轮 + 每个 agent 一条支线」。
 */
import type { TraceTurnDto } from "./ipc/types";
import { MAIN_AGENT_ID } from "./main-agent.ts";
import { permissionKindLabel } from "./permission-kind.ts";
import type { Activity, ActivityKind, TraceTurn } from "@/types";
import { delegateCapsDetail as delegateCapsDetailText } from "./delegate-target.ts";

/** agent 的工具调用类型 → 面板的图标类别。 */
function activityKindOf(item: TraceTurnDto["items"][number]): ActivityKind | null {
  if (item.kind === "thought") return "thinking";
  if (item.kind === "permission") return "permission";
  if (item.kind === "permission_decision") return "permission";
  if (item.kind === "delegate" || item.kind === "delegate_result") return "delegate";
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

function delegateCapsDetail(payload: Record<string, unknown>): string | undefined {
  const context = stringOf(payload.context);
  if (context !== "inherited" && context !== "task_only") return undefined;
  // 档位必须带成因：「只带任务描述 · 这个 agent 没报 fork 能力」——这一步就是用户
  // 事后对得上「为什么这个 agent 带了上下文、那个没带」的地方（orchestration.md §3 落点②）。
  return delegateCapsDetailText(context, stringOf(payload.reason));
}

function delegateTargetName(payload: Record<string, unknown>): string {
  return stringOf(payload.targetName) ?? "成员";
}

function delegateResultTitle(targetName: string, payload: Record<string, unknown>): string {
  const elapsed = numberOf(payload.elapsedMs);
  return elapsed === undefined
    ? `${targetName} 回来了`
    : `${targetName} 回来了 · ${elapsed}ms`;
}

function delegateResultDetail(
  payload: Record<string, unknown>,
  fallback: string | undefined,
): string | undefined {
  if (stringOf(payload.status) !== "failed") return fallback;
  return stringOf(payload.stopReason) ?? stringOf(payload.reason) ?? "失败";
}

function delegateResultStatus(payload: Record<string, unknown>): Activity["status"] {
  const status = stringOf(payload.status);
  if (status === "failed") return "error";
  if (status === "finished") return "ok";
  return "running";
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

interface PermissionOptionMeta {
  optionKind?: string;
  toolKind?: string;
}

interface DecisionText {
  title: string;
  body?: string;
  detail?: string;
  verdict: "allow" | "reject";
}

function permissionOptionKey(id: string, label: string | undefined): string {
  return `${id}\u0000${label ?? ""}`;
}

/** 决策 payload 只有 optionId/label；回查此前出现的权限请求，才能显示「编辑文件」这类分类。 */
function rememberPermissionOptions(
  payload: Record<string, unknown>,
  result: Map<string, PermissionOptionMeta>,
): void {
  const toolKind = stringOf(recordOf(payload.toolCall)?.kind);
  const options = Array.isArray(payload.options) ? payload.options : [];
  for (const raw of options) {
    const option = recordOf(raw);
    const id = stringOf(option?.optionId);
    if (!id) continue;
    result.set(permissionOptionKey(id, stringOf(option?.name)), {
      optionKind: stringOf(option?.kind),
      toolKind,
    });
  }
}

function decisionTextOf(
  payload: Record<string, unknown>,
  options: Map<string, PermissionOptionMeta>,
): DecisionText {
  const optionId = stringOf(payload.optionId);
  const optionLabel = stringOf(payload.optionLabel);
  const note = stringOf(payload.note);
  const via = stringOf(payload.via);
  const meta = optionId
    ? options.get(permissionOptionKey(optionId, optionLabel))
    : undefined;
  // 新增记录带 verdict（前端按用户点的选项给），老记录没有字段时才走下面的推断
  const verdict = stringOf(payload.verdict);
  const reject =
    verdict === "reject" ||
    (verdict !== "allow" &&
      (optionId === undefined ||
        meta?.optionKind?.startsWith("reject") === true ||
        /reject|deny/i.test(`${optionId ?? ""} ${optionLabel ?? ""}`)));
  const category = meta?.toolKind ? permissionKindLabel(meta.toolKind) : null;
  const action = reject ? "拒绝" : via === "auto:edits" ? "自动批准" : "批准";
  const title = note
    ? `${action}（备注）`
    : category
      ? `${action} · ${category}`
      : action;
  const body = [
    optionLabel ? `选项：${optionLabel}` : undefined,
    note ? `备注：${note}` : undefined,
    via === "auto:edits" ? "方式：自动同意（编辑）" : "方式：用户",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
  const detail = (note ?? optionLabel ?? category ?? title).replace(/\s+/g, " ").trim().slice(0, 80);
  return { title, body, detail: detail || undefined, verdict: reject ? "reject" : "allow" };
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
function summaryOf(
  item: TraceTurnDto["items"][number],
  decision?: DecisionText,
): { body?: string; detail?: string } {
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

  if (item.kind === "permission_decision" && decision) {
    return { body: decision.body, detail: decision.detail };
  }

  if (item.kind === "delegate") {
    return { detail: delegateCapsDetail(payload) };
  }

  if (item.kind === "delegate_result") {
    return { detail: delegateResultDetail(payload, undefined) };
  }

  return {};
}

function titleOf(item: TraceTurnDto["items"][number], decision?: DecisionText): string {
  const p = item.payload as Record<string, unknown>;
  if (item.kind === "permission") {
    const tool = (p.toolCall ?? {}) as Record<string, unknown>;
    return `请求权限：${String(tool.title ?? "未知操作")}`;
  }
  if (item.kind === "thought") {
    const text = String(p.text ?? "").replace(/\s+/g, " ").trim();
    return text.length > 0 ? text.slice(0, 42) : "思考";
  }
  if (item.kind === "permission_decision" && decision) return decision.title;
  if (item.kind === "delegate") return `派活给 ${delegateTargetName(p)}`;
  if (item.kind === "delegate_result") return delegateResultTitle(delegateTargetName(p), p);
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
  const delegateSteps = new Map<
    string,
    { activity: Activity; detail?: string; targetName: string }
  >();

  // 后端按 startedAt 倒序给（最新的先），面板要正序读
  const ordered = [...dtos].sort((a, b) => a.startedAt - b.startedAt);

  for (const t of ordered) {
    const lanes = new Map<string, string[]>();
    const permissionOptions = new Map<string, PermissionOptionMeta>();
    // waiting_approval 只是「等用户批准」，这一轮还没结束：支线仍保持开放。
    const open = t.status === "running" || t.status === "waiting_approval";

    for (const item of t.items) {
      if (item.kind === "delegate_result") {
        const payload = recordOf(item.payload) ?? {};
        const handleId = stringOf(payload.handleId);
        const prior = handleId ? delegateSteps.get(handleId) : undefined;
        if (prior) {
          prior.activity.title = delegateResultTitle(prior.targetName, payload);
          prior.activity.detail = delegateResultDetail(payload, prior.detail);
          prior.activity.status = delegateResultStatus(payload);
          continue;
        }
      }

      const kind = activityKindOf(item);
      if (!kind) continue;
      const payload = recordOf(item.payload) ?? {};
      if (item.kind === "permission") {
        rememberPermissionOptions(payload, permissionOptions);
      }
      const decision =
        item.kind === "permission_decision"
          ? decisionTextOf(recordOf(item.payload) ?? {}, permissionOptions)
          : undefined;
      const summary = summaryOf(item, decision);
      // 主 agent 没有 authorId（它就是「这个会话本身」），与聊天里的玩家表用同一个 id
      const playerId = item.authorId ?? MAIN_AGENT_ID;
      const id = `${t.id}-${item.seq}`;
      const activity: Activity = {
        id,
        playerId,
        kind,
        title: titleOf(item, decision),
        detail: summary.detail,
        body: summary.body,
        decision: decision?.verdict,
        truncated: item.truncated,
        at: clock(item.at),
        status:
          item.kind === "delegate_result"
            ? delegateResultStatus(payload)
            : item.kind === "delegate"
              ? "running"
              : t.status === "failed"
                ? "error"
                : t.status === "cancelled"
                  ? "cancelled"
                  : "ok",
      };
      activities.push(activity);
      if (item.kind === "delegate") {
        const handleId = stringOf(payload.handleId);
        if (handleId) {
          delegateSteps.set(handleId, {
            activity,
            detail: summary.detail,
            targetName: delegateTargetName(payload),
          });
        }
      }
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
