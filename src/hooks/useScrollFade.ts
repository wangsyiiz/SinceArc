import { useEffect } from "react";

export function useScrollFade(): void {
  // 滚动条透明度：伪元素不参与 transition，所以渐变靠逐帧改根节点上的 --sb-alpha
  useEffect(() => {
    const root = document.documentElement;
    let hideTimer = 0;
    let raf = 0;
    let alpha = 0.28;
    let active = false;

    const apply = (v: number) => {
      alpha = v;
      root.style.setProperty("--sb-alpha", v.toFixed(3));
    };

    const animateTo = (target: number, duration: number) => {
      cancelAnimationFrame(raf);
      const from = alpha;
      const t0 = performance.now();
      const tick = (now: number) => {
        const p = Math.min(1, (now - t0) / duration);
        const eased = 1 - Math.pow(1 - p, 3); // ease-out cubic
        apply(from + (target - from) * eased);
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };

    const onScroll = () => {
      if (!active) {
        active = true;
        animateTo(0.85, 110); // 亮起来快
      }
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(() => {
        active = false;
        animateTo(0.28, 420); // 淡回去慢
      }, 600);
    };

    document.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("scroll", onScroll, true);
      window.clearTimeout(hideTimer);
      cancelAnimationFrame(raf);
    };
  }, []);
}
