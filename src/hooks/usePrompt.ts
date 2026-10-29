import { useCallback } from "react";
import {
  asCmdError,
  messagesAppend,
  sessionLoad,
  sessionNew,
  sessionPrompt,
  type ResumeOutcome,
} from "@/lib/ipc";
import type { ModesSnapshot } from "@/lib/ipc/types";
import { now } from "@/lib/format";
import { pushSystemNotice } from "@/lib/notices";
import { clog } from "@/lib/log";
import { newId } from "@/lib/ids";
import { replaceTurnId } from "@/lib/turn-id";
import { i18nText } from "@/lib/i18n-text";
import type { AgentProfile, Message } from "@/types";
import type { EnsureResult } from "./useAgentConnect";
import type { AcpRefs, ActiveSendTrace } from "./useAcpEvents";
import type { PatchSession } from "./useSessionState";

/** 主 agent 的发言用一个固定 id：玩家表里没有它时，消息会渲染成「agent」 */
// 定义在 lib/main-agent.ts（无依赖）：这里 import + 再导出，既保持既有 import 路径，
// 也让本文件内部能直接用这个名字
import { MAIN_AGENT_ID } from "@/lib/main-agent";
import { resolveSendTarget } from "@/lib/send-target";
export { MAIN_AGENT_ID };

export function usePrompt({
  lastSessionId,
  patchSession,
  activeProfile,
  sessionsByProfile,
  acpSessionOf,
  cwdOf,
  onSessionCreated,
  contextMessages,
  acp,
  profileIdOf,
  ensureConnected,
  onResume,
}: {
  lastSessionId: string;
  patchSession: PatchSession;
  activeProfile: AgentProfile | undefined;
  sessionsByProfile: Record<string, string>;
  /** 这条界面会话自己的 ACP 会话 id；不能拿连接当前会话来代替。 */
  acpSessionOf: (uiSid: string) => string | null;
  /** 这条界面会话的 cwd；为空时退回 profile 的 cwd。 */
  cwdOf: (uiSid: string, profileId: string | null) => string;
  /**
   * 新建 ACP 会话后回写界面状态（会话记录 + uiSid → acpSid 映射）。
   * `modes` 是这条会话建好时 agent 报的模式快照：不带回去，界面就会显示「不支持」，
   * 而同一个 agent 从连接路径建出来却有模式可选（docs/data-plane.md §3）。
   */
  onSessionCreated: (
    uiSid: string,
    profileId: string,
    acpSid: string,
    modes: ModesSnapshot | null,
  ) => void;
  contextMessages: number;
  acp: AcpRefs;
  /** 会话归属哪个连接（老会话没记录时返回 null） */
  profileIdOf: (uiSid: string) => string | null;
  /** 无感启动：没连就现连，永不抛异常 */
  ensureConnected: (profileId: string | null | undefined, uiSid?: string) => Promise<EnsureResult>;
  /** 恢复结果统一交给 App：通知条、诊断与会话头标记都在那里。 */
  onResume: (uiSid: string, outcome: ResumeOutcome, lastEventSeq: number | null) => void;
}) {
  const { acpToTurn } = acp;

  /** 只翻 busy 标记：失败时界面要让用户能接着发 */
  const setBusy = (sid: string, busy: boolean) =>
    patchSession(sid, (s) => ({ ...s, busy }));

  const send = useCallback(
    async (
      text: string,
      /** 指定投递目标（群里 @ 了某个成员）：这时不再投主 agent */
      target?: { profileId: string; acpSessionId: string; authorId: string; cwd: string },
      /** 用户发起时本轮已在跑：终态要用 400ms 规则判断是否被 agent 吞掉 */
      busyAtSend = false,
      /** 后台队列续发时指定目标界面会话；不传就是当前打开的会话。 */
      sidOverride?: string,
    ) => {
      const sid = sidOverride ?? lastSessionId;
      const at = now();

      // 归属：会话自己的连接优先，老会话（没记 profileId）退回当前选中。
      // @ 了成员时，归属变成那个成员所在的连接。
      const profileId = target?.profileId ?? profileIdOf(sid) ?? activeProfile?.id ?? null;
      // 只认这条界面会话自己的绑定。`sessionsByProfile[profileId]` 是「连接当前会话」，
      // 拿它给新会话首条消息投递，就是把别人的 agent 上下文借过来用（串台）。
      let own = target ? null : acpSessionOf(sid);
      let acpSid = target ? target.acpSessionId : own ?? undefined;
      let connected = !!profileId && !!sessionsByProfile[profileId];
      /** 要现连：这条消息得先等连接，界面不能因此变成「忙碌」。
       *  @成员时只要那条连接没建立就要连（成员自己的 session 还要单独 load）。 */
      const needConnect = target
        ? !sessionsByProfile[target.profileId]
        : !!profileId && !connected;
      const connectNoteId = `conn-note-${Date.now()}`;

      // 用户消息先上屏，真假链路都一样；落库等拿到回执或明确失败后再做。
      // 只有真要发 prompt 时才置 busy —— 连接阶段置 busy 会把输入框锁住，
      // 而连接可能要几十秒，用户会以为界面卡死了（docs/desktop-ux.md §1.6）。
      const userMsg: Extract<Message, { role: "user" }> = {
        id: newId("u"),
        role: "user",
        atomKind: "text.user",
        text,
        at,
        turnId: null,
      };
      patchSession(sid, (s) => ({
        ...s,
        busy: !needConnect,
        msgs: [
          ...s.msgs,
          userMsg,
          ...(needConnect
            ? [
                {
                  id: connectNoteId,
                  role: "system" as const,
                  atomKind: "notice.system",
                  text: i18nText("app.notice.connecting"),
                  at,
                  turnId: null,
                },
              ]
            : []),
        ],
      }));
      // 用户消息也要显式表态：拿到后端回执就带真 turnId；没发出去的路径显式 nonTurn。
      // 不再先写一条 NULL 再补 id —— 写入口已经不允许静默 NULL。
      const persistUserMessage = (turnId?: string) => {
        const payload = turnId ? { ...userMsg, turnId } : userMsg;
        messagesAppend(sid, [
          {
            id: userMsg.id,
            role: "user",
            kind: "text",
            payload,
            ...(turnId ? { turnId } : { nonTurn: true }),
          },
        ]).catch((e) => console.warn("[db] append message failed", e));
      };

      if (needConnect && profileId) {
        // 无感启动的保底：打开会话时可能还没连上（或刚被断开），发消息这一下必须连上，
        // 否则用户会看到一条「演示」回答，而他以为自己在跟真 agent 说话。
        // 超过 10 秒还没回来就把提示改成「还在连」，免得用户只能盯着不动的一句话。
        const slow = window.setTimeout(() => {
          patchSession(sid, (s) => ({
            ...s,
            msgs: s.msgs.map((m) =>
              m.id === connectNoteId
                ? { ...m, text: i18nText("app.notice.connectSlow") }
                : m,
            ),
          }));
        }, 10_000);
        // 带上本次发消息的会话：连接成功后的映射指到这里，而不是「当前打开的那个」
        const r = await ensureConnected(profileId, sid);
        window.clearTimeout(slow);
        // 提示用完就撤，不要留在消息流里
        patchSession(sid, (s) => ({
          ...s,
          msgs: s.msgs.filter((m) => m.id !== connectNoteId),
        }));
        if (r.error) {
          setBusy(sid, false);
          persistUserMessage();
          // 失败原因必须落库，否则恢复会话后只剩一条没人答的提问
          pushSystemNotice(
            patchSession,
            sid,
            i18nText("app.notice.connectFailed", {
              code: r.error!.code,
              msg: r.error!.msg,
            }),
          );
          return;
        }
        if (r.resume) onResume(sid, r.resume, r.lastEventSeq);
        if (r.resume?.kind === "unavailable") {
          // 「续不上」只由会话的连接态表达（docs/desktop-ux.md §8）：上面 onResume 已经把它交给
          // connectProblem，那块居中错误态正在渲染。再往消息流里塞一枚药丸，就是同一件事的两个面孔 ——
          // 而且那条会落库，重开会话后还留在历史里，看起来像一条假消息。
          setBusy(sid, false);
          persistUserMessage();
          return;
        }
        acpSid = target ? target.acpSessionId : undefined;
        connected = true;
        // 连接期间后端可能已经为这条界面会话建好并绑定了 ACP 会话；
        // 这里重新读 own，绝不把「连接当前会话」当成它的投递目标。
        own = target ? null : acpSessionOf(sid);
        if (!target) acpSid = own ?? undefined;
        // 连上了，接下来真要发 prompt
        patchSession(sid, (s) => ({ ...s, busy: true }));
      }

      const plan = target
        ? "target"
        : resolveSendTarget({ own, connected });
      if (plan === "create" && profileId) {
        // 新界面会话的第一条消息：在这个已连上的进程里真建一条自己的 ACP 会话。
        // 失败就是这一条发不出去，给系统提示并落库留痕，不静默重试、也不退回连接当前会话。
        try {
          const info = await sessionNew(profileId, cwdOf(sid, profileId), sid);
          acpSid = info.sessionId;
          onSessionCreated(sid, profileId, info.sessionId, info.modes ?? null);
        } catch (e) {
          const err = asCmdError(e);
          setBusy(sid, false);
          persistUserMessage();
          pushSystemNotice(
            patchSession,
            sid,
            i18nText("app.notice.newSessionFailed", { code: err.code, msg: err.msg }),
          );
          return;
        }
      }

      if (acpSid && target) {
        // 成员的会话必须在那个进程里「活着」，否则 prompt 只会拿到 not_found。
        // 放在这里而不是连接时做：成员可能来自别的会话，连接阶段并不知道要 load 谁。
        try {
          const loaded = await sessionLoad(target.profileId, target.acpSessionId, target.cwd, sid);
          onResume(sid, loaded.resume, loaded.lastEventSeq ?? null);
          if (loaded.resume.kind === "unavailable") {
            setBusy(sid, false);
            persistUserMessage();
            // 成员会话不属于「这个会话打不开」，主会话是好着的 —— 它是一次真实的发送失败，落库是对的。
            pushSystemNotice(
              patchSession,
              sid,
              i18nText("app.notice.memberResumeFailed", { reason: loaded.resume.reason }),
            );
            return;
          }
        } catch (e) {
          const err = asCmdError(e);
          setBusy(sid, false);
          persistUserMessage();
          pushSystemNotice(
            patchSession,
            sid,
            i18nText("app.notice.memberResumeError", { code: err.code, msg: err.msg }),
          );
          return;
        }
      }

      if (acpSid) {
        const actId = `act-stream-${acpSid}`;
        // 占位 id 只做本地 key：绝不允许带着 turn-live- 落库，收到后端回执后立刻替换。
        const turnId = newId("turn-live");
        acpToTurn.current[acpSid] = turnId;
        const trace: ActiveSendTrace = {
          startedAt: Date.now(),
          busyAtSend,
          sawStream: false,
          stopReason: null,
          resolvedAt: null,
          uiSid: sid,
          userMsg,
          turnId,
          userPersisted: false,
          absorbed: false,
        };
        acp.sendTraces.current[acpSid] = trace;
        // 归属由后端按会话记录投递（docs/desktop-ux.md「事件路由」），
        // 这里只记「这一轮的 turn id」，供轨迹栏把回答挂到对应分支上。

        patchSession(sid, (s) => ({
          ...s,
          acts: [
            ...s.acts.filter((a) => a.id !== actId),
            {
              id: actId,
              playerId: target?.authorId ?? MAIN_AGENT_ID,
              kind: "thinking" as const,
              title: i18nText("thinking.running"),
              status: "running" as const,
              at,
            },
          ],
          turns: [
            ...s.turns,
            {
              id: turnId,
              at,
              branches: [
                {
                  playerId: target?.authorId ?? MAIN_AGENT_ID,
                  activityIds: [actId],
                  status: "running" as const,
                },
              ],
            },
          ],
        }));

        clog(
          "SEND",
          `acp=${acpSid} ui=${sid} target=${target ? `member:${target.authorId}` : "main"} len=${text.length}`,
        );
        void sessionPrompt(acpSid, text, sid)
          .then(({ turnId: realTurnId }) => {
            trace.turnId = realTurnId;
            // 后端是轮次身份的唯一来源：本地占位只负责让 UI 先有东西可挂。
            if (acpToTurn.current[acpSid] === turnId) {
              acpToTurn.current[acpSid] = realTurnId;
            }
            patchSession(sid, (s) => ({
              ...s,
              turns: replaceTurnId(s.turns, turnId, realTurnId),
              // 用户消息与已经开流的回答都补上后端真 id。占位 id 只是本地 key，
              // 不落库；界面上的锚点必须指向真轮，否则「在轨迹里看这一轮」会找不到。
              msgs: s.msgs.map((m) =>
                m.id === userMsg.id
                  ? { ...m, turnId: realTurnId }
                  : m.role === "player" && m.streaming && !m.turnId
                    ? { ...m, turnId: realTurnId }
                    : m,
              ),
            }));
            if (!busyAtSend && !trace.absorbed && !trace.userPersisted) {
              trace.userPersisted = true;
              persistUserMessage(realTurnId);
            }
          })
          .catch((e) => {
            const err = asCmdError(e);
            setBusy(sid, false);
            if (!trace.absorbed && !trace.userPersisted) {
              trace.userPersisted = true;
              persistUserMessage();
            }
            if (acp.sendTraces.current[acpSid] === trace) {
              delete acp.sendTraces.current[acpSid];
            }
            pushSystemNotice(
              patchSession,
              sid,
              i18nText("app.notice.sendFailed", { code: err.code, msg: err.msg }),
            );
          });
        return;
      }

      // 走到这里说明这个会话根本没有可用的连接配置。
      // 以前这里会走「演示链路」编几条假回答 —— 那是在骗用户：他看着像群里有 agent 说话，
      // 其实一个字都没发出去。现在直接说清楚，并把他引到设置页。
      setBusy(sid, false);
      persistUserMessage();
      pushSystemNotice(
        patchSession,
        sid,
        i18nText("app.notice.noConnectionProfile"),
      );
    },
    [
      lastSessionId,
      patchSession,
      contextMessages,
      activeProfile,
      sessionsByProfile,
      acpSessionOf,
      cwdOf,
      onSessionCreated,
      acp,
      profileIdOf,
      ensureConnected,
      onResume,
    ],
  );

  return { send };
}
