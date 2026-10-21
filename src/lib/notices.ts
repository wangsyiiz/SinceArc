import { messagesAppend } from "@/lib/ipc";
import { now } from "@/lib/format";
import type { Message } from "@/types";
import type { PatchSession } from "@/hooks/useSessionState";

/**
 * 系统提示（连接失败 / 这一轮失败 / @ 不到人 / 没有连接配置）必须**同时**落库。
 *
 * 以前它们只活在内存里：重启或切会话回来，历史就变成「问了却没人答」，
 * 用户完全看不出当时是失败了、还是回答丢了 —— 实测就踩到过
 * 「恢复的会话里连着五条我的消息，中间一条回复都没有」。
 *
 * 落库用 role="system"，恢复时与当时看到的一模一样。
 */
export function pushSystemNotice(
  patchSession: PatchSession,
  sid: string,
  text: string,
  opts?: { also?: (m: Message) => Message },
): Message {
  const at = now();
  const msg: Message = { id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, role: "system", text, at };
  patchSession(sid, (s) => ({ ...s, msgs: [...s.msgs, msg] }));
  messagesAppend(sid, [
    { id: msg.id, role: "system", kind: "text", payload: opts?.also ? opts.also(msg) : msg },
  ]).catch((e) => console.warn("[db] append system notice failed", e));
  return msg;
}
