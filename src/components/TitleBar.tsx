import { GitPullRequest, Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AgentProfile } from "@/types";

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
  githubOpen: boolean;
  onOpenGithub: () => void;
}

export function TitleBar({ profile, cwd, githubOpen, onOpenGithub }: TitleBarProps) {
  const drag = { "data-tauri-drag-region": "" } as const;

  return (
    <div
      {...drag}
      className="flex h-9 shrink-0 items-stretch select-none"
    >
      <div className="flex items-center gap-2 pl-3.5" {...drag}>
        <span
          className="grid size-5 place-items-center rounded-[6px] bg-white/[0.06] text-[12px] leading-none text-ink-1"
          {...drag}
        >
          ◇
        </span>
        <span className="text-[13.5px] font-semibold tracking-[-0.01em] text-ink-1" {...drag}>
          SinceArc
        </span>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3" {...drag}>
        <span className="size-1 shrink-0 rounded-full bg-ok-1/80" {...drag} />
        <span className="truncate font-mono text-[10.5px] text-ink-3" {...drag}>
          {profile ? profile.detail : "未连接"} · {cwd}
        </span>
      </div>

      {/* 仿 Windows 原生：46×36、贴边、无圆角、无间距 */}
      <div className="flex items-stretch">
        <WinButton label="GitHub" active={githubOpen} onClick={onOpenGithub}>
          <GitPullRequest className="size-3.5" strokeWidth={1.6} />
        </WinButton>
        <span className="my-2 w-px shrink-0 bg-white/[0.07]" />
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
  active,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  close?: boolean;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        "grid w-[46px] place-items-center text-ink-2 transition-colors duration-[80ms]",
        close
          ? "hover:bg-[#c42b1c] hover:text-white active:bg-[#b02617]"
          : "hover:bg-white/[0.07] hover:text-ink-1 active:bg-white/[0.11]",
        active && !close && "bg-white/[0.07] text-ink-1",
      )}
    >
      {children}
    </button>
  );
}
