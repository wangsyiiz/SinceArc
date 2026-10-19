import { cn } from "@/lib/utils";

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Dir = "North" | "South" | "East" | "West" | "NorthEast" | "NorthWest" | "SouthEast" | "SouthWest";

// 无边框窗口没有系统 resize 边，自己补 8 个把手（Tauri v2 支持 startResizeDragging）
const HANDLES: { dir: Dir; className: string }[] = [
  { dir: "North", className: "left-2 right-2 top-0 h-1.5 cursor-ns-resize" },
  { dir: "South", className: "left-2 right-2 bottom-0 h-1.5 cursor-ns-resize" },
  { dir: "West", className: "top-2 bottom-2 left-0 w-1.5 cursor-ew-resize" },
  { dir: "East", className: "top-2 bottom-2 right-0 w-1.5 cursor-ew-resize" },
  { dir: "NorthWest", className: "left-0 top-0 size-2.5 cursor-nwse-resize" },
  { dir: "NorthEast", className: "right-0 top-0 size-2.5 cursor-nesw-resize" },
  { dir: "SouthWest", className: "left-0 bottom-0 size-2.5 cursor-nesw-resize" },
  { dir: "SouthEast", className: "right-0 bottom-0 size-2.5 cursor-nwse-resize" },
];

async function startResize(dir: Dir) {
  if (!IN_TAURI) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startResizeDragging(dir);
}

export function ResizeHandles() {
  if (!IN_TAURI) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {HANDLES.map((h) => (
        <div
          key={h.dir}
          onMouseDown={(e) => {
            e.preventDefault();
            void startResize(h.dir);
          }}
          className={cn("pointer-events-auto absolute", h.className)}
        />
      ))}
    </div>
  );
}
