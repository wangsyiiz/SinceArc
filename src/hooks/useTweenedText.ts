import { useEffect, useRef, useState } from "react";
import { SEAL_BUDGET_MS, safeCut, stepTextTween } from "@/lib/text-tween";

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function usePrefersReducedMotion(enabled: boolean): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(media.matches);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [enabled]);

  return reduced;
}

/**
 * 显示长度追着到达长度走（docs/desktop-ux.md §14）。
 *
 * 三个出口要分清：
 * - `enabled=false` 或系统「减少动态效果」→ 原样返回 `text`，不挂 rAF、不加包裹（R8 的逐字节一致）；
 * - `snapNow`（用户点了停止 / 这一轮出错）→ 同一帧返回全文，不做收口追帧（R4）；
 * - 正常结束 → 从收口那一刻起 `SEAL_BUDGET_MS` 内把剩下的补完（R4 的有界追帧）。
 */
export function useTweenedText(input: {
  text: string;
  streaming: boolean;
  /** 停止 / 出错：当帧拉满，不许再演 */
  snapNow: boolean;
  enabled: boolean;
}): string {
  const { text, streaming, snapNow, enabled } = input;
  const reducedMotion = usePrefersReducedMotion(enabled);
  const immediate = !enabled || reducedMotion || snapNow;

  const [show, setShow] = useState(() => (streaming ? 0 : text.length));
  const showRef = useRef(show);
  /** 收口追帧的截止时刻；null = 没在收口追帧（仍在流式，或已经追完）。 */
  const deadlineRef = useRef<number | null>(null);

  useEffect(() => {
    if (immediate) {
      // 渲染读的是 show 而不是 showRef：两条路径都得对齐，否则关掉补间再打开时，
      // show 会停在旧值、而 showRef 已经等于全文 —— 没有 rAF 再把它推上去，
      // 显示长度就永久停在偏短那一截（R2/R5 的静默违反）。
      showRef.current = text.length;
      setShow(text.length);
      deadlineRef.current = null;
      return;
    }

    if (text.length < showRef.current) {
      // R5：只补增长。倒退（换文本 / 读库回填）直接对齐，不演动画。
      showRef.current = text.length;
      setShow(text.length);
      deadlineRef.current = null;
      return;
    }

    if (showRef.current >= text.length) {
      deadlineRef.current = null;
      return;
    }

    if (streaming) {
      deadlineRef.current = null;
    } else if (deadlineRef.current === null) {
      // 收口那一刻开始计时；之后再来分片也不重置 —— 总预算不许被无限续期。
      deadlineRef.current = performance.now() + SEAL_BUDGET_MS;
    }

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dtMs = Math.min(100, now - last);
      last = now;
      const remainingMs = deadlineRef.current === null ? undefined : deadlineRef.current - now;
      const next = stepTextTween({
        show: showRef.current,
        target: text.length,
        dtMs,
        remainingMs,
      });
      showRef.current = next;
      setShow(next);
      if (next < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [immediate, streaming, text]);

  if (immediate) return text;
  return text.slice(0, safeCut(text, Math.min(show, text.length)));
}
