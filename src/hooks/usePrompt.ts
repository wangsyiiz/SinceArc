import { useCallback } from "react";
import { asCmdError, messagesAppend, sessionPrompt } from "@/lib/ipc";
import { now } from "@/lib/format";
import { players } from "@/mock/data";
import type { AgentProfile, Message } from "@/types";
import type { AcpRefs } from "./useAcpEvents";
import type { PatchSession } from "./useSessionState";

export function usePrompt({
  lastSessionId,
  patchSession,
  activeProfile,
  sessionsByProfile,
  contextMessages,
  acp,
}: {
  lastSessionId: string;
  patchSession: PatchSession;
  activeProfile: AgentProfile | undefined;
  sessionsByProfile: Record<string, string>;
  contextMessages: number;
  acp: AcpRefs;
}) {
  const { acpToUi, acpToTurn, activeAcp } = acp;

  const send = useCallback(
    (text: string) => {
      const sid = lastSessionId;
      const at = now();

      // 用户消息先落地，真假链路都一样
      const userMsg: Message = { id: `u-${Date.now()}`, role: "user", text, at };
      patchSession(sid, (s) => ({
        ...s,
        busy: true,
        msgs: [...s.msgs, userMsg],
      }));
      messagesAppend(sid, [
        { id: userMsg.id, role: "user", kind: "text", payload: userMsg },
      ]).catch((e) => console.warn("[db] append message failed", e));

      // 已连上真 agent：走 ACP；否则退回演示数据
      const acpSid = activeProfile ? sessionsByProfile[activeProfile.id] : undefined;
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
              playerId: players[0].id,
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
                  playerId: players[0].id,
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
    [lastSessionId, patchSession, contextMessages, activeProfile, sessionsByProfile, acp],
  );

  return { send };
}
