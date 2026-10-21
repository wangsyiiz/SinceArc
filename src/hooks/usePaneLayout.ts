import { useEffect, useRef, useState } from "react";

export function usePaneLayout(traceOpen: boolean) {
  const [sidebarW, setSidebarW] = useState(260);
  const [traceW, setTraceW] = useState(338);
  const [dragging, setDragging] = useState(false);
  const layoutRef = useRef<HTMLDivElement>(null);
  const [layoutW, setLayoutW] = useState(0);

  // 量三栏容器宽度：分栏上限由「主区最小宽度」反推，不是硬编码
  useEffect(() => {
    const el = layoutRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setLayoutW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 主视图至少占一半；分栏上限由它反推
  const mainMin = Math.max(380, Math.round(layoutW / 2));
  const sidebarMax = Math.max(200, layoutW - (traceOpen ? traceW : 0) - mainMin - 12);
  const traceMax = Math.max(250, layoutW - sidebarW - mainMin - 12);

  // 窗口缩小时把超出的分栏拉回来
  useEffect(() => {
    if (!layoutW) return;
    setSidebarW((w) => Math.min(w, sidebarMax));
    setTraceW((w) => Math.min(w, traceMax));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutW, traceOpen]);

  return { sidebarW, setSidebarW, traceW, setTraceW, dragging, setDragging, layoutRef, mainMin, sidebarMax, traceMax };
}
