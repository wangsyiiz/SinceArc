import { useEffect, useRef, useState } from "react";
import { safeCut, stepTextTween } from "@/lib/text-tween";

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

export function useTweenedText(input: {
  text: string;
  streaming: boolean;
  enabled: boolean;
}): string {
  const { text, streaming, enabled } = input;
  const reducedMotion = usePrefersReducedMotion(enabled);
  const [show, setShow] = useState(() => (streaming ? 0 : text.length));
  const showRef = useRef(show);
  const active = enabled && streaming && !reducedMotion;
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!active) {
      // 渲染读的是 show 而不是 showRef：两条路径都得对齐，否则关掉补间再打开时，
      // show 会停在旧值、而 showRef 已经等于全文 —— 没有 rAF 再把它推上去，
      // 显示长度就永久停在偏短那一截（R2/R5 的静默违反）。
      showRef.current = text.length;
      setShow(text.length);
      return;
    }

    if (text.length < showRef.current) {
      showRef.current = text.length;
      setShow(text.length);
      return;
    }

    if (showRef.current >= text.length) return;

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      if (!activeRef.current) return;
      const dtMs = Math.min(100, now - last);
      last = now;
      const next = stepTextTween({
        show: showRef.current,
        target: text.length,
        dtMs,
      });
      showRef.current = next;
      setShow(next);
      if (next < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => cancelAnimationFrame(raf);
  }, [active, text]);

  if (!enabled || !streaming || reducedMotion) return text;
  return text.slice(0, safeCut(text, Math.min(show, text.length)));
}
