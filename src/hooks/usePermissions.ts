import { useCallback, useEffect, useRef, useState } from "react";
import { agentRespondRequest, asCmdError, type CmdError, type RespondOutcome } from "@/lib/ipc";
import { pickAllowOption, shouldAutoApprove, type AutoApproveLevel } from "@/lib/auto-approve";
import { clog } from "@/lib/log";
import { permissionKindKey } from "@/lib/permission-kind";
import { i18nText } from "@/lib/i18n-text";
import {
  PERMISSION_CLIENT_TIMEOUT_MS,
  permissionTimerKey,
} from "@/lib/permission-timeout";
import type { PermissionOption, PermissionRequest } from "@/types";

/** Hermes `tools/approval_context.py` 的 `approvals.timeout` 默认 300 秒；超时后 agent 按拒绝继续。 */
export { PERMISSION_CLIENT_TIMEOUT_MS } from "@/lib/permission-timeout";

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

interface PermissionSnapshot {
  profileId: string;
  acpSessionId?: string | null;
  turnId?: string | null;
}

function elapsedText(start: number | undefined): string {
  return start === undefined ? "?" : String(Math.max(0, Date.now() - start));
}

function permLog(diag: ((text: string) => void) | undefined, tag: string, detail: string): void {
  diag?.(`${tag} ${detail}`);
  clog(tag, detail);
}

function expiredReasonForRespondError(err: CmdError): string {
  if (err.code === 50500) return i18nText("permission.expiredReason.agentTimeout");
  if (err.code === 50501) return i18nText("permission.expiredReason.disconnected");
  return err.msg.trim() ? err.msg : i18nText("permission.expiredReason.unknownTurn");
}

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

/** 开了自动同意却没动手时，要让人看得出是哪一种「没满足」。 */
function autoSkippedReason(kind: string | null): string {
  return i18nText(
    permissionKindKey(kind) === "permission.kind.uncategorized"
      ? "permission.skipped.uncategorized"
      : "permission.skipped.noAuto",
  );
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
  snapshot: PermissionSnapshot,
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
    detail = path
      ? i18nText("permission.detail.edit", { path })
      : i18nText("permission.detail.editFallback");
  } else if (kind === "execute") {
    detail = i18nText("permission.kind.execute");
  } else {
    const toolName = tool ?? kind;
    detail = toolName
      ? i18nText("permission.detail.tool", { tool: toolName })
      : i18nText("permission.detail.toolUnknown");
  }

  const options = parsePermissionOptions(params);

  return {
    id: String(requestId),
    // App 按 playerId 找玩家；拿不到就如实留空，不能拿第一个玩家顶替。
    playerId: playerId ?? "",
    kind: kind ?? null,
    title: nonEmptyString(toolCall.title) ?? i18nText("permission.requestTitle"),
    detail,
    meta: tool,
    options,
    profileId: snapshot.profileId,
    acpSessionId: snapshot.acpSessionId ?? null,
    turnId: snapshot.turnId ?? null,
  };
}

export function usePermissions({
  onHead,
  getAutoApprove = () => "off",
  diag,
  onTimeout,
}: {
  /** 队列头变化时通知 App 更新 pendingPerm 镜像 */
  onHead: (uiSid: string, request: PermissionRequest | null) => void;
  /** 实时读取会话档位；不要传入某次渲染时的策略快照 */
  getAutoApprove?: (uiSid: string) => AutoApproveLevel;
  /** 自动放行时留一条诊断 */
  diag?: (text: string) => void;
  /** 本地 300 秒超时：请求已移出可作答队列，但界面仍展示过期态 */
  onTimeout?: (uiSid: string, request: PermissionRequest) => void;
}) {
  const [queues, setQueues] = useState<Queues>({});
  /**
   * 本地超时的请求已经从可作答队列移除，但还要留一份给弹框显示过期态；
   * 否则 onHead 会收到 null，用户只看到弹框莫名消失，不知道 agent 已按拒绝继续。
   */
  const [expiredHeads, setExpiredHeads] = useState<Record<string, PermissionRequest>>({});
  // state 是渲染用的；ref 让连续入队和异步应答都能拿到最新的不可变快照，
  // 避免依赖 setState 的函数式更新去产生「通知 App」这类副作用。
  const queuesRef = useRef<Queues>(queues);
  const expiredHeadsRef = useRef<Record<string, PermissionRequest>>(expiredHeads);
  const onHeadRef = useRef(onHead);
  const onTimeoutRef = useRef(onTimeout);
  const diagRef = useRef(diag);
  /** 键固定为 `${profileId}:${requestId}`，作答/过期/断连/卸载都必须清。 */
  const timers = useRef<Record<string, number>>({});
  /** 请求到达时间，用于 PERM-ANSWER / PERM-STALE 的等待耗时。 */
  const askedAt = useRef<Record<string, number>>({});
  // 在 effect 里同步而不是渲染期直接赋值：渲染期写 ref 会在 StrictMode 双调用下
  // 出现「渲染了但没提交」的中间值，之前 useSessionList 就栽在这类写法上。
  useEffect(() => {
    onHeadRef.current = onHead;
  }, [onHead]);
  useEffect(() => {
    onTimeoutRef.current = onTimeout;
  }, [onTimeout]);
  useEffect(() => {
    diagRef.current = diag;
  }, [diag]);
  /** 同一会话同一时刻只让一条应答在路上，挡住双击导致的二次出队 */
  const inFlight = useRef<Record<string, string>>({});
  /** 同一条请求的自动应答还在飞时，重复事件不再发第二次 */
  const autoInFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    return () => {
      for (const timer of Object.values(timers.current)) window.clearTimeout(timer);
      timers.current = {};
      askedAt.current = {};
    };
  }, []);

  const clearTimer = useCallback((profileId: string, requestId: number) => {
    const key = permissionTimerKey(profileId, requestId);
    const timer = timers.current[key];
    if (timer !== undefined) window.clearTimeout(timer);
    delete timers.current[key];
  }, []);

  const setExpiredHead = useCallback(
    (uiSid: string, request: PermissionRequest | null) => {
      const prev = expiredHeadsRef.current;
      if (request === null) {
        if (!(uiSid in prev)) return;
        const next = { ...prev };
        delete next[uiSid];
        expiredHeadsRef.current = next;
        setExpiredHeads(next);
        return;
      }
      const next = { ...prev, [uiSid]: request };
      expiredHeadsRef.current = next;
      setExpiredHeads(next);
    },
    [],
  );

  const commit = useCallback((next: Queues, changed: string[]) => {
    queuesRef.current = next;
    setQueues(next);
    for (const uiSid of changed) {
      onHeadRef.current(
        uiSid,
        expiredHeadsRef.current[uiSid] ?? next[uiSid]?.[0]?.request ?? null,
      );
    }
  }, []);

  const clearExpiredHead = useCallback(
    (uiSid: string) => {
      setExpiredHead(uiSid, null);
      onHeadRef.current(uiSid, queuesRef.current[uiSid]?.[0]?.request ?? null);
    },
    [setExpiredHead],
  );

  const markRequestExpired = useCallback(
    (uiSid: string, profileId: string, requestId: number, reason: string) => {
      const prev = queuesRef.current;
      const queue = prev[uiSid] ?? [];
      let changed = false;
      const updated = queue.map((entry) => {
        if (entry.profileId !== profileId || entry.requestId !== requestId) return entry;
        if (entry.request.expiredReason !== undefined) return entry;
        changed = true;
        return { ...entry, request: { ...entry.request, expiredReason: reason } };
      });

      const overlay = expiredHeadsRef.current[uiSid];
      let updateOverlay = false;
      if (overlay && overlay.profileId === profileId && overlay.id === String(requestId)) {
        updateOverlay = true;
        setExpiredHead(uiSid, { ...overlay, expiredReason: reason });
      }

      if (changed) commit({ ...prev, [uiSid]: updated }, [uiSid]);
      else if (updateOverlay) onHeadRef.current(uiSid, expiredHeadsRef.current[uiSid] ?? null);
    },
    [commit, setExpiredHead],
  );

  const scheduleTimeout = useCallback(
    (uiSid: string, item: QueueItem) => {
      const key = permissionTimerKey(item.profileId, item.requestId);
      if (timers.current[key] !== undefined) return;
      timers.current[key] = window.setTimeout(() => {
        delete timers.current[key];
        const latest = queuesRef.current;
        const queue = latest[uiSid] ?? [];
        const index = queue.findIndex(
          (entry) =>
            entry.profileId === item.profileId && entry.requestId === item.requestId,
        );
        if (index < 0) return;
        const queued = queue[index];
        if (queued.request.expiredReason !== undefined) return;

        const reason = i18nText("permission.expiredReason.agentTimeout");
        const expired: PermissionRequest = { ...queued.request, expiredReason: reason };
        const rest = [...queue.slice(0, index), ...queue.slice(index + 1)];
        const next = { ...latest };
        if (rest.length > 0) next[uiSid] = rest;
        else delete next[uiSid];

        // 只有队头超时才需要保留过期展示态；队尾请求超时直接从队列移除，
        // 不能盖住当前正在等待回答的那一条。
        if (index === 0) setExpiredHead(uiSid, expired);

        const elapsed = elapsedText(askedAt.current[key]);
        delete askedAt.current[key];
        permLog(
          diagRef.current,
          "PERM-EXPIRE",
          `id=${queued.requestId} reason=agentTimeout wait=${elapsed}ms`,
        );
        commit(next, [uiSid]);
        onTimeoutRef.current?.(uiSid, expired);
      }, PERMISSION_CLIENT_TIMEOUT_MS);
    },
    [commit, setExpiredHead],
  );

  const enqueueItem = useCallback(
    (uiSid: string, item: QueueItem, skippedReason?: string) => {
      const prev = queuesRef.current;
      // 已过期的条目不再占队头：它们不能再被作答，留着只会挡住这一轮真正要问的那条。
      const queue = (prev[uiSid] ?? []).filter(
        (entry) => {
          if (entry.request.expiredReason === undefined) return true;
          clearTimer(entry.profileId, entry.requestId);
          delete askedAt.current[permissionTimerKey(entry.profileId, entry.requestId)];
          return false;
        },
      );
      // 事件通道重复投递同一条请求时不能排两次，否则会被后端当成第二次应答拒收。
      if (
        queue.some(
          (entry) => entry.profileId === item.profileId && entry.requestId === item.requestId,
        )
      ) {
        return;
      }
      const expiredHead = expiredHeadsRef.current[uiSid];
      if (
        expiredHead?.profileId === item.profileId &&
        expiredHead.id === String(item.requestId)
      ) {
        return;
      }
      // 新请求到达时，上一条本地超时请求的过期展示态让位。
      setExpiredHead(uiSid, null);
      const request = skippedReason
        ? { ...item.request, autoSkippedReason: skippedReason }
        : item.request;
      commit({ ...prev, [uiSid]: [...queue, { ...item, request }] }, [uiSid]);
      scheduleTimeout(uiSid, { ...item, request });
    },
    [clearTimer, commit, scheduleTimeout, setExpiredHead],
  );

  const enqueue = useCallback(
    async (
      uiSid: string,
      profileId: string,
      requestId: number,
      params: unknown,
      playerId: string | null = null,
      snapshot?: { acpSessionId?: string | null; turnId?: string | null },
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
      const expiredHead = expiredHeadsRef.current[uiSid];
      if (
        expiredHead?.profileId === profileId &&
        expiredHead.id === String(requestId)
      ) {
        return;
      }
      const item: QueueItem = {
        profileId,
        requestId,
        request: parsePermissionRequest(requestId, params, playerId, {
          profileId,
          acpSessionId: snapshot?.acpSessionId ?? null,
          turnId: snapshot?.turnId ?? null,
        }),
      };
      const timerKey = permissionTimerKey(profileId, requestId);
      askedAt.current[timerKey] = Date.now();
      permLog(
        diag,
        "PERM-ASK",
        `id=${requestId} kind=${item.request.kind ?? "-"} turn=${item.request.turnId ? "yes" : "no"} wait=0ms`,
      );

      const level = getAutoApprove(uiSid);
      if (level === "edits") {
        if (shouldAutoApprove(level, item.request.kind)) {
          const allow = pickAllowOption(item.request.options);
          if (allow) {
            const flightKey = `${profileId}:${requestId}`;
            if (autoInFlight.current.has(flightKey)) {
              delete askedAt.current[timerKey];
              return;
            }
            autoInFlight.current.add(flightKey);
            try {
              await agentRespondRequest(
                profileId,
                requestId,
                { outcome: "selected", optionId: allow.id },
                {
                  verdict: "allow",
                  optionId: allow.id,
                  optionLabel: allow.label,
                  actorMemberId: item.request.playerId || null,
                  note: null,
                  via: "auto:edits",
                },
              );
              diag?.(`AUTO-APPROVE ui=${uiSid} id=${requestId} kind=${item.request.kind}`);
              delete askedAt.current[timerKey];
              return;
            } catch (e) {
              // 失败不能把轮卡住：把请求放回队列，弹窗由 onHead 打开。
              clog("AUTO-APPROVE-ERR", `profile=${profileId} id=${requestId} ${String(e)}`);
            } finally {
              autoInFlight.current.delete(flightKey);
            }
            enqueueItem(uiSid, item);
            return;
          }
        }
        enqueueItem(uiSid, item, autoSkippedReason(item.request.kind));
        return;
      }

      enqueueItem(uiSid, item);
    },
    [enqueueItem, getAutoApprove, diag],
  );

  const current = useCallback(
    (uiSid: string): PermissionRequest | null =>
      expiredHeads[uiSid] ?? queues[uiSid]?.[0]?.request ?? null,
    [expiredHeads, queues],
  );

  const count = useCallback(
    (uiSid: string): number =>
      (queues[uiSid]?.length ?? 0) + (expiredHeads[uiSid] ? 1 : 0),
    [expiredHeads, queues],
  );

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
        clearTimer(stillHead.profileId, stillHead.requestId);
        delete askedAt.current[permissionTimerKey(stillHead.profileId, stillHead.requestId)];
        commit(next, [uiSid]);
      }
    },
    [clearTimer, commit],
  );

  /** 返回实际发出的选项；null 表示只有 cancelled 可选（没有 reject 项）。 */
  const decide = useCallback(
    async (
      uiSid: string,
      optionId: string | null,
      note: string | null = null,
    ): Promise<PermissionOption | null> => {
      const expiredHead = expiredHeadsRef.current[uiSid];
      if (expiredHead) {
        if (optionId !== null) throw { code: 50902, msg: i18nText("permission.guard.expired") };
        clearExpiredHead(uiSid);
        return null;
      }

      const head = queuesRef.current[uiSid]?.[0];
      if (!head) throw { code: 50901, msg: i18nText("permission.guard.noPending") };

      // 过期请求不再写回 agent。Esc/关闭只在本机出队，别拿一个已经失效的 id 去试。
      if (head.request.expiredReason !== undefined) {
        if (optionId !== null) throw { code: 50902, msg: i18nText("permission.guard.expired") };
        removeHead(uiSid, head.profileId, head.requestId);
        return null;
      }

      const flightKey = `${head.profileId}:${head.requestId}`;
      if (inFlight.current[uiSid] === flightKey) {
        throw { code: 50903, msg: i18nText("permission.guard.inFlight") };
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
        if (!selected) throw { code: 50904, msg: i18nText("permission.guard.optionGone") };
        outcome = { outcome: "selected", optionId };
      }

      const rejected = selected ? selected.tone === "reject" : true;

      // 选项已校验通过、即将发 IPC：先停本地计时器，避免往返跨过 300 秒边界时，
      // 计时器把一条其实已经写回的请求标成过期。失败路径会自己写过期态。
      clearTimer(head.profileId, head.requestId);
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

        const elapsed = elapsedText(askedAt.current[flightKey]);
        const outcomeLabel =
          outcome.outcome === "selected" ? `selected:${outcome.optionId}` : "cancelled";
        permLog(
          diagRef.current,
          "PERM-ANSWER",
          `id=${head.requestId} outcome=${outcomeLabel} wait=${elapsed}ms`,
        );
        clearTimer(head.profileId, head.requestId);
        delete askedAt.current[flightKey];
        const overlay = expiredHeadsRef.current[uiSid];
        if (overlay && overlay.profileId === head.profileId && overlay.id === String(head.requestId)) {
          clearExpiredHead(uiSid);
        }
        // 成功后才出队。等待期间会话可能被关闭或队列被清理，
        // 所以只有队头仍是刚回答的这条时才移除，避免误删新请求。
        removeHead(uiSid, head.profileId, head.requestId);
        return selected;
      } catch (e) {
        const err = asCmdError(e);
        const elapsed = elapsedText(askedAt.current[flightKey]);
        markRequestExpired(
          uiSid,
          head.profileId,
          head.requestId,
          expiredReasonForRespondError(err),
        );
        clearTimer(head.profileId, head.requestId);
        delete askedAt.current[flightKey];
        permLog(
          diagRef.current,
          "PERM-STALE",
          `id=${head.requestId} code=${err.code} wait=${elapsed}ms`,
        );
        // 请求已经不可能写回 agent：留在过期态让用户看懂，不再冒内部错误码。
        return null;
      } finally {
        delete inFlight.current[uiSid];
      }
    },
    [clearExpiredHead, clearTimer, markRequestExpired, removeHead],
  );

  /**
   * 请求失效的前置标记：轮次终态或连接断开后，队列里的请求仍然展示，
   * 但必须写明「已过期」并禁用选项 —— 不能等用户点了才从 50500/50501 发现。
   */
  const expire = useCallback(
    (args: {
      uiSid?: string;
      profileId: string;
      reason: string;
      cause?: "turn-end" | "disconnected";
    }) => {
      const prev = queuesRef.current;
      const next = { ...prev };
      const changed: string[] = [];
      for (const [uiSid, queue] of Object.entries(prev)) {
        if (args.uiSid !== undefined && uiSid !== args.uiSid) continue;
        let touched = false;
        const updated = queue.map((item) => {
          if (item.profileId !== args.profileId) return item;
          const key = permissionTimerKey(item.profileId, item.requestId);
          const elapsed = elapsedText(askedAt.current[key]);
          clearTimer(item.profileId, item.requestId);
          delete askedAt.current[key];
          if (item.request.expiredReason !== undefined) return item;
          touched = true;
          permLog(
            diagRef.current,
            "PERM-EXPIRE",
            `id=${item.requestId} reason=${args.cause ?? args.reason} wait=${elapsed}ms`,
          );
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
    [clearTimer, commit],
  );

  /**
   * 主判据：惰性过期（docs/desktop-ux.md §29.4）。
   *
   * 等待授权期间 agent 是完全阻塞的（实测一次 280 秒、一次 271 秒零事件）；所以该会话在请求
   * **还没作答**时又出现事件，等于这条授权已经被 agent 丢掉 —— 立刻收掉，不必等满 300 秒。
   * 正在作答（IPC 在途）时不动手：那条请求马上就有真实结果。
   */
  const expireByActivity = useCallback(
    (uiSid: string, acpSessionId: string, reason: string) => {
      if (inFlight.current[uiSid]) return;
      const prev = queuesRef.current;
      const queue = prev[uiSid] ?? [];
      if (queue.length === 0) return;
      // 只认同一个 ACP 会话的请求：群聊里两个成员各问一条时，A 干活不能把 B 的授权标死。
      // 快照缺失（拿不到 acpSessionId）的一律不动手 —— 交给 300 秒兜底，宁慢不错杀。
      const hits = queue.filter(
        (item) =>
          item.request.expiredReason === undefined &&
          item.request.acpSessionId != null &&
          item.request.acpSessionId === acpSessionId,
      );
      if (hits.length === 0) return;

      const head = hits[0];
      for (const item of hits) {
        const key = permissionTimerKey(item.profileId, item.requestId);
        const elapsed = elapsedText(askedAt.current[key]);
        clearTimer(item.profileId, item.requestId);
        delete askedAt.current[key];
        permLog(
          diagRef.current,
          "PERM-EXPIRE",
          `id=${item.requestId} reason=activity wait=${elapsed}ms`,
        );
      }

      const expired: PermissionRequest = { ...head.request, expiredReason: reason };
      const rest = queue.filter((item) => !hits.includes(item));
      if (head === queue[0]) setExpiredHead(uiSid, expired);
      const next = { ...prev };
      if (rest.length > 0) next[uiSid] = rest;
      else delete next[uiSid];
      commit(next, [uiSid]);
      onTimeoutRef.current?.(uiSid, expired);
    },
    [clearTimer, commit, setExpiredHead],
  );

  const dropSession = useCallback(
    (uiSid: string) => {
      const prev = queuesRef.current;
      const queue = prev[uiSid];
      const overlay = expiredHeadsRef.current[uiSid];
      if (!queue && !overlay) return;
      // 标签关掉 = 这些请求再也没人能看见，先按拒绝收尾再丢弃
      for (const item of queue ?? []) {
        clearTimer(item.profileId, item.requestId);
        delete askedAt.current[permissionTimerKey(item.profileId, item.requestId)];
        if (item.request.expiredReason !== undefined) continue;
        denyPermission(
          item.profileId,
          item.requestId,
          item.request.options,
          item.request.playerId || null,
        );
      }
      setExpiredHead(uiSid, null);
      const next = { ...prev };
      delete next[uiSid];
      commit(next, [uiSid]);
    },
    [clearTimer, commit, setExpiredHead],
  );

  const dropProfile = useCallback(
    (profileId: string) => {
      const prev = queuesRef.current;
      const next = { ...prev };
      const changed: string[] = [];
      const sessionIds = new Set([
        ...Object.keys(prev),
        ...Object.keys(expiredHeadsRef.current),
      ]);
      for (const uiSid of sessionIds) {
        const queue = prev[uiSid] ?? [];
        const overlay = expiredHeadsRef.current[uiSid];
        const hasOverlay = overlay?.profileId === profileId;
        if (!hasOverlay && !queue.some((item) => item.profileId === profileId)) continue;
        for (const item of queue) {
          if (item.profileId !== profileId) continue;
          clearTimer(item.profileId, item.requestId);
          delete askedAt.current[permissionTimerKey(item.profileId, item.requestId)];
          if (item.request.expiredReason === undefined) {
            denyPermission(
              item.profileId,
              item.requestId,
              item.request.options,
              item.request.playerId || null,
            );
          }
        }
        if (hasOverlay) setExpiredHead(uiSid, null);
        const rest = queue.filter((item) => item.profileId !== profileId);
        if (rest.length > 0) next[uiSid] = rest;
        else delete next[uiSid];
        changed.push(uiSid);
      }
      if (changed.length > 0) commit(next, changed);
    },
    [clearTimer, commit, setExpiredHead],
  );

  return { enqueue, current, count, decide, expire, expireByActivity, dropSession, dropProfile };
}
