import { useRef } from "react";

interface SplitterProps {
  value: number;
  onChange: (n: number) => void;
  onDragChange?: (dragging: boolean) => void;
  min?: number;
  /** 不传则不设上限 */
  max?: number;
}

/** 竖向拖拽把手：占据分栏之间的 6px 间隙，hover 时显出一条细线 */
export function Splitter({ value, onChange, onDragChange, min = 200, max }: SplitterProps) {
  const drag = useRef<{ x: number; v: number } | null>(null);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      title="拖动调整宽度"
      onPointerDown={(e) => {
        drag.current = { x: e.clientX, v: value };
        onDragChange?.(true);
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const raw = drag.current.v + (e.clientX - drag.current.x);
        const next = max === undefined ? Math.max(min, raw) : Math.min(max, Math.max(min, raw));
        onChange(next);
      }}
      onPointerUp={(e) => {
        drag.current = null;
        onDragChange?.(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
      }}
      onPointerCancel={() => {
        drag.current = null;
        onDragChange?.(false);
      }}
      className="group relative w-1.5 shrink-0 cursor-col-resize touch-none select-none"
    >
      <div className="absolute inset-y-1 left-1/2 w-px -translate-x-1/2 rounded-full bg-transparent transition-colors group-hover:bg-line-2 group-active:bg-accent-1/70" />
    </div>
  );
}
