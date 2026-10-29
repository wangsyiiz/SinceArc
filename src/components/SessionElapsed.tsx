import { Clock } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { clockHHMM, formatElapsed } from "@/lib/session-elapsed";
import { Tooltip } from "./ui/Tooltip";

export function SessionElapsed({ sessionId }: { sessionId: string }) {
  const { t } = useTranslation();
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const start = Date.now();
    setStartedAt(start);
    setNowMs(start);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [sessionId]);

  if (!sessionId) return null;

  return (
    <Tooltip
      label={t("statusbar.elapsed.tooltip", { time: clockHHMM(startedAt) })}
    >
      <span
        data-session-elapsed
        aria-label={t("statusbar.elapsed.label")}
        className="mr-1 flex items-center gap-1 font-mono text-micro text-ink-3"
      >
        <Clock className="size-3 shrink-0" aria-hidden="true" />
        <span>{formatElapsed(nowMs - startedAt)}</span>
      </span>
    </Tooltip>
  );
}
