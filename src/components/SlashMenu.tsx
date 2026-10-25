import { useEffect } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import { filterCommands, type SlashCommand } from "@/lib/slash-filter";
import { useAnchoredLayer } from "./ui/Menu";

export function SlashMenu({
  open,
  value,
  commands,
  active,
  onActiveChange,
  onPick,
  onClose,
}: {
  open: boolean;
  value: string;
  commands: SlashCommand[];
  active: number;
  onActiveChange: (index: number) => void;
  onPick: (command: SlashCommand) => void;
  onClose: () => void;
}) {
  const layer = useAnchoredLayer({ align: "start", prefer: "above" });
  const items = filterCommands(value, commands);
  const visible = open && items.length > 0;

  useEffect(() => {
    layer.setOpen(visible);
  }, [layer.setOpen, value, visible]);

  return (
    <>
      <button
        ref={layer.triggerRef}
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        className="pointer-events-none absolute bottom-0 left-2 h-0 w-px opacity-0"
      />
      {visible &&
        layer.open &&
        createPortal(
          <div
            ref={layer.panelRef}
            role="listbox"
            aria-label="斜杠命令"
            style={{ ...layer.style, animation: "sc-pop 150ms var(--ease-pop)" }}
            className="sc-glass sc-z-popover max-h-60 w-80 overflow-y-auto rounded-card p-1"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              }
            }}
          >
            {items.map((command, index) => (
              <button
                key={command.name}
                type="button"
                role="option"
                aria-selected={index === active}
                onMouseDown={(event) => {
                  event.preventDefault();
                  onPick(command);
                }}
                onMouseEnter={() => onActiveChange(index)}
                className={cn(
                  "flex w-full min-w-0 items-baseline gap-2 rounded-control px-2 py-1.5 text-left",
                  index === active ? "bg-surface-3 text-ink-1" : "text-ink-2",
                )}
              >
                <span className="shrink-0 font-mono text-caption text-ink-1">/{command.name}</span>
                {command.description && (
                  <span className="min-w-0 flex-1 truncate text-caption text-ink-3">
                    {command.description}
                  </span>
                )}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
