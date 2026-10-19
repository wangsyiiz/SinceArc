import { AlertTriangle, X } from "lucide-react";
import type { ThemeMode, ThreadSettings } from "@/types";
import { cn } from "@/lib/utils";

interface SettingsDrawerProps {
  settings: ThreadSettings;
  theme: ThemeMode;
  onChangeContext: (n: number) => void;
  onCycleTheme: (t: ThemeMode) => void;
  onClose: () => void;
}

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: "dark", label: "深色" },
  { id: "light", label: "浅色" },
  { id: "system", label: "跟随系统" },
];

export function SettingsDrawer({
  settings,
  theme,
  onChangeContext,
  onCycleTheme,
  onClose,
}: SettingsDrawerProps) {
  const n = settings.contextMessages;
  const heavy = n > 10;

  return (
    <aside className="sc-glass absolute right-1 top-9 bottom-1 z-30 flex w-[372px] flex-col overflow-hidden rounded-[12px]">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line-1/60 px-3">
        <span className="text-[12px] font-medium">设置</span>
        <button
          onClick={onClose}
          className="ml-auto grid size-6 place-items-center rounded-[6px] text-ink-3 transition-colors hover:bg-white/[0.06] hover:text-ink-1"
        >
          <X className="size-3.5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        <div className="mb-1.5 text-[10px] font-medium tracking-wide text-ink-3">群聊</div>
        <div className="rounded-[8px] border border-line-1/60 p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[11.5px] text-ink-1">@ 玩家时附带最近几条记录</span>
            <span className="font-mono text-[12px] tabular-nums text-accent-1">{n}</span>
          </div>
          <input
            type="range"
            min={0}
            max={20}
            step={1}
            value={n}
            onChange={(e) => onChangeContext(Number(e.target.value))}
            style={{ accentColor: "var(--a1)" }}
            className="mt-2.5 h-1 w-full cursor-pointer appearance-none rounded-full bg-line-1"
          />
          <div className="mt-1 flex justify-between font-mono text-[9px] text-ink-3">
            <span>0</span>
            <span className="text-ink-3">默认 5</span>
            <span>20</span>
          </div>

          <p className="mt-2.5 text-[10.5px] leading-relaxed text-ink-3">
            只附带<span className="text-ink-2">其他成员</span>的发言，你自己的历史已经在 session 里，
            重复带进去等于双份上下文。
          </p>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-ink-3">
            这是<span className="text-ink-2">本轮开始前</span>的快照：并行时，A 看不到 B 在这一轮里刚说的话。
          </p>

          {heavy && (
            <p className="mt-2 flex items-start gap-1.5 rounded-[6px] bg-warn-1/[0.09] px-2 py-1.5 text-[10.5px] leading-relaxed text-warn-1">
              <AlertTriangle className="mt-[1px] size-3 shrink-0" />
              {n} 条会明显推高每次请求的输入 token；20 条通常没有必要，也更容易撞上下文上限。
            </p>
          )}
        </div>

        <div className="mt-5 mb-1.5 text-[10px] font-medium tracking-wide text-ink-3">外观</div>
        <div className="flex gap-1 rounded-[8px] border border-line-1/60 p-1">
          {THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => onCycleTheme(t.id)}
              className={cn(
                "flex-1 rounded-[6px] py-1.5 text-[11px] transition-colors",
                theme === t.id ? "bg-white/[0.08] text-ink-1" : "text-ink-3 hover:text-ink-2",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="mt-5 mb-1.5 text-[10px] font-medium tracking-wide text-ink-3">会话</div>
        <div className="space-y-2 rounded-[8px] border border-line-1/60 p-3 text-[11px] text-ink-2">
          <div className="flex items-center justify-between">
            <span>新建会话的默认目录</span>
            <span className="font-mono text-[10px] text-ink-3">workspace 根</span>
          </div>
          <div className="flex items-center justify-between">
            <span>玩家数量上限</span>
            <span className="font-mono text-[10px] text-ink-3">4（未接线）</span>
          </div>
        </div>
      </div>

      <footer className="border-t border-line-1/60 px-3.5 py-2 text-[9.5px] text-ink-3">
        未接线版本 · 设置仅本次运行有效
      </footer>
    </aside>
  );
}
