import { Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentProfile } from "@/types";
import { StatusDot } from "./ui/Badge";

const IN_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function withWindow(
  fn: (w: {
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    close: () => Promise<void>;
  }) => Promise<void>,
) {
  if (!IN_TAURI) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await fn(getCurrentWindow());
}

interface TitleBarProps {
  profile: AgentProfile | undefined;
  cwd: string;
}

export function TitleBar({ profile, cwd }: TitleBarProps) {
  const drag = { "data-tauri-drag-region": "" } as const;

  return (
    <div
      {...drag}
      className="flex h-9 shrink-0 items-stretch select-none"
    >
      <div className="flex items-center gap-2 pl-3.5" {...drag}>
        <span
          className="grid size-5 place-items-center rounded-mark bg-surface-3/55 text-small leading-none text-ink-1"
          {...drag}
        >
          ◇
        </span>
        <span className="text-ui font-semibold text-ink-1" {...drag}>
          SinceArc
        </span>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3" {...drag}>
        <span className="flex shrink-0 items-center" {...drag}>
          <StatusDot status={profile?.connected ? "connected" : "untested"} />
        </span>
        <span className="truncate font-mono text-caption text-ink-3" {...drag}>
          {profile ? profile.detail : "未连接"} · {cwd}
        </span>
      </div>

      {/* 仿 Windows 原生：46×36、贴边、无圆角、无间距 */}
      <div className="flex items-stretch">
        <WinButton label="最小化" onClick={() => void withWindow((w) => w.minimize())}>
          <Minus className="size-3" strokeWidth={1.6} />
        </WinButton>
        <WinButton label="最大化" onClick={() => void withWindow((w) => w.toggleMaximize())}>
          <Square className="size-2.5" strokeWidth={1.6} />
        </WinButton>
        <WinButton label="关闭" close onClick={() => void withWindow((w) => w.close())}>
          <X className="size-3" strokeWidth={1.6} />
        </WinButton>
      </div>
    </div>
  );
}

function WinButton({
  children,
  label,
  close,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  close?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid w-11.5 place-items-center text-ink-2 transition-colors duration-75",
        close
          ? "hover:bg-danger-1 hover:text-accent-ink active:bg-danger-1 active:brightness-95"
          : "hover:bg-surface-3/65 hover:text-ink-1 active:bg-surface-3",
      )}
    >
      {children}
    </button>
  );
}
