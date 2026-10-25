import { useEffect, useState, type CSSProperties, type RefObject } from "react";
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
  return (
    <MoreMenu
      items={[
        {
          label: "删除会话",
          icon: <Trash2 size={12} />,
          danger: true,
          disabled: busy,
          hint: busy ? "这一轮还在跑，等它结束再删" : undefined,
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
        aria-label="MCP 服务器设置"
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
        if (alive) setError(`读取会话 MCP 配置失败：${asCmdError(e).msg}`);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [retrySeq, sessionId]);

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
      setError(`保存会话 MCP 名单失败：${asCmdError(e).msg}`);
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
      setError(`重新连接 agent 失败：${asCmdError(e).msg}`);
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
      aria-label="MCP 服务器"
      style={{ ...style, animation: "sc-pop 150ms var(--ease-pop)" }}
      className="sc-glass sc-z-popover max-h-96 w-96 overflow-y-auto rounded-card p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-ui font-medium text-ink-1">MCP 服务器</h2>
          <p className="mt-0.5 text-caption text-ink-3">只影响这个会话。</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}>
          关闭
        </Button>
      </div>

      {loading ? (
        <p className="mt-3 text-caption text-ink-3">正在读取会话 MCP 配置…</p>
      ) : !state ? (
        <div className="mt-3">
          <p role="alert" className="break-all text-caption text-danger-1">
            {error ?? "读取不到这个会话的 MCP 配置。"}
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
              重试
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-3">
            <Segmented
              ariaLabel="本会话 MCP 名单"
              compact
              options={[
                { value: "follow", label: `跟随连接默认（${followCount} 个）` },
                { value: "custom", label: `自定义（${customNames.length} 个）` },
                { value: "none", label: "全部不要" },
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
                emptyText="MCP 目录还是空的，先去「设置 → MCP」添加服务器。"
              />
            </div>
          )}

          <div className="mt-3 border-t border-line-1/50 pt-2">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-caption text-ink-2">已注入清单</span>
              <span className="font-mono text-micro text-ink-3">
                本会话已注入 {effective.length} 个
              </span>
            </div>
            {effective.length === 0 ? (
              <p className="mt-1 text-caption text-ink-3">本会话没有注入 MCP 服务器。</p>
            ) : (
              <div className="mt-1 space-y-0.5">
                {effective.map((entry) => {
                  const kind = entryKind(entry);
                  const note = transportSupportNote(kind, profile?.caps ?? null);
                  return (
                    <div key={entry.name} className="flex items-center gap-1.5 px-1 py-0.5">
                      <span
                        className="min-w-0 flex-1 truncate text-ui-tight text-ink-1"
                        title={entry.name.length > 24 ? entry.name : undefined}
                      >
                        {entry.name}
                      </span>
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
                  ? "正在保存会话 MCP 名单…"
                  : reconnectNeeded
                    ? "名单已保存；减少的部分需要重连才可能生效。"
                    : "名单已保存。"}
            </p>

            {reconnectNeeded && (
              <div className="mt-2 rounded-control bg-warn-1/10 p-2">
                <p className="text-caption text-warn-1">
                  这篇改动要重新连接 agent 才可能生效：它的 MCP 工具登记在进程上，减少不会自动注销。
                </p>
                <div className="mt-2 flex justify-end">
                  <Button
                    variant="secondary"
                    size="sm"
                    loading={reconnecting}
                    loadingText="重连中…"
                    disabled={!profile || saving || reconnecting}
                    onClick={() => void reconnect()}
                  >
                    重连以生效
                  </Button>
                </div>
                {!profile && (
                  <p className="mt-1 text-right text-caption text-ink-3">
                    这个会话没有可用的连接配置。
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
