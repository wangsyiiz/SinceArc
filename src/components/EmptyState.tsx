import { CornerDownLeft } from "lucide-react";
import { BrandMark } from "./BrandMark";
import { EmptyState as PrimitiveEmptyState } from "./ui/EmptyState";
import { Button } from "./ui/Button";

const SUGGESTIONS = [
  "解释一下这个仓库的目录结构",
  "跑一遍测试，失败的话定位原因",
  "把 acp/launch.rs 里的进程清理补上",
];

export function EmptyState({ cwd, onPick }: { cwd: string; onPick: (text: string) => void }) {
  return (
    <PrimitiveEmptyState
      title="SinceArc"
      description={`一个 ACP 桌面客户端。选择左侧的 agent，在 ${cwd} 里开始对话。`}
      icon={
        <div className="grid size-12 place-items-center rounded-card border border-line-1 bg-surface-1 text-accent-1">
          <BrandMark className="size-7" />
        </div>
      }
      action={
        <div className="flex w-full max-w-md flex-col gap-2">
          {SUGGESTIONS.map((suggestion) => (
            <Button
              key={suggestion}
              variant="secondary"
              className="w-full justify-start"
              onClick={() => onPick(suggestion)}
            >
              <span className="min-w-0 flex-1 truncate text-left">{suggestion}</span>
              <CornerDownLeft className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
            </Button>
          ))}
        </div>
      }
    />
  );
}
