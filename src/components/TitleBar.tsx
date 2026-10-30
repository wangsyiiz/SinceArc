import { Minus, Square, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { AgentProfile } from "@/types";
import { BrandMark } from "./BrandMark";
import { GhIdentity } from "./GhIdentity";
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
  const { t } = useTranslation();
  const drag = { "data-tauri-drag-region": "" } as const;

  return (
    <div
      {...drag}
      className="flex h-9 shrink-0 items-stretch select-none"
    >
      <div className="flex items-center gap-2 pl-3.5" {...drag}>
        <BrandMark className="size-5" />
        <span className="sc-brand-glow text-ui font-semibold text-ink-1" {...drag}>
          SinceArc
        </span>
      </div>

      <div className="flex min-w-0 flex-1 items-center gap-1.5 px-3" {...drag}>
        <span className="flex shrink-0 items-center" {...drag}>
          <StatusDot status={profile?.connected ? "connected" : "untested"} />
        </span>
        <span className="truncate font-mono text-caption text-ink-3" {...drag}>
          {profile ? profile.detail : t("statusbar.profile.statusDisconnected")} · {cwd}
        </span>
      </div>

      <div className="flex h-9 shrink-0 items-center pr-1">
        <GhIdentity />
      </div>

      {/* 仿 Windows 原生：46×36、贴边、无圆角、无间距 */}
      <div className="flex items-stretch">
        <WinButton label={t("ui.titleBar.minimize")} onClick={() => void withWindow((w) => w.minimize())}>
          <Minus className="size-3" strokeWidth={1.6} />
        </WinButton>
        <WinButton label={t("ui.titleBar.maximize")} onClick={() => void withWindow((w) => w.toggleMaximize())}>
          <Square className="size-2.5" strokeWidth={1.6} />
        </WinButton>
        <WinButton label={t("ui.titleBar.close")} close onClick={() => void withWindow((w) => w.close())}>
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
      aria-label={label}
      onClick={onClick}
      className={cn(
        "sc-winbtn grid w-11.5 place-items-center transition-colors duration-75",
        close && "sc-winbtn-close",
      )}
    >
      {children}
    </button>
  );
}
