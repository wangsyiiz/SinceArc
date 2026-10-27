import { useEffect, useState, type CSSProperties, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { PlugZap, Trash2 } from "lucide-react";
import type { AgentProfile } from "@/types";
import {
  asCmdError,
  mcpCatalog,
  sessionMcpState,
  sessionSetMcpNames,
  type McpCatalogEntryDto,
  type SessionMcpStateDto,
} from "@/lib/ipc";
import { entryKind, transportSupportNote } from "@/lib/mcp-display";
import { diffMcpNames } from "@/lib/mcp-names-diff";
import { cn } from "@/lib/utils";
import { McpServerChecklist } from "./McpChecklist";
import { MoreMenu } from "./MoreMenu";
import { Button } from "./ui/Button";
import { useAnchoredLayer } from "./ui/Menu";
import { Segmented } from "./ui/Segmented";
import { Tooltip } from "./ui/Tooltip";

type SessionMode = "follow" | "custom" | "none";

function modeOf(state: SessionMcpStateDto): SessionMode {
  if (state.sessionNames === null) return "follow";
  return state.sessionNames.length === 0 ? "none" : "custom";
}

/** 会话条目的「更多操作」；MCP 入口已移到输入区工具行，这里只留删除。 */
export function SessionMoreMenu({
  busy,
  onDelete,
}: {
  busy: boolean;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <MoreMenu
      items={[
        {
          label: t("settings.sessionMcp.deleteSession"),
          icon: <Trash2 size={12} />,
          danger: true,
          disabled: busy,
          hint: busy ? t("settings.sessionMcp.busyHint") : undefined,
          onSelect: onDelete,
        },
      ]}
    />
  );
}

/** 输入区工具行的会话 MCP 入口：显示已注入数量，面板向上展开。 */
export function SessionMcpButton({
  sessionId,
  profile,
  onReconnect,
  avoidRef,
}: {
  sessionId: string;
  profile?: AgentProfile;
  onReconnect: () => Promise<void>;
  avoidRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  const layer = useAnchoredLayer({ align: "end", prefer: "above", avoidRef });
  const [state, setState] = useState<SessionMcpStateDto | null>(null);
  const count = state?.effective.length ?? 0;

  useEffect(() => {
    let alive = true;
    setState(null);
    sessionMcpState(sessionId)
      .then((next) => {
        if (alive) setState(next);
      })
      .catch(() => {
        // 面板自己会显示读取失败；入口只显示可确定的数量。
        if (alive) setState(null);
      });
    return () => {
      alive = false;
    };
  }, [sessionId]);

  return (
    <>
      <Button
        ref={layer.triggerRef}
        variant="ghost"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={layer.open}
        aria-label={t("settings.sessionMcp.settingsAria")}
        className="h-7 gap-1 px-1.5 text-caption"
        onClick={layer.toggle}
      >
        <PlugZap className="size-3" aria-hidden="true" />
        <span className="font-mono text-micro text-ink-3">MCP · {count}</span>
      </Button>

      {layer.open &&
        createPortal(
          <SessionMcpPanel
            sessionId={sessionId}
            profile={profile}
            onReconnect={onReconnect}
            onStateChange={setState}
            onClose={() => layer.setOpen(false)}
            panelRef={layer.panelRef}
            style={layer.style}
          />,
          document.body,
        )}
    </>
  );
}

function SessionMcpPanel({
  sessionId,
  profile,
  onReconnect,
  onStateChange,
  onClose,
  panelRef,
  style,
}: {
  sessionId: string;
  profile?: AgentProfile;
  onReconnect: () => Promise<void>;
  onStateChange?: (state: SessionMcpStateDto) => void;
  onClose: () => void;
  panelRef: RefObject<HTMLDivElement | null>;
  style: CSSProperties;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<SessionMcpStateDto | null>(null);
  const [catalog, setCatalog] = useState<McpCatalogEntryDto[]>([]);
  const [mode, setMode] = useState<SessionMode>("follow");
  const [customNames, setCustomNames] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectNeeded, setReconnectNeeded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);

  const applyLoadedState = (next: SessionMcpStateDto) => {
    setState(next);
    onStateChange?.(next);
    setMode(modeOf(next));
    setCustomNames(next.sessionNames ?? next.effective.map((entry) => entry.name));
  };

  useEffect(() => {
    let alive = true;
    Promise.all([sessionMcpState(sessionId), mcpCatalog()])
      .then(([next, entries]) => {
        if (!alive) return;
        applyLoadedState(next);
        setCatalog(entries);
      })
      .catch((e) => {
        if (alive) {
          setError(t("settings.sessionMcp.loadFailed", { msg: asCmdError(e).msg }));
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [retrySeq, sessionId, t]);

  const applyNames = async (names: string[] | null, nextMode: SessionMode) => {
    if (saving || !state) return;
    const before = state.effective.map((entry) => entry.name);
    setMode(nextMode);
    if (nextMode === "custom" && names) setCustomNames(names);
    setSaving(true);
    setError(null);
    try {
      await sessionSetMcpNames(sessionId, names);
      const next = await sessionMcpState(sessionId);
      const after = next.effective.map((entry) => entry.name);
      setReconnectNeeded(diffMcpNames(before, after).removed.length > 0);
      applyLoadedState(next);
    } catch (e) {
      applyLoadedState(state);
      setError(t("settings.sessionMcp.saveFailed", { msg: asCmdError(e).msg }));
    } finally {
      setSaving(false);
    }
  };

  const chooseMode = (next: SessionMode) => {
    if (saving || next === mode) return;
    if (next === "follow") {
      void applyNames(null, "follow");
    } else if (next === "none") {
      void applyNames([], "none");
    } else {
      const seed = state?.sessionNames ?? state?.effective.map((entry) => entry.name) ?? [];
      void applyNames(seed, "custom");
    }
  };

  const toggleName = (name: string, checked: boolean) => {
    if (saving) return;
    const next = new Set(customNames);
    if (checked) next.add(name);
    else next.delete(name);
    const names = catalog.filter((entry) => next.has(entry.name)).map((entry) => entry.name);
    void applyNames(names, names.length === 0 ? "none" : "custom");
  };

  const reconnect = async () => {
    setReconnecting(true);
    setError(null);
    try {
      await onReconnect();
      setReconnectNeeded(false);
    } catch (e) {
      setError(t("settings.sessionMcp.reconnectFailed", { msg: asCmdError(e).msg }));
    } finally {
      setReconnecting(false);
    }
  };

  const followCount =
    state?.profileNames === null
      ? catalog.length
      : catalog.filter((entry) => state?.profileNames?.includes(entry.name)).length;
  const effective = state?.effective ?? [];

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t("settings.mcp.server")}
      style={{ ...style, animation: "sc-pop 150ms var(--ease-pop)" }}
      className="sc-glass sc-z-popover max-h-96 w-96 overflow-y-auto rounded-card p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-ui font-medium text-ink-1">{t("settings.mcp.server")}</h2>
          <p className="mt-0.5 text-caption text-ink-3">
            {t("settings.sessionMcp.scopeHint")}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          {t("app.settingsError.dismiss")}
        </Button>
      </div>

      {loading ? (
        <p className="mt-3 text-caption text-ink-3">
          {t("settings.sessionMcp.loading")}
        </p>
      ) : !state ? (
        <div className="mt-3">
          <p role="alert" className="break-all text-caption text-danger-1">
            {error ?? t("settings.sessionMcp.loadUnavailable")}
          </p>
          <div className="mt-2 flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setError(null);
                setLoading(true);
                setRetrySeq((value) => value + 1);
              }}
            >
              {t("ui.emptyState.retry")}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-3">
            <Segmented
              ariaLabel={t("settings.sessionMcp.listAria")}
              compact
              options={[
                {
                  value: "follow",
                  label: t("settings.sessionMcp.mode.follow", { count: followCount }),
                },
                {
                  value: "custom",
                  label: t("settings.mcp.mode.customCount", { count: customNames.length }),
                },
                { value: "none", label: t("settings.sessionMcp.mode.none") },
              ]}
              value={mode}
              disabled={saving}
              onChange={chooseMode}
            />
          </div>

          {mode === "custom" && (
            <div className="sc-pane mt-2 p-1">
              <McpServerChecklist
                entries={catalog}
                selected={customNames}
                caps={profile?.caps ?? null}
                disabled={saving}
                onToggle={toggleName}
                emptyText={t("settings.mcp.catalog.emptyHint")}
              />
            </div>
          )}

          <div className="mt-3 border-t border-line-1/50 pt-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-caption text-ink-2">
                {t("settings.sessionMcp.injected")}
              </span>
              <span className="font-mono text-micro text-ink-3">
                {t("settings.sessionMcp.injectedCount", { count: effective.length })}
              </span>
            </div>
            {effective.length === 0 ? (
              <p className="mt-1 text-caption text-ink-3">
                {t("settings.sessionMcp.noneInjected")}
              </p>
            ) : (
              <div className="mt-1 space-y-0.5">
                {effective.map((entry) => {
                  const kind = entryKind(entry);
                  const noteKey = transportSupportNote(kind, profile?.caps ?? null);
                  const note = noteKey ? t(noteKey) : null;
                  const name = (
                    <span className="min-w-0 flex-1 truncate text-ui-tight text-ink-1">
                      {entry.name}
                    </span>
                  );
                  return (
                    <div key={entry.name} className="flex items-center gap-1.5 px-1 py-0.5">
                      {entry.name.length > 24 ? (
                        <Tooltip label={entry.name}>{name}</Tooltip>
                      ) : (
                        name
                      )}
                      <span className="text-micro text-ink-3">·</span>
                      <span className="shrink-0 font-mono text-micro text-ink-3">{kind}</span>
                      {note && <span className="shrink-0 text-micro text-warn-1">{note}</span>}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="mt-3 border-t border-line-1/50 pt-2">
            <p
              aria-live="polite"
              className={cn(
                "text-caption",
                error ? "text-danger-1" : "text-ink-3",
              )}
            >
              {error
                ? error
                : saving
                  ? t("settings.sessionMcp.saving")
                  : reconnectNeeded
                    ? t("settings.sessionMcp.savedNeedsReconnect")
                    : t("settings.sessionMcp.saved")}
            </p>

            {reconnectNeeded && (
              <div className="mt-2 rounded-control bg-warn-1/10 p-2">
                <p className="text-caption text-warn-1">
                  {t("settings.sessionMcp.reconnectNotice")}
                </p>
                <div className="mt-2 flex justify-end">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={reconnecting}
                    loadingText={t("settings.sessionMcp.reconnecting")}
                    disabled={!profile || saving || reconnecting}
                    onClick={() => void reconnect()}
                  >
                    {t("settings.sessionMcp.reconnect")}
                  </Button>
                </div>
                {!profile && (
                  <p className="mt-1 text-right text-caption text-ink-3">
                    {t("settings.sessionMcp.noProfile")}
                  </p>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
