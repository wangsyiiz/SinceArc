interface WorkspaceEmptyProps {
  onNewSession: () => void;
}

/** 所有标签都关掉之后的空态：一个会呼吸的 logo */
export function WorkspaceEmpty({ onNewSession }: WorkspaceEmptyProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6">
      <div className="relative grid size-32 place-items-center">
        <div className="sc-orbit absolute inset-0 rounded-full border border-dashed border-line-1/40" />
        <div className="sc-orbit-rev absolute inset-4 rounded-full border border-line-1/25" />
        <div className="sc-breathe grid size-16 place-items-center rounded-[18px] bg-surface-3/35 text-[26px] leading-none text-ink-2">
          ◇
        </div>
      </div>
      <div className="text-center">
        <div className="text-[12px] text-ink-2">没有打开的标签</div>
        <button
          onClick={onNewSession}
          className="mt-2 rounded-[6px] px-2 py-1 text-[11px] text-ink-3 transition-colors hover:bg-surface-3/45 hover:text-ink-1"
        >
          从左侧打开一个会话，或新建
        </button>
      </div>
    </div>
  );
}
