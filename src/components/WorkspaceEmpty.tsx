import { BrandMark } from "./BrandMark";
import { EmptyState } from "./ui/EmptyState";
import { Button } from "./ui/Button";

interface WorkspaceEmptyProps {
  onNewSession: () => void;
}

/** 所有标签都关掉之后的空态：一个会呼吸的 logo */
export function WorkspaceEmpty({ onNewSession }: WorkspaceEmptyProps) {
  return (
    <EmptyState
      title="没有打开的标签"
      icon={
        <div className="relative grid size-32 place-items-center">
          <div className="sc-orbit absolute inset-0 rounded-full border border-dashed border-line-1/40" />
          <div className="sc-orbit-rev absolute inset-4 rounded-full border border-line-1/25" />
          <div className="sc-breathe grid size-16 place-items-center rounded-card bg-surface-3/35 text-ink-2">
            <BrandMark className="size-9" />
          </div>
        </div>
      }
      action={
        <Button variant="ghost" size="sm" onClick={onNewSession}>
          从左侧打开一个会话，或新建
        </Button>
      }
    />
  );
}
