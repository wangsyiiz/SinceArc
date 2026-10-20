import { useState } from "react";
import { AlertTriangle, MessageSquare, Palette, SlidersHorizontal } from "lucide-react";
import type { ThemeMode, ThreadSettings } from "@/types";
import { cn } from "@/lib/utils";

interface SettingsViewProps {
  settings: ThreadSettings;
  theme: ThemeMode;
  onChangeContext: (n: number) => void;
  onCycleTheme: (t: ThemeMode) => void;
}

const THEMES: { id: ThemeMode; label: string }[] = [
  { id: "dark", label: "深色" },
  { id: "light", label: "浅色" },
  { id: "system", label: "跟随系统" },
];

const SECTIONS = [
  { id: "chat", label: "群聊", icon: MessageSquare },
  { id: "appearance", label: "外观", icon: Palette },
  { id: "session", label: "会话", icon: SlidersHorizontal },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

export function SettingsView({ settings, theme, onChangeContext, onCycleTheme }: SettingsViewProps) {
  const [active, setActive] = useState<SectionId>("chat");
  const n = settings.contextMessages;
  const heavy = n > 10;

  return (
    <div className="flex min-h-0 flex-1">
      <nav className="w-[172px] shrink-0 bg-surface-0 px-2 py-3">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActive(id)}
            className={cn(
              "mb-0.5 flex w-full items-center gap-2 rounded-[8px] px-2.5 py-2 text-left text-[12px] transition-colors",
              active === id ? "sc-row-active text-ink-1" : "text-ink-2 hover:bg-surface-3/35",
            )}
          >
            <Icon className="size-3.5 shrink-0 text-ink-3" />
            {label}
          </button>
        ))}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="max-w-[560px] px-6 py-6">
          {active === "chat" && (
            <>
              <h1 className="text-[14px] font-medium text-ink-1">群聊</h1>
              <div className="mt-3 rounded-[8px] border border-line-1/60 p-3.5">
                <div className="flex items-baseline justify-between">
                  <span className="text-[12px] text-ink-1">@ 玩家时附带最近几条记录</span>
                  <span className="font-mono text-[13px] tabular-nums text-accent-1">{n}</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={20}
                  step={1}
                  value={n}
                  onChange={(e) => onChangeContext(Number(e.target.value))}
                  style={{ accentColor: "var(--a1)" }}
                  className="mt-3 h-1 w-full cursor-pointer appearance-none rounded-full bg-surface-3"
                />
                <div className="mt-1 flex justify-between font-mono text-[9px] text-ink-3">
                  <span>0</span>
                  <span>默认 5</span>
                  <span>20</span>
                </div>

                <p className="mt-3 text-[11px] leading-relaxed text-ink-3">
                  只附带<span className="text-ink-2">其他成员</span>的发言。你自己的历史已经在
                  session 里，重复带进去等于双份上下文。
                </p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-ink-3">
                  这是<span className="text-ink-2">本轮开始前</span>
                  的快照：并行时，A 看不到 B 在这一轮里刚说的话。
                </p>

                {heavy && (
                  <p className="mt-2.5 flex items-start gap-1.5 rounded-[6px] bg-warn-1/[0.09] px-2.5 py-2 text-[11px] leading-relaxed text-warn-1">
                    <AlertTriangle className="mt-[1px] size-3 shrink-0" />
                    {n} 条会明显推高每次请求的输入 token；并行时还要乘以被 @ 的人数。
                  </p>
                )}
              </div>
            </>
          )}

          {active === "appearance" && (
            <>
              <h1 className="text-[14px] font-medium text-ink-1">外观</h1>
              <div className="mt-3 flex gap-1 rounded-[8px] border border-line-1/60 p-1">
                {THEMES.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => onCycleTheme(t.id)}
                    className={cn(
                      "flex-1 rounded-[6px] py-2 text-[11.5px] transition-colors",
                      theme === t.id ? "sc-row-active text-ink-1" : "text-ink-3 hover:bg-surface-3/35 hover:text-ink-2",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[10.5px] leading-relaxed text-ink-3">
                浅色主题不用内边缘高光划边界，层次交给面阶差。
              </p>
            </>
          )}

          {active === "session" && (
            <>
              <h1 className="text-[14px] font-medium text-ink-1">会话</h1>
              <div className="mt-3 space-y-2.5 rounded-[8px] border border-line-1/60 p-3.5 text-[11.5px] text-ink-2">
                <div className="flex items-center justify-between">
                  <span>新建会话的默认目录</span>
                  <span className="font-mono text-[10px] text-ink-3">workspace 根</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>群聊玩家上限</span>
                  <span className="font-mono text-[10px] text-ink-3">4（未接线）</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>会话状态持久化</span>
                  <span className="font-mono text-[10px] text-ink-3">SQLite（未接线）</span>
                </div>
              </div>
            </>
          )}

          <p className="mt-8 text-[10px] text-ink-3">未接线版本 · 设置仅本次运行有效</p>
        </div>
      </div>
    </div>
  );
}
