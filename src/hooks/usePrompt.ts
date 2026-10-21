import { useCallback } from "react";
import { asCmdError, messagesAppend, sessionLoad, sessionPrompt } from "@/lib/ipc";
import { now } from "@/lib/format";
import { players } from "@/mock/data";
import type { AgentProfile, Message } from "@/types";
import type { EnsureResult } from "./useAgentConnect";
import type { AcpRefs } from "./useAcpEvents";
import type { PatchSession } from "./useSessionState";

export function usePrompt({
  lastSessionId,
  patchSession,
  activeProfile,
  sessionsByProfile,
  contextMessages,
  acp,
  profileIdOf,
  ensureConnected,
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
  ensureConnected: (profileId: string | null | undefined) => Promise<EnsureResult>;
}) {
  const { acpToUi, acpToTurn, acpToAuthor, activeAcp } = acp;

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
      const userMsg: Message = { id: `u-${Date.now()}`, role: "user", text, at };
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
        const r = await ensureConnected(profileId);
        window.clearTimeout(slow);
        // 提示用完就撤，不要留在消息流里
        patchSession(sid, (s) => ({
          ...s,
          msgs: s.msgs.filter((m) => m.id !== connectNoteId),
        }));
        if (r.error) {
          patchSession(sid, (s) => ({
            ...s,
            busy: false,
            msgs: [
              ...s.msgs,
              {
                id: `conn-err-${Date.now()}`,
                role: "system",
                text: `连接失败：${r.error!.code} ${r.error!.msg}`,
                at: now(),
              },
            ],
          }));
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
          await sessionLoad(target.profileId, target.acpSessionId, target.cwd);
        } catch (e) {
          const err = asCmdError(e);
          patchSession(sid, (s) => ({
            ...s,
            busy: false,
            msgs: [
              ...s.msgs,
              {
                id: `load-err-${Date.now()}`,
                role: "system",
                text: `无法恢复成员会话：${err.code} ${err.msg}`,
                at: now(),
              },
            ],
          }));
          return;
        }
        acpToAuthor.current[acpSid] = target.authorId;
      }

      if (acpSid) {
        const actId = `act-stream-${acpSid}`;
        const turnId = `turn-live-${Date.now()}`;
        acpToTurn.current[acpSid] = turnId;
        // 事件回来要落到「这次发消息的那个会话」，而不是连接时的快照
        acpToUi.current[acpSid] = sid;
        activeAcp.current = acpSid;

        patchSession(sid, (s) => ({
          ...s,
          acts: [
            ...s.acts.filter((a) => a.id !== actId),
            {
              id: actId,
              playerId: target?.authorId ?? players[0].id,
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
                  playerId: target?.authorId ?? players[0].id,
                  activityIds: [actId],
                  status: "running" as const,
                },
              ],
            },
          ],
        }));

        sessionPrompt(acpSid, text).catch((e) => {
          const err = asCmdError(e);
          patchSession(sid, (s) => ({
            ...s,
            busy: false,
            msgs: [
              ...s.msgs,
              {
                id: `err-${Date.now()}`,
                role: "system",
                text: `发送失败：${err.code} ${err.msg}`,
                at,
              },
            ],
          }));
        });
        return;
      }

      // 走到这里说明这个会话根本没有可用的连接配置：保留演示链路，
      // 这样「刚装好还没配连接」的新用户也有东西可看。
      const hits = players.filter((p) => text.includes(`@${p.handle}`));
      const targets = hits.length > 0 ? hits : [players[0]];
      const turnId = `t-${Date.now()}`;
      const actIds = targets.map((p, i) => `a-${Date.now()}-${i}-${p.id}`);

      patchSession(sid, (s) => ({
        ...s,
        acts: [
          ...s.acts,
          ...targets.map((p, i) => ({
            id: actIds[i],
            playerId: p.id,
            kind: "thinking" as const,
            title: "思考中",
            status: "running" as const,
            at,
          })),
        ],
        turns: [
          ...s.turns,
          {
            id: turnId,
            at,
            userText: text,
            branches: targets.map((p, i) => ({
              playerId: p.id,
              activityIds: [actIds[i]],
              status: "running" as const,
            })),
          },
        ],
      }));

      let left = targets.length;
      targets.forEach((p, i) => {
        const actId = actIds[i];
        window.setTimeout(
          () => {
            const answer = `（演示）这条本该由 ${p.name} 的 session 回答。接入后，群聊里 ${contextMessages} 条上下文会作为前缀附在 prompt 里。`;
            patchSession(sid, (s) => ({
              ...s,
              acts: s.acts.map((a) =>
                a.id === actId ? { ...a, status: "ok" as const, title: "已答复" } : a,
              ),
              turns: s.turns.map((t) =>
                t.id === turnId
                  ? {
                      ...t,
                      branches: t.branches.map((b) =>
                        b.playerId === p.id
                          ? { ...b, reply: answer, status: "done" as const }
                          : b,
                      ),
                    }
                  : t,
              ),
              msgs: [
                ...s.msgs,
                {
                  id: `p-${Date.now()}-${p.id}`,
                  role: "player",
                  playerId: p.id,
                  text: answer,
                  at: now(),
                },
              ],
              busy: false,
            }));
            left -= 1;
            if (left === 0) patchSession(sid, (s) => ({ ...s, busy: false }));
          },
          900 + i * 700,
        );
      });
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
    ],
  );

  return { send };
}
