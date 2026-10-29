import { Loader } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatElapsed } from "@/lib/session-elapsed";
import { useHoverCard } from "./ui/HoverCard";

interface RunningItem {
  name: string;
  title: string;
  startedAt: number;
}

interface RunningCountProps {
  items: RunningItem[];
  onOpenTrace?: () => void;
}

export function RunningCount({ items, onOpenTrace }: RunningCountProps) {
  if (items.length === 0) return null;
  return <RunningCountChip items={items} onOpenTrace={onOpenTrace} />;
}

function RunningCountChip({ items, onOpenTrace }: RunningCountProps) {
  const { t } = useTranslation();
  const [el, setEl] = useState<HTMLButtonElement | null>(null);
  const hover = useHoverCard();

  return (
    <>
      <button
        ref={setEl}
        {...hover.triggerProps(el)}
        type="button"
        data-running-count
        aria-label={t("statusbar.running.label", { count: items.length })}
        onClick={() => {
          if (onOpenTrace) onOpenTrace();
        }}
        className="mr-1 flex items-center gap-1 font-mono text-micro text-ink-3"
      >
        <Loader className="size-3 shrink-0 animate-spin" aria-hidden="true" />
        <span>{items.length}</span>
      </button>
      {hover.card(
        <div>
          <div className="mb-2 text-caption font-medium text-ink-1">
            {t("statusbar.running.tooltip")}
          </div>
          <div className="sc-running-card flex flex-col gap-1.5 overflow-y-auto">
            {items.map((item, index) => (
              <RunningRow
                key={`${item.startedAt}-${index}`}
                name={item.name}
                title={item.title}
                startedAt={item.startedAt}
              />
            ))}
          </div>
        </div>,
      )}
    </>
  );
}

function RunningRow({
  name,
  title,
  startedAt,
}: {
  name: string;
  title: string;
  startedAt: number;
}) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <span className="shrink-0 text-ink-1">{name}</span>
      {title && (
        <>
          <span className="shrink-0 text-ink-3" aria-hidden="true">
            ·
          </span>
          <span className="min-w-0 flex-1 truncate text-ink-2">{title}</span>
        </>
      )}
      <span className="shrink-0 text-ink-3" aria-hidden="true">
        ·
      </span>
      <RunningDuration startedAt={startedAt} />
    </div>
  );
}

/** 每秒只让这一小块重渲染，行结构由父级按 items 变化重建。 */
function RunningDuration({ startedAt }: { startedAt: number }) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <span className="shrink-0 font-mono text-ink-3">
      {formatElapsed(nowMs - startedAt)}
    </span>
  );
}
