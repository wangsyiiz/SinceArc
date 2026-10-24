import { Sparkles } from "lucide-react";
import type { AgentProfile } from "@/types";
import { capsRows, type CapsGroup } from "@/lib/caps-format";
import type { CommandDto } from "@/lib/ipc/types.gen/CommandDto";
import { cn } from "@/lib/utils";
import { useAnchoredLayer } from "./ui/Menu";

interface AgentCapabilitiesProps {
  profile: AgentProfile | undefined;
  /** agent 通过 availableCommands 主动报上来的命令，只读展示 */
  acpCommands?: CommandDto[];
}

/**
 * 能力面板。两块内容严格分开，因为它们的来源不同：
 *
 * - **协议能力**：来自握手，每个 agent 都有，换 agent 后跟着变；
 * - **命令**：agent 通过 `availableCommands` 主动报上来的 `/+` 命令，只读展示。
 */
export function AgentCapabilities({ profile, acpCommands = [] }: AgentCapabilitiesProps) {
  const { triggerRef, panelRef, open, toggle, style } = useAnchoredLayer({
    align: "end",
    prefer: "below",
  });

  const rows = capsRows(profile?.caps ?? null);
  const groups: CapsGroup[] = ["输入", "会话", "MCP"];
  const supported = rows.filter((r) => r.on).length;
  const hasCommands = acpCommands.length > 0;
  const handshake = profile?.capsAt
    ? new Date(profile.capsAt * 1000).toLocaleString("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  // 既没握手过（caps = null）也没有 agent 命令 → 按钮不出现。
  // 握手过但一项都不支持时仍然显示：那本身就是「这个 agent 什么也不报」的事实。
  if (rows.length === 0 && acpCommands.length === 0) return null;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        title={profile?.agentName ?? undefined}
        className={cn(
          "flex h-7 items-center gap-1.5 rounded-mark px-2 text-caption transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-1",
          open ? "bg-surface-3/65 text-ink-1" : "text-ink-2 hover:bg-surface-3/55 hover:text-ink-1",
        )}
      >
        <Sparkles className="size-3" />
        能力
        <span className="font-mono text-micro text-ink-3">{supported}</span>
      </button>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Agent 能力"
          style={style}
          className={cn(
            "sc-glass sc-z-popover flex max-h-[min(70vh,34rem)] flex-col rounded-card p-1",
            hasCommands ? "w-128" : "w-80",
          )}
        >
          <div className="flex shrink-0 items-baseline justify-between gap-3 px-2 py-1.5">
            <span className="text-micro tracking-wide text-ink-3">Agent 能力</span>
            {handshake && (
              <span className="shrink-0 text-micro text-ink-3">{`握手 ${handshake}`}</span>
            )}
          </div>
          <div className="flex min-h-0 flex-1">
            <div
              className={cn(
                "min-h-0 px-1 pb-1",
                hasCommands
                  ? "w-52 shrink-0 overflow-y-auto overscroll-contain"
                  : "min-w-0 flex-1 overflow-y-auto overscroll-contain",
              )}
            >
              <div className="px-1.5 py-1 text-micro tracking-wide text-ink-3">协议能力</div>
              {rows.length === 0 ? (
                <p className="px-1.5 py-1 text-micro text-ink-3">
                  还没连过这个 agent：能力要握手之后才知道。
                </p>
              ) : (
                groups.map((group) => {
                  const groupRows = rows.filter((r) => r.group === group);
                  return (
                    <div key={group} className="mt-1 first:mt-0">
                      <div className="px-1.5 py-1 text-micro tracking-wide text-ink-3">
                        {group}
                      </div>
                      {groupRows.map((r) => (
                        <div
                          key={r.key}
                          className="flex items-center gap-1.5 px-1.5 py-0.5 text-caption"
                        >
                          <span
                            className={cn(
                              "w-3 shrink-0 text-center font-mono",
                              r.on ? "text-ok-1" : "text-ink-3",
                            )}
                          >
                            {r.on ? "✓" : "✗"}
                          </span>
                          <span className={r.on ? "text-ink-1" : "text-ink-3"}>{r.label}</span>
                        </div>
                      ))}
                    </div>
                  );
                })
              )}
            </div>

            {hasCommands && (
              <>
                <div className="w-px shrink-0 bg-line-1/60" />
                <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain pb-1 pl-2 pr-1">
                  <div className="px-1.5 py-1 text-micro tracking-wide text-ink-3">命令</div>
                  {acpCommands.map((command) => (
                    <div key={command.name} className="px-1.5 py-1">
                      <div className="flex min-w-0 items-baseline gap-1.5">
                        <span className="shrink-0 font-mono text-caption text-ink-1">
                          {command.name}
                        </span>
                        {command.hint && (
                          <span className="truncate text-micro text-ink-3">
                            {`<${command.hint}>`}
                          </span>
                        )}
                      </div>
                      {command.description && (
                        <div className="mt-0.5 truncate text-caption text-ink-2">
                          {command.description}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
