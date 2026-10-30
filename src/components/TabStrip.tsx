import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  FolderGit2,
  GitPullRequest,
  MessageSquare,
  MoreHorizontal,
  Pin,
  Settings2,
  X,
} from "lucide-react";
import type { Tab } from "@/types";
import { cn } from "@/lib/utils";
import { fitTabs } from "@/lib/tab-fit";
import { Button } from "./ui/Button";
import { useHoverCard } from "./ui/HoverCard";
import { useAnchoredLayer } from "./ui/Menu";
import { Tooltip } from "./ui/Tooltip";
import { localizeText } from "@/lib/i18n-text";

const ICON = {
  session: MessageSquare,
  repo: FolderGit2,
  pr: GitPullRequest,
  settings: Settings2,
} as const;

interface TabStripProps {
  tabs: Tab[];
  activeId: string | null;
  pinned: ReadonlySet<string>;
  badgeOf?: (t: Tab) => string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
}

interface TabItemProps {
  tab: Tab;
  active: boolean;
  pinned: boolean;
  badgeOf?: (t: Tab) => string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
  layout?: "strip" | "menu";
}

export function TabStrip({
  tabs,
  activeId,
  pinned,
  badgeOf,
  onSelect,
  onClose,
  onPin,
  onUnpin,
}: TabStripProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const [metrics, setMetrics] = useState({ width: 0, minW: 0, gap: 0 });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const overflowWidth = overflowRef.current?.getBoundingClientRect().width ?? 0;
      const width = Math.max(0, container.getBoundingClientRect().width - overflowWidth);
      const styles = getComputedStyle(container);
      const minW = Number.parseFloat(styles.getPropertyValue("--tab-min-w")) || 0;
      const tabEl = stripRef.current?.querySelector<HTMLElement>("[data-tab]");
      const gap = tabEl ? Number.parseFloat(getComputedStyle(tabEl).borderRightWidth) || 0 : 0;
      setMetrics((prev) =>
        prev.width === width && prev.minW === minW && prev.gap === gap
          ? prev
          : { width, minW, gap },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    if (overflowRef.current) observer.observe(overflowRef.current);
    if (stripRef.current) observer.observe(stripRef.current);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [tabs.length]);

  const tabIds = useMemo(() => tabs.map((tab) => tab.id), [tabs]);
  const pinnedIds = useMemo(
    () =>
      tabs
        .filter((tab) => tab.kind === "session" && !!tab.sessionId && pinned.has(tab.sessionId))
        .map((tab) => tab.id),
    [pinned, tabs],
  );
  const { visible, overflow } = useMemo(
    () =>
      fitTabs({
        width: metrics.width,
        minW: metrics.minW,
        gap: metrics.gap,
        tabs: tabIds,
        pinned: pinnedIds,
        activeId,
      }),
    [activeId, metrics.gap, metrics.minW, metrics.width, pinnedIds, tabIds],
  );

  const byId = useMemo(() => new Map(tabs.map((tab) => [tab.id, tab])), [tabs]);
  const visibleTabs = visible.flatMap((id) => {
    const tab = byId.get(id);
    return tab ? [tab] : [];
  });
  const overflowTabs = overflow.flatMap((id) => {
    const tab = byId.get(id);
    return tab ? [tab] : [];
  });

  if (tabs.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="flex h-9 shrink-0 items-stretch overflow-hidden border-b border-line-1/60"
    >
      <div ref={stripRef} className="flex min-w-0 flex-1 items-stretch overflow-hidden">
        {visibleTabs.map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            pinned={!!tab.sessionId && pinned.has(tab.sessionId)}
            badgeOf={badgeOf}
            onSelect={onSelect}
            onClose={onClose}
            onPin={onPin}
            onUnpin={onUnpin}
          />
        ))}
      </div>
      <div
        ref={overflowRef}
        className={cn(
          "flex shrink-0 items-stretch border-l border-line-1/40",
          overflowTabs.length === 0 && "invisible",
        )}
      >
        <TabOverflowMenu
          tabs={overflowTabs}
          activeId={activeId}
          pinned={pinned}
          badgeOf={badgeOf}
          onSelect={onSelect}
          onClose={onClose}
          onPin={onPin}
          onUnpin={onUnpin}
        />
      </div>
    </div>
  );
}

function TabItem({
  tab,
  active,
  pinned,
  badgeOf,
  onSelect,
  onClose,
  onPin,
  onUnpin,
  layout = "strip",
}: TabItemProps) {
  const { t } = useTranslation();
  const Icon = ICON[tab.kind];
  const inMenu = layout === "menu";
  const badge = badgeOf?.(tab);
  const controlsVisible = active || pinned;

  return (
    <div
      data-tab={inMenu ? undefined : ""}
      role={inMenu ? "none" : undefined}
      style={inMenu ? undefined : ({ width: "var(--tab-min-w)" } as CSSProperties)}
      className={cn(
        "group flex h-full shrink-0 items-stretch border-r border-line-1/40 transition-colors",
        inMenu ? "w-full rounded-mark border-r-0" : "",
        active ? "sc-row-active text-ink-1" : "text-ink-3 hover:bg-surface-3 hover:text-ink-1",
      )}
    >
      <button
        type="button"
        data-tab-select={inMenu ? "" : undefined}
        role={inMenu ? "menuitem" : undefined}
        onClick={() => onSelect(tab.id)}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 px-3 text-left text-ui-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1",
          inMenu && "h-8 rounded-mark",
        )}
      >
        <Icon className={cn("size-3 shrink-0", active ? "text-ink-2" : "text-ink-3")} />
        <TabTitle title={tab.title} subtitle={tab.subtitle} />
        {badge && (
          <span
            className={cn("size-1.5 shrink-0 rounded-full", !active && "animate-pulse")}
            style={{ background: badge }}
          />
        )}
      </button>
      <div
        className={cn(
          "ml-0.5 flex shrink-0 items-center gap-0.5 pr-1 transition-opacity",
          controlsVisible
            ? "opacity-60 group-hover:opacity-100 focus-within:opacity-100"
            : "opacity-0 group-hover:opacity-60 focus-within:opacity-100",
        )}
      >
        {tab.kind === "session" && tab.sessionId && (
          <Tooltip label={pinned ? t("ui.tabStrip.unpin") : t("ui.tabStrip.pin")}>
            <Button
              variant="ghost"
              size="sm"
              role={inMenu ? "menuitem" : undefined}
              onClick={(event) => {
                event.stopPropagation();
                if (pinned) onUnpin(tab.id);
                else onPin(tab.id);
              }}
              aria-label={pinned ? t("ui.tabStrip.unpin") : t("ui.tabStrip.pin")}
              aria-pressed={pinned}
              className="size-4 shrink-0 gap-0 rounded-mark p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
            >
              <Pin className={cn("size-2.5", pinned && "fill-current")} />
            </Button>
          </Tooltip>
        )}
        <Tooltip label={t("ui.tabStrip.close")}>
          <Button
            variant="ghost"
            size="sm"
            role={inMenu ? "menuitem" : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
            aria-label={t("ui.tabStrip.close")}
            className="size-4 shrink-0 gap-0 rounded-mark p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
          >
            <X className="size-2.5" />
          </Button>
        </Tooltip>
      </div>
    </div>
  );
}

function TabOverflowMenu({
  tabs,
  activeId,
  pinned,
  badgeOf,
  onSelect,
  onClose,
  onPin,
  onUnpin,
}: Omit<TabStripProps, "onSelect" | "onClose" | "onPin" | "onUnpin"> & {
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onPin: (id: string) => void;
  onUnpin: (id: string) => void;
}) {
  const { t } = useTranslation();
  const layer = useAnchoredLayer({ align: "end" });
  const wasOpen = useRef(false);

  useEffect(() => {
    if (layer.open) {
      wasOpen.current = true;
      const frame = requestAnimationFrame(() => {
        layer.panelRef.current?.querySelector<HTMLButtonElement>("[data-tab-select]")?.focus();
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!wasOpen.current) return;
    wasOpen.current = false;
    layer.triggerRef.current?.focus();
  }, [layer.open, layer.panelRef, layer.triggerRef]);

  const run = (action: () => void) => {
    action();
    layer.setOpen(false);
  };

  const onPanelKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = Array.from(
      layer.panelRef.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? [],
    );
    if (options.length === 0) return;
    event.preventDefault();
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      current < 0
        ? event.key === "ArrowDown"
          ? 0
          : options.length - 1
        : event.key === "ArrowDown"
          ? (current + 1) % options.length
          : (current - 1 + options.length) % options.length;
    options[next]?.focus();
  };

  return (
    <>
      <Tooltip label={t("ui.tabStrip.overflow")}>
        <Button
          ref={layer.triggerRef}
          variant="ghost"
          size="sm"
          aria-label={t("ui.tabStrip.overflow")}
          aria-haspopup="menu"
          aria-expanded={layer.open}
          onClick={layer.toggle}
          className="h-full w-8 shrink-0 gap-0 rounded-none p-0 text-ink-2 hover:bg-surface-3 hover:text-ink-1"
        >
          <MoreHorizontal className="size-3.5" />
        </Button>
      </Tooltip>

      {layer.open &&
        createPortal(
          <div
            ref={layer.panelRef}
            role="menu"
            aria-label={t("ui.tabStrip.overflow")}
            onKeyDown={onPanelKeyDown}
            style={{ ...layer.style, animation: "sc-pop 150ms var(--ease-pop)" }}
            className="sc-glass z-20 max-h-80 w-80 overflow-y-auto rounded-card p-1"
          >
            {tabs.map((tab) => (
              <TabItem
                key={tab.id}
                tab={tab}
                active={tab.id === activeId}
                pinned={!!tab.sessionId && pinned.has(tab.sessionId)}
                badgeOf={badgeOf}
                layout="menu"
                onSelect={(id) => run(() => onSelect(id))}
                onClose={(id) => run(() => onClose(id))}
                onPin={(id) => run(() => onPin(id))}
                onUnpin={(id) => run(() => onUnpin(id))}
              />
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

function TabTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  const { t } = useTranslation();
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const hover = useHoverCard({ disabled: !subtitle });
  return (
    <>
      <span ref={setEl} {...hover.triggerProps(el)} className="truncate">
        {localizeText(title, t)}
      </span>
      {hover.card(<span className="break-words">{subtitle}</span>)}
    </>
  );
}
