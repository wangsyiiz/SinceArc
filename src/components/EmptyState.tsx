import { CornerDownLeft } from "lucide-react";

const SUGGESTIONS = [
  "解释一下这个仓库的目录结构",
  "跑一遍测试，失败的话定位原因",
  "把 acp/launch.rs 里的进程清理补上",
];

export function EmptyState({ cwd, onPick }: { cwd: string; onPick: (text: string) => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6">
      <div className="mb-5 grid size-12 place-items-center rounded-2xl border border-line-1 bg-surface-1 text-[20px] text-accent-1">
        ◇
      </div>
      <h1 className="text-[17px] font-medium tracking-tight text-ink-1">SinceArc</h1>
      <p className="mt-1.5 max-w-md text-center text-[12.5px] leading-relaxed text-ink-2">
        一个 ACP 桌面客户端。选择左侧的 agent，在
        <span className="mx-1 rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px]">
          {cwd}
        </span>
        里开始对话。
      </p>

      <div className="mt-6 w-full max-w-md flex-col gap-2 flex">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            onClick={() => onPick(s)}
            className="flex items-center gap-2 rounded-[10px] border border-line-1 bg-surface-1 px-3.5 py-2.5 text-left text-[12.5px] text-ink-2 transition-colors hover:border-line-2 hover:bg-surface-2 hover:text-ink-1"
          >
            <span className="flex-1">{s}</span>
            <CornerDownLeft className="size-3.5 shrink-0 text-ink-3" />
          </button>
        ))}
      </div>
    </div>
  );
}
