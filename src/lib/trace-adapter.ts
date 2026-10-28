/**
 * 后端轨迹（`session_trace`）→ 轨迹面板的视图模型。
 *
 * 放在这里而不是面板里，是为了可测：这是纯映射，逻辑错了界面会「看起来还行但少一条」，
 * 只有用例能抓住。后端给的是「按轮 + 按 seq 的活动」，面板要的是「轮 + 每个 agent 一条支线」。
 */
import type { TraceTurnDto } from "./ipc/types";
import { MAIN_AGENT_ID } from "./main-agent.ts";
import { permissionKindKey } from "./permission-kind.ts";
import type { Activity, ActivityKind, TraceTurn } from "@/types";
import { delegateCapsDetail as delegateCapsDetailText } from "./delegate-target.ts";
import { isTurnCancelled } from "./turn-status.ts";
import { localizeText, translateKey } from "./i18n-text.ts";
import type { MessageKey } from "@/i18n/zh-CN";
import type { TFunction } from "i18next";

export interface TraceText {
  key: MessageKey;
  values?: Record<string, string | number | TraceText>;
}

export type TraceTextPart = string | TraceText;

export interface TraceActivity extends Activity {
  titleText?: TraceText;
  detailText?: TraceTextPart;
  bodyText?: TraceTextPart[];
}

function textOfPart(part: TraceTextPart): string {
  return typeof part === "string" ? part : part.key;
}

function textOfParts(parts: TraceTextPart[], separator = "\n"): string {
  return parts.map(textOfPart).join(separator);
}

function resolveTextValue(value: string | number | TraceText, t: TFunction): string | number {
  if (typeof value !== "object") return value;
  return translateKey(t, value.key, resolveTraceValues(value.values, t));
}

function resolveTraceValues(
  values: TraceText["values"],
  t: TFunction,
): Record<string, string | number> | undefined {
  if (!values) return undefined;
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [key, resolveTextValue(value, t)]),
  );
}

function resolveTextPart(part: TraceTextPart, t: TFunction): string {
  return typeof part === "string" ? part : translateKey(t, part.key, resolveTraceValues(part.values, t));
}

/** 把适配器挂上的文案元数据翻译成当前语言的 Activity；原始 agent 文本保持不变。 */
export function localizeTraceActivity(activity: TraceActivity, t: TFunction): Activity {
  return {
    ...activity,
    title: activity.titleText
      ? resolveTextPart(activity.titleText, t)
      : localizeText(activity.title, t),
    detail: activity.detailText
      ? resolveTextPart(activity.detailText, t)
      : activity.detail === undefined
        ? undefined
        : localizeText(activity.detail, t),
    body: activity.bodyText
      ? activity.bodyText.map((part) => resolveTextPart(part, t)).join("\n")
      : activity.body === undefined
        ? undefined
        : localizeText(activity.body, t),
  };
}

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

function delegateCapsDetail(
  payload: Record<string, unknown>,
): { detail: string; detailText: TraceText } | undefined {
  const context = stringOf(payload.context);
  if (context !== "member_fork" && context !== "task_only") return undefined;
  // 档位必须带成因：「只带任务描述 · 这个 agent 没报 fork 能力」——这一步就是用户
  // 事后对得上「为什么这个 agent 带了上下文、那个没带」的地方（orchestration.md §3 落点②）。
  const detail = delegateCapsDetailText(context, stringOf(payload.reason));
  if (detail.reasonKey) {
    const detailText: TraceText = {
      key: "delegate.caps.detail.withReason",
      values: { label: { key: detail.labelKey }, reason: { key: detail.reasonKey } },
    };
    return { detail: detailText.key, detailText };
  }
  return { detail: detail.labelKey, detailText: { key: detail.labelKey } };
}

function delegateTargetValue(payload: Record<string, unknown>): string | TraceText {
  return stringOf(payload.targetName) ?? { key: "trace.delegate.targetFallback" };
}

function delegateResultTitle(
  target: string | TraceText,
  payload: Record<string, unknown>,
): { title: string; titleText: TraceText } {
  if (stringOf(payload.status) === "cancelled") {
    return {
      title: "trace.delegate.result.stopped",
      titleText: { key: "trace.delegate.result.stopped", values: { target } },
    };
  }
  const elapsed = numberOf(payload.elapsedMs);
  if (elapsed === undefined) {
    return {
      title: "trace.delegate.result.returned",
      titleText: { key: "trace.delegate.result.returned", values: { target } },
    };
  }
  return {
    title: "trace.delegate.result.returnedElapsed",
    titleText: { key: "trace.delegate.result.returnedElapsed", values: { target, elapsed } },
  };
}

function delegateResultDetail(
  payload: Record<string, unknown>,
  fallback: TraceTextPart | undefined,
): { detail?: string; detailText?: TraceTextPart } {
  if (stringOf(payload.status) !== "failed") {
    return fallback === undefined
      ? {}
      : { detail: textOfPart(fallback), detailText: fallback };
  }
  const reason = stringOf(payload.stopReason) ?? stringOf(payload.reason);
  if (reason) return { detail: reason, detailText: reason };
  return { detail: "trace.delegate.result.failed", detailText: { key: "trace.delegate.result.failed" } };
}

function delegateResultStatus(payload: Record<string, unknown>): Activity["status"] {
  const status = stringOf(payload.status);
  if (status === "failed") return "error";
  if (status === "finished") return "ok";
  if (status === "cancelled") return "cancelled";
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
  titleText: TraceText;
  body?: string;
  bodyText: TraceTextPart[];
  detail?: string;
  detailText?: TraceTextPart;
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
  const categoryKey = meta?.toolKind ? permissionKindKey(meta.toolKind) : null;
  const actionKey: MessageKey = reject
    ? "trace.permission.decision.rejected"
    : via === "auto:edits"
      ? "trace.permission.decision.autoApproved"
      : "trace.permission.decision.approved";
  const titleText: TraceText = note
    ? {
        key: "trace.permission.decision.withNote",
        values: { action: { key: actionKey } },
      }
    : categoryKey
      ? {
          key: "trace.permission.decision.withKind",
          values: { action: { key: actionKey }, kind: { key: categoryKey } },
        }
      : { key: actionKey };

  const bodyText: TraceTextPart[] = [];
  if (optionLabel) {
    bodyText.push({ key: "trace.permission.decision.option", values: { option: optionLabel } });
  }
  if (note) {
    bodyText.push({ key: "trace.permission.decision.note", values: { note } });
  }
  bodyText.push({
    key:
      via === "auto:edits"
        ? "trace.permission.decision.viaAuto"
        : "trace.permission.decision.viaUser",
  });

  const detailText: TraceTextPart = note ?? optionLabel ?? (categoryKey ? { key: categoryKey } : titleText);
  const detail = textOfPart(detailText).replace(/\s+/g, " ").trim().slice(0, 80);
  return {
    title: titleText.key,
    titleText,
    body: textOfParts(bodyText),
    bodyText,
    detail: detail || undefined,
    detailText,
    verdict: reject ? "reject" : "allow",
  };
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

function truncationLine(bytes: number): { text: string; part: TraceText } {
  const kb = Math.max(1, Math.round(bytes / 1024));
  return {
    text: `…已截断 ${kb} KB`, // i18n-ignore: Activity.body 的数据兜底，展示层读 part 翻译
    part: { key: "trace.truncated.line", values: { kb } },
  };
}

function rawInputValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
}

/** 把 ACP 的 `rawInput` 展开成逐行文本。活动行与轨迹卡片共用同一套展开。 */
export function rawInputLines(value: unknown): string[] {
  if (typeof value === "string") return value.split("\n");
  if (Array.isArray(value)) return value.map(rawInputValue);
  const obj = recordOf(value);
  if (obj) {
    return Object.entries(obj).map(([key, item]) => `${key}: ${rawInputValue(item)}`);
  }
  return [rawInputValue(value)];
}

function rawInputSide(value: unknown): { text: string; parts: TraceTextPart[] } | undefined {
  if (value === undefined || value === null) return undefined;

  const marker = truncatedInfo(value);
  const text = marker ? (marker.preview ?? "") : rawInputLines(value).join("\n");
  if (text.length === 0 && !marker) return undefined;

  const bytes = utf8Bytes(text);
  const clipped = bytes > BODY_SIDE_MAX_BYTES ? boundaryPrefix(text, BODY_SIDE_MAX_BYTES) : text;
  const markerLine = marker
    ? truncationLine(marker.bytes)
    : bytes > BODY_SIDE_MAX_BYTES
      ? truncationLine(bytes)
      : undefined;
  if (!markerLine) return { text: clipped, parts: [clipped] };
  const parts: TraceTextPart[] = [];
  if (clipped.length > 0) parts.push(clipped);
  parts.push(markerLine.part);
  return { text: textOfParts(parts), parts };
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

function contentSide(value: unknown): { text: string; parts: TraceTextPart[] } | undefined {
  if (value === undefined || value === null) return undefined;

  const marker = truncatedInfo(value);
  if (marker) {
    const line = truncationLine(marker.bytes);
    const parts: TraceTextPart[] = [];
    if (marker.preview) parts.push(marker.preview);
    parts.push(line.part);
    return { text: textOfParts(parts), parts };
  }
  if (typeof value === "string") {
    const text = stringOf(value);
    return text ? { text, parts: [text] } : undefined;
  }
  if (!Array.isArray(value)) {
    const text = stringOf(recordOf(value)?.text);
    if (text) return { text, parts: [text] };
    const line = contentLine(value);
    return line ? { text: line, parts: [line] } : undefined;
  }

  const lines: string[] = [];
  const parts: TraceTextPart[] = [];
  let markerBytes: number | undefined;
  for (const entry of value) {
    const entryMarker = truncatedInfo(entry);
    if (entryMarker) {
      if (entryMarker.preview) {
        lines.push(entryMarker.preview);
        parts.push(entryMarker.preview);
      }
      markerBytes = entryMarker.bytes;
      continue;
    }
    const text = stringOf(recordOf(entry)?.text);
    if (text) {
      lines.push(text);
      parts.push(text);
      continue;
    }
    const line = contentLine(entry);
    if (line) {
      lines.push(line);
      parts.push(line);
    }
  }
  if (markerBytes !== undefined) {
    const line = truncationLine(markerBytes);
    lines.push(line.text);
    parts.push(line.part);
  }
  return lines.length > 0 ? { text: lines.join("\n"), parts } : undefined;
}

/**
 * 卡片正文与列表摘要。
 * tool_call 的 `rawInput` / `content` 由后端 `trace.rs` 从 ACP 事件捕获，
 * 正文按 locations → rawInput → content 展开，摘要优先用 title。
 */
function summaryOf(
  item: TraceTurnDto["items"][number],
  decision?: DecisionText,
): { body?: string; bodyText?: TraceTextPart[]; detail?: string; detailText?: TraceTextPart } {
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
    const rawInput = rawInputSide(payload.rawInput);
    const content = contentSide(payload.content);
    const sections = [lines.join("\n"), rawInput?.text, content?.text].filter(
      (part): part is string => Boolean(part),
    );
    const bodyText: TraceTextPart[] = [];
    if (lines.length > 0) bodyText.push(lines.join("\n"));
    if (rawInput) bodyText.push(...rawInput.parts);
    if (content) bodyText.push(...content.parts);
    const detailSource = stringOf(payload.title) ?? rawInputFirstLine(payload.rawInput);
    return {
      body: sections.length > 0 ? sections.join("\n") : undefined,
      bodyText: bodyText.length > 0 ? bodyText : undefined,
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
    return {
      body: decision.body,
      bodyText: decision.bodyText,
      detail: decision.detail,
      detailText: decision.detailText,
    };
  }

  if (item.kind === "delegate") {
    const detail = delegateCapsDetail(payload);
    return detail ? { detail: detail.detail, detailText: detail.detailText } : {};
  }

  if (item.kind === "delegate_result") {
    return delegateResultDetail(payload, undefined);
  }

  return {};
}

function titleOf(
  item: TraceTurnDto["items"][number],
  decision?: DecisionText,
): { title: string; titleText?: TraceText } {
  const p = item.payload as Record<string, unknown>;
  if (item.kind === "permission") {
    const tool = (p.toolCall ?? {}) as Record<string, unknown>;
    const title = stringOf(tool.title);
    return {
      title: "trace.permission.request",
      titleText: {
        key: "trace.permission.request",
        values: { tool: title ?? { key: "trace.permission.unknownTool" } },
      },
    };
  }
  if (item.kind === "thought") {
    const text = String(p.text ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 0) return { title: text.slice(0, 42) };
    return { title: "trace.thought.fallback", titleText: { key: "trace.thought.fallback" } };
  }
  if (item.kind === "permission_decision" && decision) {
    return { title: decision.title, titleText: decision.titleText };
  }
  if (item.kind === "delegate") {
    return {
      title: "trace.delegate.assigned",
      titleText: { key: "trace.delegate.assigned", values: { target: delegateTargetValue(p) } },
    };
  }
  if (item.kind === "delegate_result") return delegateResultTitle(delegateTargetValue(p), p);
  const title = stringOf(p.title);
  if (title) return { title };
  return { title: "trace.tool.fallback", titleText: { key: "trace.tool.fallback" } };
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export interface TraceView {
  turns: TraceTurn[];
  activities: TraceActivity[];
}

/**
 * 图视图是否给这一轮铺行（docs/desktop-ux.md §19.6）。
 *
 * 一条活动都没有、也没有分支回复的轮不占行：没开思考、没调工具、agent 也没发 `usage_update`
 * 的纯对话轮就是这样（真库里 28 轮有 5 轮），按轮铺节点会画出一片无标签的空白圆点。
 * `hasActivity` 由调用方给（它手里有活动表），所以这里是纯函数、可单测。
 */
export function turnHasDrawableContent(
  turn: Pick<TraceTurn, "branches">,
  hasActivity: (id: string) => boolean,
): boolean {
  return turn.branches.some((b) => Boolean(b.reply) || b.activityIds.some(hasActivity));
}

/**
 * 转换。每个作者一条支线（多 agent 群聊各走各的），顺序保持后端给的 seq 顺序。
 *
 * 没有把「回答」放进支线：回答是对话正文，面板只画「思考与操作」——
 * 这也是把思考和工具调用移出聊天界面之后，它们唯一的落点。
 */
export function toTraceView(dtos: TraceTurnDto[]): TraceView {
  const activities: TraceActivity[] = [];
  const turns: TraceTurn[] = [];
  const delegateSteps = new Map<
    string,
    { activity: TraceActivity; detail?: TraceTextPart; target: string | TraceText }
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
          const resultTitle = delegateResultTitle(prior.target, payload);
          prior.activity.title = resultTitle.title;
          prior.activity.titleText = resultTitle.titleText;
          const resultDetail = delegateResultDetail(payload, prior.detail);
          prior.activity.detail = resultDetail.detail;
          prior.activity.detailText = resultDetail.detailText;
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
      const title = titleOf(item, decision);
      // 主 agent 没有 authorId（它就是「这个会话本身」），与聊天里的玩家表用同一个 id
      const playerId = item.authorId ?? MAIN_AGENT_ID;
      const id = `${t.id}-${item.seq}`;
      const activity: TraceActivity = {
        id,
        playerId,
        kind,
        title: title.title,
        titleText: title.titleText,
        detail: summary.detail,
        detailText: summary.detailText,
        body: summary.body,
        bodyText: summary.bodyText,
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
                : isTurnCancelled(t.status, t.stopReason)
                  ? "cancelled"
                  : "ok",
      };
      activities.push(activity);
      if (item.kind === "delegate") {
        const handleId = stringOf(payload.handleId);
        if (handleId) {
          delegateSteps.set(handleId, {
            activity,
            detail: summary.detailText,
            target: delegateTargetValue(payload),
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
