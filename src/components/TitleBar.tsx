import { Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentProfile } from "@/types";

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function withWindow(fn: (w: { minimize: () => Promise<void>; toggleMaximize: () => Promise<void>; close: () => Promise<void> }) => Promise<void>) {
  if (!IN_TAURI) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await fn(getCurrentWindow());
}

interface TitleBarProps {
  profile: AgentProfile | undefined;
  cwd: string;
}

export function TitleBar({ profile, cwd }: TitleBarProps) {
  const drag = { "data-tauri-drag-region": true } as const;

  return (
    <div
      {...drag}
      className="flex h-9 shrink-0 items-center gap-3 px-3 select-none"
      onDoubleClick={() => void withWindow((w) => w.toggleMaximize())}
    >
      <div className="flex items-center gap-2" {...drag}>
        <span className="grid size-5 place-items-center rounded-[6px] bg-accent-1/15 text-[11px] leading-none text-accent-1">
          ◇
        </span>
        <span className="text-[12px] font-semibold tracking-tight text-ink-1" {...drag}>
          SinceArc
        </span>
        <span className="text-[10.5px] text-ink-3" {...drag}>
          ACP
        </span>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-1.5" {...drag}>
        <span className="size-1 shrink-0 rounded-full bg-ok-1/70" {...drag} />
        <span className="truncate font-mono text-[10.5px] text-ink-3" {...drag}>
          {profile ? profile.detail : "未连接"} · {cwd}
        </span>
      </div>

      <div className="flex items-center gap-0.5">
        <WinButton label="最小化" onClick={() => void withWindow((w) => w.minimize())}>
          <Minus className="size-3.5" />
        </WinButton>
        <WinButton label="最大化" onClick={() => void withWindow((w) => w.toggleMaximize())}>
          <Square className="size-3" />
        </WinButton>
        <WinButton label="关闭" danger onClick={() => void withWindow((w) => w.close())}>
          <X className="size-3.5" />
        </WinButton>
      </div>
    </div>
  );
}

function WinButton({
  children,
  label,
  danger,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid h-7 w-9 place-items-center rounded-md text-ink-2 transition-colors",
        danger
          ? "hover:bg-danger-1/85 hover:text-white"
          : "hover:bg-white/[0.07] hover:text-ink-1",
      )}
    >
      {children}
    </button>
  );
}
