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

    for (const item of t.items) {
      const kind = activityKindOf(item);
      if (!kind) continue;
      // 主 agent 没有 authorId（它就是「这个会话本身」），与聊天里的玩家表用同一个 id
      const playerId = item.authorId ?? MAIN_AGENT_ID;
      const id = `${t.id}-${item.seq}`;
      activities.push({
        id,
        playerId,
        kind,
        title: titleOf(item),
        detail: item.truncated ? "…（已截断）" : undefined,
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
      // 中途停下的一轮标在提问上：列表视图与图视图都读 userText，改一处两处都看得见
      userText: t.status === "cancelled" ? `${t.prompt}（已停止）` : t.prompt,
      status: t.status as TraceTurn["status"],
      branches: [...lanes.entries()].map(([playerId, activityIds]) => ({
        playerId,
        activityIds,
        // 支线是否收尾由这一轮的状态决定；面板据此画实线/虚线
        reply: t.status === "running" ? undefined : "",
        status: t.status === "running" ? ("running" as const) : ("done" as const),
      })),
    });
  }

  return { turns, activities };
}
