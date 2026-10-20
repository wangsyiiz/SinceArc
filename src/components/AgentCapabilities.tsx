import { useEffect, useRef, useState } from "react";
import { Sparkles, Terminal } from "lucide-react";
import type { AgentCommand, AgentProfile } from "@/types";
import { previewCommand } from "@/extensions/registry";
import { cn } from "@/lib/utils";

interface AgentCapabilitiesProps {
  profile: AgentProfile | undefined;
  commands: AgentCommand[];
}

/**
 * ACP 之外的能力入口。
 *
 * 只在探测到扩展时渲染：未知 agent 上这个按钮根本不存在，
 * 而不是「存在但点了报错」——缺席要能被看见。
 */
export function AgentCapabilities({ profile, commands }: AgentCapabilitiesProps) {
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<AgentCommand | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  if (commands.length === 0) return null;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-[6px] px-2 text-[11px] transition-colors",
          open ? "bg-surface-3/65 text-ink-1" : "text-ink-2 hover:bg-surface-3/55 hover:text-ink-1",
        )}
      >
        <Sparkles className="size-3" />
        能力
        <span className="font-mono text-[9px] text-ink-3">{commands.length}</span>
      </button>

      {open && (
        <div className="sc-glass absolute top-full right-0 z-30 mt-1.5 w-[320px] rounded-[10px] p-1">
          <div className="px-2 py-1.5 text-[9.5px] tracking-wide text-ink-3">
            ACP 之外的 {commands.length} 项
          </div>
          {commands.map((c) => {
            const active = picked?.id === c.id;
            return (
              <button
                key={c.id}
                onClick={() => setPicked(active ? null : c)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-[6px] px-2 py-1.5 text-left transition-colors",
                  active ? "sc-row-active" : "hover:bg-surface-3/45",
                )}
              >
                <Terminal className="mt-[3px] size-3 shrink-0 text-ink-3" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[11.5px] text-ink-1">{c.label}</span>
                    <span className="shrink-0 font-mono text-[9px] text-ink-3">
                      {c.argv.join(" ")}
                    </span>
                  </span>
                  {c.note && (
                    <span className="mt-0.5 block text-[10px] text-ink-3">{c.note}</span>
                  )}
                </span>
              </button>
            );
          })}

          {picked && (
            <div className="mt-1 border-t border-line-1/40 px-2 py-2">
              <div className="text-[9.5px] text-ink-3">将执行</div>
              <code className="mt-1 block break-all font-mono text-[10px] leading-relaxed text-ink-2">
                {previewCommand(profile, picked.argv)}
              </code>
              <p className="mt-1.5 text-[9.5px] leading-relaxed text-ink-3">
                未接线：目前只显示命令形态，不发起调用。
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
