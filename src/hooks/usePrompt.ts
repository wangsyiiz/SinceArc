import { useCallback } from "react";
import {
  asCmdError,
  messagesAppend,
  sessionLoad,
  sessionPrompt,
  type ResumeOutcome,
} from "@/lib/ipc";
import { now } from "@/lib/format";
import { pushSystemNotice } from "@/lib/notices";
import { clog } from "@/lib/log";
import { newId } from "@/lib/ids";
import type { AgentProfile, Message } from "@/types";
import type { EnsureResult } from "./useAgentConnect";
import type { AcpRefs } from "./useAcpEvents";
import type { PatchSession } from "./useSessionState";

/** 主 agent 的发言用一个固定 id：玩家表里没有它时，消息会渲染成「agent」 */
// 定义在 lib/main-agent.ts（无依赖）：这里 import + 再导出，既保持既有 import 路径，
// 也让本文件内部能直接用这个名字
import { MAIN_AGENT_ID } from "@/lib/main-agent";
export { MAIN_AGENT_ID };

export function usePrompt({
  lastSessionId,
  patchSession,
  activeProfile,
  sessionsByProfile,
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
    ) => {
      const sid = lastSessionId;
      const at = now();

      // 归属：会话自己的连接优先，老会话（没记 profileId）退回当前选中。
      // @ 了成员时，归属变成那个成员所在的连接。
      const profileId = target?.profileId ?? profileIdOf(sid) ?? activeProfile?.id ?? null;
      let acpSid = target ? target.acpSessionId : profileId ? sessionsByProfile[profileId] : undefined;
      /** 要现连：这条消息得先等连接，界面不能因此变成「忙碌」。
       *  @成员时只要那条连接没建立就要连（成员自己的 session 还要单独 load）。 */
      const needConnect = target
        ? !sessionsByProfile[target.profileId]
        : !acpSid && !!profileId;
      const connectNoteId = `conn-note-${Date.now()}`;

      // 用户消息先落地，真假链路都一样。
      // 只有真要发 prompt 时才置 busy —— 连接阶段置 busy 会把输入框锁住，
      // 而连接可能要几十秒，用户会以为界面卡死了（docs/desktop-ux.md §1.6）。
      const userMsg: Message = { id: newId("u"), role: "user", text, at };
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
                  text: "正在连接 agent…（连接期间可以继续操作界面）",
                  at,
                },
              ]
            : []),
        ],
      }));
      messagesAppend(sid, [
        { id: userMsg.id, role: "user", kind: "text", payload: userMsg },
      ]).catch((e) => console.warn("[db] append message failed", e));

      if (needConnect && profileId) {
        // 无感启动的保底：打开会话时可能还没连上（或刚被断开），发消息这一下必须连上，
        // 否则用户会看到一条「演示」回答，而他以为自己在跟真 agent 说话。
        // 超过 10 秒还没回来就把提示改成「还在连」，免得用户只能盯着不动的一句话。
        const slow = window.setTimeout(() => {
          patchSession(sid, (s) => ({
            ...s,
            msgs: s.msgs.map((m) =>
              m.id === connectNoteId
                ? { ...m, text: "还在连接 agent…（握手较慢，界面可以继续操作）" }
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
          // 失败原因必须落库，否则恢复会话后只剩一条没人答的提问
          pushSystemNotice(patchSession, sid, `连接失败：${r.error!.code} ${r.error!.msg}`);
          return;
        }
        if (r.resume) onResume(sid, r.resume, r.lastEventSeq);
        if (r.resume?.kind === "unavailable") {
          setBusy(sid, false);
          pushSystemNotice(patchSession, sid, `续不上：${r.resume.reason}`);
          return;
        }
        acpSid = target ? target.acpSessionId : (r.acpSid ?? undefined);
        // 连上了，接下来真要发 prompt
        patchSession(sid, (s) => ({ ...s, busy: true }));
      }

      if (acpSid && target) {
        // 成员的会话必须在那个进程里「活着」，否则 prompt 只会拿到 not_found。
        // 放在这里而不是连接时做：成员可能来自别的会话，连接阶段并不知道要 load 谁。
        try {
          const loaded = await sessionLoad(target.profileId, target.acpSessionId, target.cwd, sid);
          onResume(sid, loaded.resume, loaded.lastEventSeq ?? null);
          if (loaded.resume.kind === "unavailable") {
            setBusy(sid, false);
            pushSystemNotice(patchSession, sid, `续不上：${loaded.resume.reason}`);
            return;
          }
        } catch (e) {
          const err = asCmdError(e);
          setBusy(sid, false);
          pushSystemNotice(patchSession, sid, `无法恢复成员会话：${err.code} ${err.msg}`);
          return;
        }
      }

      if (acpSid) {
        const actId = `act-stream-${acpSid}`;
        const turnId = `turn-live-${Date.now()}`;
        acpToTurn.current[acpSid] = turnId;
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
              title: "思考中",
              status: "running" as const,
              at,
            },
          ],
          turns: [
            ...s.turns,
            {
              id: turnId,
              at,
              userText: text,
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
        sessionPrompt(acpSid, text, sid).catch((e) => {
          const err = asCmdError(e);
          setBusy(sid, false);
          pushSystemNotice(patchSession, sid, `发送失败：${err.code} ${err.msg}`);
        });
        return;
      }

      // 走到这里说明这个会话根本没有可用的连接配置。
      // 以前这里会走「演示链路」编几条假回答 —— 那是在骗用户：他看着像群里有 agent 说话，
      // 其实一个字都没发出去。现在直接说清楚，并把他引到设置页。
      setBusy(sid, false);
      pushSystemNotice(
        patchSession,
        sid,
        "这个会话没有可用的连接配置 —— 去「设置 → 连接」加一条并连上，再发一次。",
      );
    },
    [
      lastSessionId,
      patchSession,
      contextMessages,
      activeProfile,
      sessionsByProfile,
      acp,
      profileIdOf,
      ensureConnected,
      onResume,
    ],
  );

  return { send };
}
