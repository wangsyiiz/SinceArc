import {
  useState,
  type ComponentPropsWithoutRef,
  type ComponentType,
  type Ref,
} from "react";
import { Activity, Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./ui/Button";
import { useAnchoredLayer } from "./ui/Menu";

const TriggerButton = Button as unknown as ComponentType<
  ComponentPropsWithoutRef<typeof Button> & { ref?: Ref<HTMLButtonElement> }
>;

export function DiagnosticsPanel({
  eventLog,
}: {
  eventLog: { at: number; text: string }[];
}) {
  const { triggerRef, panelRef, open, toggle, style } = useAnchoredLayer({
    align: "end",
    prefer: "below",
  });
  const [copied, setCopied] = useState(false);

  /** 诊断内容是用来贴给别人看的，不能只让人截图 */
  const copyDiagnostics = async () => {
    const text = eventLog
      .map(
        (event) =>
          `${new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false })}  ${event.text}`,
      )
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // WebView 不给 clipboard 权限时的兜底
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <>
      <TriggerButton
        ref={triggerRef}
        variant="ghost"
        size="sm"
        aria-label="诊断"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="诊断"
        onClick={toggle}
        className={cn(
          "size-7 shrink-0 gap-0 rounded-mark p-0",
          open
            ? "bg-surface-3 text-ink-1"
            : "text-ink-2 hover:bg-surface-3 hover:text-ink-1",
        )}
      >
        <Activity className="size-3.5" />
      </TriggerButton>

      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="诊断"
          style={{ ...style, animation: "sc-pop 150ms var(--ease-pop)" }}
          className="sc-glass sc-z-popover w-96 rounded-card p-3"
        >
          <div className="flex items-start justify-between gap-3">
            <p className="text-caption text-ink-3">
              最近收到的 agent 事件。连接后应该先看到{" "}
              <span className="font-mono">hello</span>；发消息后应出现{" "}
              <span className="font-mono">notification:session/update</span> 与{" "}
              <span className="font-mono">promptResult</span>。
            </p>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => void copyDiagnostics()}
              disabled={eventLog.length === 0}
            >
              {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
              {copied ? "已复制" : "复制"}
            </Button>
          </div>

          <div className="mt-2 max-h-52 overflow-y-auto border-t border-line-1/50 pt-2 font-mono text-micro text-ink-3">
            {eventLog.length === 0 ? (
              <div>还没有事件</div>
            ) : (
              eventLog.map((event, index) => (
                <div key={index} className="flex gap-2 py-px">
                  <span className="shrink-0 opacity-60">
                    {new Date(event.at).toLocaleTimeString("zh-CN", { hour12: false })}
                  </span>
                  <span className="break-all">{event.text}</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
