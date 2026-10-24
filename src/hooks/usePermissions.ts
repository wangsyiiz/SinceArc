import { useCallback, useEffect, useRef, useState } from "react";
import { agentRespondRequest, type RespondOutcome } from "@/lib/ipc";
import { clog } from "@/lib/log";
import type { PermissionOption, PermissionRequest } from "@/types";

export interface QueueItem {
  profileId: string;
  requestId: number;
  request: PermissionRequest;
}

/**
 * 没有界面可以展示时按拒绝收尾。
 *
 * 不回答的代价是 agent 一直等到它自己超时（hermes 300s），用户以为点掉了、实际那一轮还挂着。
 * 宁可显式拒绝并留日志，也不要让它悬空。失败就忽略 —— 这条路径本来就没有人盯着结果。
 */
export function denyPermission(
  profileId: string,
  requestId: number,
  options: PermissionOption[],
  actorMemberId: string | null = null,
): void {
  const reject = options.find((option) => option.tone === "reject");
  const outcome: RespondOutcome = reject
    ? { outcome: "selected", optionId: reject.id }
    : { outcome: "cancelled" };
  // 失败不能吞：这条路径没有人盯着结果，至少要在日志里留下「哪条请求没答上」
  void agentRespondRequest(profileId, requestId, outcome, {
    verdict: "reject",
    optionId: reject?.id ?? null,
    optionLabel: reject?.label ?? null,
    actorMemberId,
    note: null,
    via: "user",
  }).catch((e) => {
    clog("PERM-DENY-ERR", `profile=${profileId} id=${requestId} ${String(e)}`);
  });
}

type Queues = Record<string, QueueItem[]>;

/** 权限回调里的 params 来自 ACP，字段可能缺失；这里只做窄化，不替 agent 编数据。 */
function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function nonEmptyString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function normalizeNote(note: string | null | undefined): string | null {
  const text = note?.trim() ?? "";
  return text.length > 0 ? text : null;
}

function toneOf(kind: string | undefined): PermissionOption["tone"] {
  switch (kind) {
    case "allow_once":
      return "allow";
    case "allow_always":
      return "always";
    case "reject_once":
    case "reject_always":
      return "reject";
    default:
      // 协议允许 agent 给未知 kind；界面宁可把它当拒绝，也不能当成放行。
      return "reject";
  }
}

/** 从 params 里取 options。协议允许 agent 给未知 kind，未知一律按拒绝处理。 */
export function parsePermissionOptions(params: unknown): PermissionOption[] {
  const root = asRecord(params) ?? {};
  const rawOptions = Array.isArray(root.options) ? root.options : [];
  const options: PermissionOption[] = [];
  for (const raw of rawOptions) {
    const option = asRecord(raw);
    if (!option) continue;
    const id = nonEmptyString(option.optionId);
    // 没有 optionId 的选项无法回给 agent；保留它只会让用户点了以后失败。
    if (!id) continue;
    options.push({
      id,
      label: nonEmptyString(option.name) ?? id,
      tone: toneOf(nonEmptyString(option.kind)),
    });
  }
  return options;
}

function parsePermissionRequest(
  requestId: number,
  params: unknown,
  playerId: string | null,
): PermissionRequest {
  const root = asRecord(params) ?? {};
  const toolCall = asRecord(root.toolCall) ?? {};
  const rawInput = asRecord(toolCall.rawInput);
  const args = asRecord(rawInput?.arguments);
  const content = Array.isArray(toolCall.content) ? toolCall.content : [];
  const firstContent = asRecord(content[0]);
  const kind = nonEmptyString(toolCall.kind);
  const tool = nonEmptyString(rawInput?.tool);

  let detail: string;
  if (kind === "edit") {
    // 真实 payload 的路径在 content[0].path；缺失时退回 rawInput.arguments.path。
    const path = nonEmptyString(firstContent?.path) ?? nonEmptyString(args?.path);
    detail = `修改 ${path ?? "文件"}`;
  } else if (kind === "execute") {
    detail = "执行命令";
  } else {
    detail = `工具调用（${tool ?? kind ?? "未知工具"}）`;
  }

  const options = parsePermissionOptions(params);

  return {
    id: String(requestId),
    // App 按 playerId 找玩家；拿不到就如实留空，不能拿第一个玩家顶替。
    playerId: playerId ?? "",
    kind: kind ?? null,
    title: nonEmptyString(toolCall.title) ?? "请求权限",
    detail,
    meta: tool,
    options,
  };
}

export function usePermissions({
  onHead,
}: {
  /** 队列头变化时通知 App 更新 pendingPerm 镜像 */
  onHead: (uiSid: string, request: PermissionRequest | null) => void;
}) {
  const [queues, setQueues] = useState<Queues>({});
  // state 是渲染用的；ref 让连续入队和异步应答都能拿到最新的不可变快照，
  // 避免依赖 setState 的函数式更新去产生「通知 App」这类副作用。
  const queuesRef = useRef<Queues>(queues);
  const onHeadRef = useRef(onHead);
  // 在 effect 里同步而不是渲染期直接赋值：渲染期写 ref 会在 StrictMode 双调用下
  // 出现「渲染了但没提交」的中间值，之前 useSessionList 就栽在这类写法上。
  useEffect(() => {
    onHeadRef.current = onHead;
  }, [onHead]);
  /** 同一会话同一时刻只让一条应答在路上，挡住双击导致的二次出队 */
  const inFlight = useRef<Record<string, string>>({});

  const commit = useCallback((next: Queues, changed: string[]) => {
    queuesRef.current = next;
    setQueues(next);
    for (const uiSid of changed) {
      onHeadRef.current(uiSid, next[uiSid]?.[0]?.request ?? null);
    }
  }, []);

  const enqueue = useCallback(
    (
      uiSid: string,
      profileId: string,
      requestId: number,
      params: unknown,
      playerId: string | null = null,
    ) => {
      const prev = queuesRef.current;
      // 已过期的条目不再占队头：它们不能再被作答，留着只会挡住这一轮真正要问的那条。
      const queue = (prev[uiSid] ?? []).filter(
        (item) => item.request.expiredReason === undefined,
      );
      // 事件通道重复投递同一条请求时不能排两次，否则会被后端当成第二次应答拒收。
      if (queue.some((item) => item.profileId === profileId && item.requestId === requestId)) {
        return;
      }
      const item: QueueItem = {
        profileId,
        requestId,
        request: parsePermissionRequest(requestId, params, playerId),
      };
      commit({ ...prev, [uiSid]: [...queue, item] }, [uiSid]);
    },
    [commit],
  );

  const current = useCallback(
    (uiSid: string): PermissionRequest | null => queues[uiSid]?.[0]?.request ?? null,
    [queues],
  );

  const count = useCallback((uiSid: string): number => queues[uiSid]?.length ?? 0, [queues]);

  const removeHead = useCallback(
    (uiSid: string, profileId: string, requestId: number) => {
      const latest = queuesRef.current;
      const queue = latest[uiSid] ?? [];
      const stillHead = queue[0];
      if (
        stillHead &&
        stillHead.profileId === profileId &&
        stillHead.requestId === requestId
      ) {
        const rest = queue.slice(1);
        const next = { ...latest };
        if (rest.length > 0) next[uiSid] = rest;
        else delete next[uiSid];
        commit(next, [uiSid]);
      }
    },
    [commit],
  );

  /** 返回实际发出的选项；null 表示只有 cancelled 可选（没有 reject 项）。 */
  const decide = useCallback(
    async (
      uiSid: string,
      optionId: string | null,
      note: string | null = null,
    ): Promise<PermissionOption | null> => {
      const head = queuesRef.current[uiSid]?.[0];
      if (!head) throw new Error("没有待回答的权限请求");

      // 过期请求不再写回 agent。Esc/关闭只在本机出队，别拿一个已经失效的 id 去试。
      if (head.request.expiredReason !== undefined) {
        if (optionId !== null) throw new Error("这个请求已过期，不能再作答");
        removeHead(uiSid, head.profileId, head.requestId);
        return null;
      }

      const flightKey = `${head.profileId}:${head.requestId}`;
      if (inFlight.current[uiSid] === flightKey) {
        throw new Error("这条权限请求还在处理中");
      }

      let selected: PermissionOption | null = null;
      let outcome: RespondOutcome;
      if (optionId === null) {
        // 取消必须优先走 agent 给的拒绝项；optionId 是 agent 定的，不能硬编码。
        const reject = head.request.options.find((option) => option.tone === "reject");
        selected = reject ?? null;
        outcome = reject
          ? { outcome: "selected", optionId: reject.id }
          : { outcome: "cancelled" };
      } else {
        selected = head.request.options.find((option) => option.id === optionId) ?? null;
        if (!selected) throw new Error("这个选项已经失效，请重新选择");
        outcome = { outcome: "selected", optionId };
      }

      const rejected = selected ? selected.tone === "reject" : true;

      inFlight.current[uiSid] = flightKey;
      try {
        await agentRespondRequest(head.profileId, head.requestId, outcome, {
          verdict: selected && selected.tone !== "reject" ? "allow" : "reject",
          optionId: selected?.id ?? null,
          optionLabel: selected?.label ?? null,
          actorMemberId: head.request.playerId || null,
          note: rejected ? normalizeNote(note) : null,
          via: "user",
        });

        // 成功后才出队。等待期间会话可能被关闭或队列被清理，
        // 所以只有队头仍是刚回答的这条时才移除，避免误删新请求。
        removeHead(uiSid, head.profileId, head.requestId);
        return selected;
      } finally {
        delete inFlight.current[uiSid];
      }
    },
    [removeHead],
  );

  /**
   * 请求失效的前置标记：轮次终态或连接断开后，队列里的请求仍然展示，
   * 但必须写明「已过期」并禁用选项 —— 不能等用户点了才从 50500/50501 发现。
   */
  const expire = useCallback(
    (args: { uiSid?: string; profileId: string; reason: string }) => {
      const prev = queuesRef.current;
      const next = { ...prev };
      const changed: string[] = [];
      for (const [uiSid, queue] of Object.entries(prev)) {
        if (args.uiSid !== undefined && uiSid !== args.uiSid) continue;
        let touched = false;
        const updated = queue.map((item) => {
          if (item.profileId !== args.profileId) return item;
          if (item.request.expiredReason !== undefined) return item;
          touched = true;
          return {
            ...item,
            request: { ...item.request, expiredReason: args.reason },
          };
        });
        if (!touched) continue;
        next[uiSid] = updated;
        changed.push(uiSid);
      }
      if (changed.length > 0) commit(next, changed);
    },
    [commit],
  );

  const dropSession = useCallback(
    (uiSid: string) => {
      const prev = queuesRef.current;
      const queue = prev[uiSid];
      if (!queue) return;
      // 标签关掉 = 这些请求再也没人能看见，先按拒绝收尾再丢弃
      for (const item of queue) {
        if (item.request.expiredReason !== undefined) continue;
        denyPermission(
          item.profileId,
          item.requestId,
          item.request.options,
          item.request.playerId || null,
        );
      }
      const next = { ...prev };
      delete next[uiSid];
      commit(next, [uiSid]);
    },
    [commit],
  );

  const dropProfile = useCallback(
    (profileId: string) => {
      const prev = queuesRef.current;
      const next = { ...prev };
      const changed: string[] = [];
      for (const [uiSid, queue] of Object.entries(prev)) {
        if (!queue.some((item) => item.profileId === profileId)) continue;
        for (const item of queue) {
          if (item.profileId === profileId && item.request.expiredReason === undefined) {
            denyPermission(
              item.profileId,
              item.requestId,
              item.request.options,
              item.request.playerId || null,
            );
          }
        }
        const rest = queue.filter((item) => item.profileId !== profileId);
        if (rest.length > 0) next[uiSid] = rest;
        else delete next[uiSid];
        changed.push(uiSid);
      }
      if (changed.length > 0) commit(next, changed);
    },
    [commit],
  );

  return { enqueue, current, count, decide, expire, dropSession, dropProfile };
}
