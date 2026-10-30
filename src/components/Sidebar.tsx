import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import {
  Check,
  ChevronDown,
  Copy,
  FolderGit2,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Pin,
  PinOff,
  Plus,
  RefreshCw,
  Settings2,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import type { CmdError, GhRepoListingDto, GhStatusDto, PrDto, RepoDto, RepoRefDto } from "@/lib/ipc";
import { asCmdError, ghReposList, ghStatus } from "@/lib/ipc";
import type { AgentProfile, GithubRepo, Player, SessionSummary } from "@/types";
import type { MessageKey } from "@/i18n/zh-CN";
import { cn } from "@/lib/utils";
import { copyText } from "@/lib/clipboard";
import { errorTextOf } from "@/lib/errors";
import { profileLabel } from "@/lib/format";
import { localizeText } from "@/lib/i18n-text";
import { clog } from "@/lib/log";
import {
  buildRepoRows,
  repoCloneCommand,
  sortRepoRows,
  type RepoPickerRow,
  type RepoRowState,
} from "@/lib/repos-picker";
import { isBetaVersion, versionLabel } from "@/lib/version-label";
import { SessionMoreMenu } from "./SessionMcpMenu";
import { StatusDot } from "./ui/Badge";
import { Dialog } from "./ui/Dialog";
import { useHoverCard } from "./ui/HoverCard";
import { Tooltip } from "./ui/Tooltip";

export type SidebarMode = "sessions" | "code";

interface SidebarProps {
  mode: SidebarMode;
  onModeChange: (m: SidebarMode) => void;
  sessions: SessionSummary[];
  activeId: string | null;
  profiles: AgentProfile[];
  players: Player[];
  repos: GithubRepo[];
  prsByRepo: Record<string, PrDto[]>;
  /** repoId → 解析出的仓库身份；拿不到时侧栏显示 path 尾段。 */
  identityByRepo: Record<string, RepoRefDto | undefined>;
  onSelect: (id: string) => void;
  onNew: () => void;
  /** 指定连接新建（下拉里选 agent 时用） */
  onNewWithProfile: (profileId: string) => void;
  onOpenSettings: () => void;
  /** 删除会话（App 负责确认与落库；这里只发起） */
  onDeleteSession: (s: SessionSummary) => void;
  /** 这一轮还在跑的会话：不允许删（还没有 session/cancel，删了会留下没人看的 agent） */
  isSessionBusy?: (id: string) => boolean;
  onOpenRepo: (repoId: string) => void;
  onAddRepo: (path: string) => Promise<void> | void;
  onAddFromGh: (input: {
    host?: string | null;
    owner: string;
    name: string;
    defaultBranch?: string | null;
  }) => Promise<RepoDto>;
  onPin: (repoId: string, pinned: boolean) => Promise<void>;
  onNewSessionForRepo: (repo: GithubRepo) => void;
  /** 每次自增就展开「添加项目路径」输入框：代码视图里的「重新选择目录」用它。 */
  focusAddSignal?: number;
  width?: number;
}

/**
 * 分组值来自领域模型（`SessionSummary["group"]` 是中文字面量联合，见 `src/types.ts`），
 * 只用于过滤；显示走 `t(labelKey)`。
 *
 * **不要**改成"拿资源里的中文去匹配"：那样以后一改文案，分组过滤会静默失效（会话凭空消失）。
 * 这几个字面量是领域值、不是界面文案，所以标 `i18n-ignore` 让门禁放行。
 */
const GROUPS: readonly { group: SessionSummary["group"]; labelKey: MessageKey }[] = [
  { group: "今天", labelKey: "sidebar.group.today" }, // i18n-ignore
  { group: "昨天", labelKey: "sidebar.group.yesterday" }, // i18n-ignore
  { group: "更早", labelKey: "sidebar.group.earlier" }, // i18n-ignore
];

const NAV_ITEMS = [
  ["sessions", "sidebar.nav.sessions", MessageSquare],
  ["code", "sidebar.nav.code", FolderGit2],
] as const;

const REPO_STATE_KEY: Record<RepoRowState, MessageKey> = {
  hasLocal: "sidebar.projects.state.hasLocal",
  needsClone: "sidebar.projects.state.needsClone",
  browseOnly: "sidebar.projects.state.browseOnly",
};

function sameIdentity(
  left: { host?: string | null; owner: string; name: string },
  right: { host?: string | null; owner: string; name: string },
): boolean {
  return (
    (left.host ?? "").trim().toLowerCase() === (right.host ?? "").trim().toLowerCase() &&
    left.owner === right.owner &&
    left.name === right.name
  );
}

function rowKey(row: RepoPickerRow): string {
  return `${row.host.trim().toLowerCase()}\u0000${row.owner}\u0000${row.name}`;
}

function toRepoDto(repo: GithubRepo): RepoDto {
  return {
    id: repo.id,
    host: repo.host,
    owner: repo.owner,
    name: repo.name,
    defaultBranch: repo.defaultBranch,
    pinned: repo.pinned,
    lastUsedAt: repo.lastUsedAt,
    locals: repo.locals,
  };
}

export function Sidebar({
  mode,
  onModeChange,
  sessions,
  activeId,
  profiles,
  players,
  repos,
  prsByRepo,
  identityByRepo,
  onSelect,
  onNew,
  onNewWithProfile,
  onOpenSettings,
  onDeleteSession,
  isSessionBusy,
  onOpenRepo,
  onAddRepo,
  onAddFromGh,
  onPin,
  onNewSessionForRepo,
  focusAddSignal,
  width = 260,
}: SidebarProps) {
  const { t } = useTranslation();
  const [panelOpen, setPanelOpen] = useState(false);
  const [path, setPath] = useState("");
  const [localError, setLocalError] = useState<CmdError | null>(null);
  const [addingLocal, setAddingLocal] = useState(false);
  const [ghState, setGhState] = useState<GhStatusDto | null>(null);
  const [ghListings, setGhListings] = useState<GhRepoListingDto[]>([]);
  const [ghHasMore, setGhHasMore] = useState(false);
  const [ghLoading, setGhLoading] = useState(false);
  const [ghError, setGhError] = useState<CmdError | null>(null);
  const [actionError, setActionError] = useState<CmdError | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [activeRow, setActiveRow] = useState(0);
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const localInputRef = useRef<HTMLInputElement>(null);
  const focusedOnOpen = useRef(false);
  const loadToken = useRef(0);
  /** 应用版本：Tauri 环境才有；网页预览（探针/测试）拿不到就不显示（§35）。 */
  const [appVersion, setAppVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void getVersion()
      .then((v) => {
        if (alive) setAppVersion(v);
      })
      .catch(() => {
        if (alive) setAppVersion(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  const version = versionLabel(appVersion);
  const beta = isBetaVersion(appVersion);

  useEffect(() => {
    if (!focusAddSignal) return;
    setPanelOpen(true);
    focusedOnOpen.current = true;
    const frame = window.requestAnimationFrame(() => localInputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [focusAddSignal]);

  const repoDtos = useMemo(() => repos.map(toRepoDto), [repos]);
  const rows = useMemo(
    () => sortRepoRows(buildRepoRows(repoDtos, ghListings)),
    [ghListings, repoDtos],
  );

  const loadGh = useCallback(async (force: boolean) => {
    const token = ++loadToken.current;
    setGhLoading(true);
    setGhError(null);
    try {
      const status = await ghStatus(force);
      if (token !== loadToken.current) return;
      setGhState(status);
      if (!status.available || !status.loggedIn) {
        setGhListings([]);
        setGhHasMore(false);
        return;
      }
      const list = await ghReposList(undefined, 50, force);
      if (token !== loadToken.current) return;
      setGhListings(list.items);
      setGhHasMore(list.hasMore);
    } catch (e) {
      if (token !== loadToken.current) return;
      setGhError(asCmdError(e));
      setGhListings([]);
      setGhHasMore(false);
    } finally {
      if (token === loadToken.current) setGhLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!panelOpen) {
      focusedOnOpen.current = false;
      return;
    }
    void loadGh(false);
  }, [loadGh, panelOpen]);

  useEffect(() => {
    if (!panelOpen || focusedOnOpen.current || rows.length === 0) return;
    const frame = window.requestAnimationFrame(() => {
      rowRefs.current[0]?.focus();
      focusedOnOpen.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [panelOpen, rows.length]);

  useEffect(() => {
    if (activeRow >= rows.length) setActiveRow(0);
  }, [activeRow, rows.length]);

  const grouped = useMemo(
    () =>
      GROUPS.map(({ group, labelKey }) => ({
        labelKey,
        items: sessions.filter((s) => s.group === group),
      })).filter((x) => x.items.length > 0),
    [sessions],
  );

  const submit = async () => {
    const v = path.trim();
    if (!v || addingLocal) return;
    setLocalError(null);
    setAddingLocal(true);
    try {
      await onAddRepo(v);
      setPath("");
    } catch (e) {
      setLocalError(asCmdError(e));
    } finally {
      setAddingLocal(false);
    }
  };

  const findRepo = (row: RepoPickerRow): GithubRepo | undefined =>
    repos.find((repo) => sameIdentity(repo, row));

  const commitRow = async (row: RepoPickerRow, openAfter: boolean): Promise<RepoDto | null> => {
    const existing = findRepo(row);
    if (existing) {
      if (openAfter) onOpenRepo(existing.id);
      return toRepoDto(existing);
    }

    setActionError(null);
    setBusyKey(rowKey(row));
    try {
      const dto = await onAddFromGh({
        host: row.host || null,
        owner: row.owner,
        name: row.name,
        defaultBranch: row.defaultBranch ?? null,
      });
      if (openAfter) onOpenRepo(dto.id);
      return dto;
    } catch (e) {
      const error = asCmdError(e);
      setActionError(error);
      clog("REPO-BROWSE-FAIL", `${row.host || "-"}/${row.owner}/${row.name} code=${error.code}`);
      return null;
    } finally {
      setBusyKey(null);
    }
  };

  const activateRow = (row: RepoPickerRow) => {
    if (row.state === "needsClone") {
      const key = rowKey(row);
      setExpandedKey((prev) => (prev === key ? null : key));
      return;
    }
    void commitRow(row, true);
  };

  const browseRow = (row: RepoPickerRow) => {
    void commitRow(row, true);
  };

  const togglePin = async (row: RepoPickerRow) => {
    const existing = findRepo(row);
    setActionError(null);
    setBusyKey(rowKey(row));
    try {
      if (existing) {
        await onPin(existing.id, !existing.pinned);
      } else {
        const dto = await onAddFromGh({
          host: row.host || null,
          owner: row.owner,
          name: row.name,
          defaultBranch: row.defaultBranch ?? null,
        });
        await onPin(dto.id, true);
      }
    } catch (e) {
      const error = asCmdError(e);
      setActionError(error);
      clog("REPO-PIN-FAIL", `${row.host || "-"}/${row.owner}/${row.name} code=${error.code}`);
    } finally {
      setBusyKey(null);
    }
  };

  const copyClone = async (row: RepoPickerRow) => {
    const command = repoCloneCommand(row);
    setActionError(null);
    try {
      await copyText(command);
      const key = rowKey(row);
      setCopiedKey(key);
      clog("REPO-CLONE-HINT", `${row.host || "-"}/${row.owner}/${row.name} cmd=${command}`);
      window.setTimeout(() => setCopiedKey((prev) => (prev === key ? null : prev)), 1200);
    } catch (e) {
      const error = asCmdError(e);
      setActionError(error);
      clog("REPO-CLONE-FAIL", `${row.host || "-"}/${row.owner}/${row.name} code=${error.code}`);
    }
  };

  const focusRow = (index: number) => {
    if (rows.length === 0) return;
    const next = Math.max(0, Math.min(rows.length - 1, index));
    setActiveRow(next);
    rowRefs.current[next]?.focus();
  };

  const listKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusRow(activeRow + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusRow(activeRow - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      focusRow(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusRow(rows.length - 1);
    }
  };

  // 统一走 errorTextOf：它按 key 查 zh-CN 资源再带参翻译，动态 key 不需要逐个特判
  // （特判写法会撞 i18next 的 t() 重载：动态 key 的两参形式要求 options 带 defaultValue）。
  const localErrorText = localError ? errorTextOf(localError, t) : null;

  // 只有「真的用不了」才叫不可用：没装、没登录。cwdOk 判的是应用进程的工作目录是不是
  // git 仓库（打包后是 exe 目录，永远不是），与「能不能列仓库 / 看 PR」无关，不再当成故障。
  const ghBanner = !ghState
    ? null
    : !ghState.available
      ? { title: t("sidebar.projects.ghMissing"), body: t("err.gh.notInstalled"), login: false }
      : !ghState.loggedIn
        ? {
            title: t("sidebar.projects.ghNotLoggedIn"),
            body: t("sidebar.projects.ghLoginHint"),
            login: true,
          }
        : null;

  return (
    <aside style={{ width }} className="sc-pane flex h-full shrink-0 flex-col overflow-hidden">
      {/* 一级导航：会话 / 代码（底框 + 磨砂滑块横移） */}
      <div className="px-2.5 pt-3 pb-2.5">
        <div
          className="sc-switch"
          role="group"
          aria-label={t("sidebar.nav.ariaLabel")}
          style={
            {
              "--switch-index": mode === "sessions" ? 0 : 1,
              "--switch-count": 2,
            } as React.CSSProperties
          }
        >
          <span className="sc-switch__thumb" aria-hidden="true" />
          {NAV_ITEMS.map(([id, labelKey, Icon]) => (
            <button
              key={id}
              aria-pressed={mode === id}
              onClick={() => onModeChange(id)}
              className="sc-switch__item"
            >
              <Icon className="size-3.5" />
              {t(labelKey)}
            </button>
          ))}
        </div>
      </div>

      {mode === "sessions" ? (
        <>
          <div className="px-2.5 pb-2">
            <NewSessionButton profiles={profiles} onNew={onNew} onNewWithProfile={onNewWithProfile} />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {grouped.map(({ labelKey, items }) => (
              <div key={labelKey} className="mb-0.5">
                <div className="px-2 pt-2 pb-1 text-micro font-medium tracking-wide text-ink-3">
                  {t(labelKey)}
                </div>
                {items.map((s) => {
                  const active = s.id === activeId;
                  // 老会话可能没有 profileId；查不到配置时直接不渲染，避免「未知」噪音
                  const profile = s.profileId
                    ? profiles.find((p) => p.id === s.profileId)
                    : undefined;
                  const busy = isSessionBusy?.(s.id) ?? false;
                  return (
                    <div
                      key={s.id}
                      className={cn(
                        "group relative mb-0.5 rounded-mark transition-colors",
                        active ? "sc-row-active" : "hover:bg-surface-3",
                      )}
                    >
                      <button
                        onClick={() => onSelect(s.id)}
                        className="flex w-full flex-col gap-0.5 rounded-mark px-2.5 py-2 pr-7 text-left"
                      >
                      <span
                        className={cn(
                          "truncate text-small",
                          active ? "text-ink-1" : "text-ink-2 group-hover:text-ink-1",
                        )}
                      >
                        {s.title}
                      </span>
                      <span className="flex min-w-0 items-center gap-1">
                        {s.playerIds.slice(0, 3).map((pid) => {
                          const pl = players.find((x) => x.id === pid);
                          return pl ? (
                            <Tooltip key={pid} label={localizeText(pl.name, t)}>
                              <span
                                className="size-1.5 rounded-full"
                                style={{ background: pl.color }}
                              />
                            </Tooltip>
                          ) : null;
                        })}
                        <span className="min-w-0 truncate font-mono text-micro text-ink-3">
                          {s.cwd}
                        </span>
                        {profile && (
                          <span
                            className={cn(
                              // 这里只说「这个会话属于谁」，不做连接状态着色 ——
                              // 状态属于当前那个会话，在标题栏里显示，列在这里会变成一堆绿灰点。
                              "ml-auto max-w-18 shrink-0 truncate rounded-mark bg-surface-3/35 px-1 py-px font-mono text-micro text-ink-3 transition-colors group-hover:bg-surface-3/55",
                            )}
                          >
                            {profileLabel(profile, t)}
                          </span>
                        )}
                      </span>
                      </button>
                      {/* hover 才出现：删除是低频破坏性操作，不该一直挂在那儿等误点 */}
                      <div className="absolute right-1 top-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
                        <SessionMoreMenu
                          busy={busy}
                          onDelete={() => onDeleteSession(s)}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <div className="px-2 pt-1 pb-1 text-micro font-medium tracking-wide text-ink-3">
              {t("sidebar.projects.heading")}
            </div>
            {repos.length === 0 && (
              <p className="px-2.5 py-1.5 text-micro leading-relaxed text-ink-3">
                {t("sidebar.projects.empty")}
              </p>
            )}
            {repos.map((r) => {
              const count = (prsByRepo[r.id] ?? []).length;
              return (
                <RepoButton
                  key={r.id}
                  repo={r}
                  count={count}
                  identity={identityByRepo[r.id]}
                  onOpen={onOpenRepo}
                  onNewSession={onNewSessionForRepo}
                />
              );
            })}

            <div className="sc-control mt-1 flex w-full items-center rounded-control bg-surface-3/50 transition-colors hover:bg-surface-3/85">
              <button
                type="button"
                aria-haspopup="dialog"
                onClick={() => setPanelOpen(true)}
                className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-small text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
              >
                <Plus className="size-3.5 shrink-0 text-ink-2" />
                {t("sidebar.projects.add")}
              </button>
            </div>

            <Dialog
              open={panelOpen}
              onClose={() => setPanelOpen(false)}
              title={t("sidebar.projects.panelTitle")}
              width="md"
            >
              <div className="flex flex-col">
                  <div className="flex shrink-0 items-center justify-between gap-2 px-2.5 pt-2 pb-1">
                    <span
                      id="sidebar-add-project-title"
                      className="text-micro font-medium tracking-wide text-ink-2"
                    >
                      {t("sidebar.projects.fromGh")}
                    </span>
                    <button
                      type="button"
                      aria-label={t("sidebar.projects.refresh")}
                      aria-busy={ghLoading}
                      disabled={ghLoading}
                      onClick={() => void loadGh(true)}
                      className="grid size-6 shrink-0 place-items-center rounded-mark text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1 disabled:opacity-50"
                    >
                      <RefreshCw className={cn("size-3", ghLoading && "animate-spin")} />
                    </button>
                  </div>

                  {ghBanner && (
                    <div className="mx-1.5 mb-1.5 shrink-0 rounded-mark bg-surface-2/50 px-2 py-1.5">
                      <p className="text-micro font-medium text-ink-2">{ghBanner.title}</p>
                      <p className="mt-0.5 text-micro leading-relaxed text-ink-3">{ghBanner.body}</p>
                      {(ghState?.ghPath || ghState?.version || ghState?.host) && (
                        <p className="mt-0.5 break-all font-mono text-micro text-ink-3">
                          {[ghState?.ghPath, ghState?.version, ghState?.host]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      )}
                      {ghBanner.login && (
                        <button
                          type="button"
                          onClick={() => void copyText("gh auth login")}
                          className="mt-1 mr-2 rounded-mark text-micro text-accent-1 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                        >
                          {t("sidebar.projects.copyLoginCommand")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => localInputRef.current?.focus()}
                        className="mt-1 rounded-mark text-micro text-accent-1 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                      >
                        {t("sidebar.projects.manualPath")}
                      </button>
                    </div>
                  )}

                  {ghError && (
                    <div className="mx-1.5 mb-1.5 shrink-0">
                      <p role="alert" className="break-words text-micro text-danger-1">
                        {errorTextOf(ghError, t)}
                      </p>
                      <button
                        type="button"
                        onClick={() => localInputRef.current?.focus()}
                        className="mt-1 rounded-mark text-micro text-accent-1 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                      >
                        {t("sidebar.projects.manualPath")}
                      </button>
                    </div>
                  )}

                  <div
                    role="list"
                    aria-label={t("sidebar.projects.fromGh")}
                    onKeyDown={listKeyDown}
                    className="max-h-80 overflow-y-auto px-1.5 pb-1"
                  >
                    {ghLoading && rows.length === 0 && (
                      <p className="px-1 py-1 text-micro text-ink-3">{t("ui.button.loading")}</p>
                    )}
                    {!ghLoading && rows.length === 0 && !ghBanner && !ghError && (
                      <p className="px-1 py-1 text-micro leading-relaxed text-ink-3">
                        {t("sidebar.projects.emptyGh")}
                      </p>
                    )}
                    {rows.map((row, index) => {
                      const key = rowKey(row);
                      const stateKey = REPO_STATE_KEY[row.state];
                      const displayName = `${row.owner}/${row.name}`;
                      const fullName = row.host
                        ? `${row.host}/${row.owner}/${row.name}`
                        : displayName;
                      const busy = busyKey === key;
                      const expanded = expandedKey === key;
                      return (
                        <div
                          key={key}
                          role="listitem"
                          onFocusCapture={() => setActiveRow(index)}
                          className="group mb-0.5 rounded-mark transition-colors hover:bg-surface-3/45"
                        >
                          <div className="flex items-center gap-1 rounded-mark px-1.5 py-1">
                            <button
                              ref={(el) => {
                                rowRefs.current[index] = el;
                              }}
                              type="button"
                              tabIndex={index === activeRow ? 0 : -1}
                              onFocus={() => setActiveRow(index)}
                              onClick={() => activateRow(row)}
                              aria-label={t("sidebar.projects.rowAria", {
                                name: fullName,
                                state: t(stateKey),
                              })}
                              className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-mark px-1 py-0.5 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                            >
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span className="min-w-0 truncate text-ui-tight text-ink-1">
                                  {displayName}
                                </span>
                                {row.pinned && <Pin className="size-2.5 shrink-0 text-accent-1" />}
                              </span>
                              <span className="flex min-w-0 items-center gap-1 font-mono text-micro text-ink-3">
                                <span>
                                  {t(
                                    row.source === "gh"
                                      ? "sidebar.projects.source.gh"
                                      : "sidebar.projects.source.local",
                                  )}
                                </span>
                                {row.host && <span className="truncate">· {row.host}</span>}
                              </span>
                            </button>

                            <button
                              type="button"
                              tabIndex={index === activeRow ? 0 : -1}
                              aria-label={t(
                                row.pinned ? "sidebar.projects.unpin" : "sidebar.projects.pin",
                                { name: fullName },
                              )}
                              disabled={busy}
                              onClick={() => void togglePin(row)}
                              className={cn(
                                "grid size-6 shrink-0 place-items-center rounded-mark text-ink-3 transition-opacity hover:bg-surface-3 hover:text-ink-1 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1 group-hover:opacity-100 disabled:opacity-40",
                                row.pinned ? "opacity-100" : "opacity-0",
                              )}
                            >
                              {busy ? (
                                <Loader2 className="size-3 animate-spin" />
                              ) : row.pinned ? (
                                <PinOff className="size-3" />
                              ) : (
                                <Pin className="size-3" />
                              )}
                            </button>

                            <button
                              type="button"
                              tabIndex={index === activeRow ? 0 : -1}
                              aria-label={t("sidebar.projects.rowAction", {
                                name: fullName,
                                action: t(stateKey),
                              })}
                              disabled={busy}
                              onClick={() => activateRow(row)}
                              className={cn(
                                "shrink-0 rounded-mark px-1.5 py-0.5 text-micro transition-colors hover:bg-surface-3/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1 disabled:opacity-50",
                                row.state === "needsClone"
                                  ? "text-accent-1"
                                  : row.state === "hasLocal"
                                    ? "text-ok-1"
                                    : "text-ink-3",
                              )}
                            >
                              {t(stateKey)}
                            </button>
                          </div>

                          {expanded && row.state === "needsClone" && (
                            <div className="mx-1.5 mb-1 flex flex-wrap items-center gap-1 rounded-mark bg-surface-2/50 px-2 py-1.5">
                              <p className="w-full text-micro leading-relaxed text-ink-3">
                                {t("sidebar.projects.cloneHint")}
                              </p>
                              <button
                                type="button"
                                onClick={() => browseRow(row)}
                                className="rounded-mark px-1.5 py-0.5 text-micro text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                              >
                                {t("sidebar.projects.browseAction")}
                              </button>
                              <button
                                type="button"
                                onClick={() => void copyClone(row)}
                                className="flex items-center gap-1 rounded-mark px-1.5 py-0.5 text-micro text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                              >
                                {copiedKey === key ? (
                                  <Check className="size-3 text-ok-1" />
                                ) : (
                                  <Copy className="size-3" />
                                )}
                                {copiedKey === key
                                  ? t("repo.copied")
                                  : t("sidebar.projects.copyCloneCommand")}
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {ghHasMore && (
                    <p className="shrink-0 px-2.5 pb-1 text-micro text-ink-3">
                      {t("sidebar.projects.onlyRecent", { count: 50 })}
                    </p>
                  )}

                  {actionError && (
                    <p role="alert" className="mx-2.5 mb-1.5 shrink-0 break-words text-micro text-danger-1">
                      {errorTextOf(actionError, t)}
                    </p>
                  )}

                <div className="shrink-0 border-t border-line-1/60 px-2.5 py-2">
                  <div className="text-micro font-medium tracking-wide text-ink-2">
                    {t("sidebar.projects.localDir")}
                  </div>
                  <div className="mt-1 flex items-center gap-1">
                    <input
                      ref={localInputRef}
                      value={path}
                      onChange={(e) => {
                        setPath(e.target.value);
                        if (localError) setLocalError(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void submit();
                      }}
                      aria-label={t("sidebar.projects.localDir")}
                      placeholder={t("sidebar.projects.placeholder")}
                      className="sc-selectable min-w-0 flex-1 rounded-mark bg-surface-3/45 px-2 py-1 font-mono text-caption text-ink-1 placeholder:text-ink-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                    />
                    <button
                      type="button"
                      disabled={addingLocal || !path.trim()}
                      onClick={() => void submit()}
                      className="rounded-mark bg-surface-3 px-2 py-1 text-caption text-ink-2 transition-colors hover:bg-surface-3/80 hover:text-ink-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {addingLocal ? t("ui.button.loading") : t("ui.button.add")}
                    </button>
                  </div>
                  <p className="mt-1 text-micro leading-relaxed text-ink-3">
                    {t("sidebar.projects.addHint")}
                  </p>
                  {localErrorText && (
                    <p role="alert" className="mt-1 break-words text-micro text-danger-1">
                      {localErrorText}
                    </p>
                  )}
                </div>
              </div>
            </Dialog>
          </div>
        </>
      )}

      <div className="border-t border-line-1/80 p-2">
        <button
          onClick={onOpenSettings}
          className="mt-0.5 flex w-full items-center gap-2 rounded-mark px-2 py-1.5 text-ui-tight text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink-2"
        >
          <Settings2 className="size-3.5 shrink-0" />
          {t("sidebar.settings")}
          {version && (
            <span
              className="ml-auto flex shrink-0 items-center gap-1.5"
              aria-hidden="true"
            >
              <span className="text-micro tabular-nums text-ink-3">{version}</span>
              {beta && (
                <span className="rounded-full border border-line-1 px-1.5 text-micro uppercase text-ink-3">
                  beta
                </span>
              )}
            </span>
          )}
        </button>
      </div>
    </aside>
  );
}

function RepoButton({
  repo,
  count,
  identity,
  onOpen,
  onNewSession,
}: {
  repo: GithubRepo;
  count: number;
  identity: RepoRefDto | undefined;
  onOpen: (id: string) => void;
  onNewSession: (repo: GithubRepo) => void;
}) {
  const { t } = useTranslation();
  const [el, setEl] = useState<HTMLButtonElement | null>(null);
  const hover = useHoverCard();
  const browseOnly = repo.locals.length === 0;
  // 身份来自 gh_repo_resolve；还没解析出来时显示 path 尾段，绝不显示占位 slug。
  const subtitle = identity
    ? `${identity.owner}/${identity.name}`
    : repo.path
      ? repo.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || repo.path
      : `${repo.host ? `${repo.host}/` : ""}${repo.owner}/${repo.name}`;
  const source = t(
    browseOnly ? "sidebar.projects.source.gh" : "sidebar.projects.source.local",
  );
  return (
    <>
      <div className="group relative mb-0.5 rounded-mark transition-colors hover:bg-surface-3">
        <button
          ref={setEl}
          {...hover.triggerProps(el)}
          onClick={() => onOpen(repo.id)}
          className="flex w-full flex-col gap-0.5 rounded-mark px-2.5 py-2 pr-8 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
        >
          <span className="flex items-center gap-1.5">
            <StatusDot status={identity ? "connected" : "untested"} />
            <span className="truncate text-small text-ink-2 transition-colors duration-150 group-hover:text-ink-1">
              {localizeText(repo.name, t)}
            </span>
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {count > 0 && (
                <span className="font-mono text-micro text-ink-3">{count}</span>
              )}
              {browseOnly && (
                <span className="rounded-full bg-surface-3/45 px-1.5 py-px text-micro text-ink-3">
                  {t("sidebar.projects.browseOnlyBadge")}
                </span>
              )}
            </span>
          </span>
          <span className="flex min-w-0 items-center gap-1 pl-3 font-mono text-micro text-ink-3">
            <span className="shrink-0">{source}</span>
            <span className="truncate">{subtitle}</span>
          </span>
          {browseOnly && (
            <span className="pl-3 text-micro leading-relaxed text-ink-3">
              {t("sidebar.projects.browseOnlyHint")}
            </span>
          )}
        </button>
        <div className="absolute top-1.5 right-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            disabled={browseOnly}
            onClick={() => onNewSession(repo)}
            aria-label={t("sidebar.newSession")}
            title={browseOnly ? t("sidebar.projects.browseOnlyHint") : t("sidebar.newSession")}
            className="grid size-6 place-items-center rounded-mark text-ink-3 transition-colors hover:bg-surface-3/70 hover:text-ink-1 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <MessageSquarePlus className="size-3" />
          </button>
        </div>
      </div>
      {hover.card(<span className="break-all font-mono">{repo.path || subtitle}</span>)}
    </>
  );
}

/**
 * 「新建会话」的拆分控件：主按钮沿用最近用的连接（零步骤），只配了多个连接时
 * 才亮出右侧下拉让用户指定。
 *
 * 为什么不做成「新建后去标题栏改归属」：那是把一件事拆成不连贯的两步，而且改的时候
 * 会话已经存在，用户容易先发了一句话才发现归属不对。
 */
function NewSessionButton({
  profiles,
  onNew,
  onNewWithProfile,
}: {
  profiles: AgentProfile[];
  onNew: () => void;
  onNewWithProfile: (profileId: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const multi = profiles.length > 1;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <div className="sc-control flex w-full items-center rounded-control bg-surface-3/50 transition-colors hover:bg-surface-3/85">
        <button
          onClick={onNew}
          className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2 text-left text-small text-ink-1"
        >
          <Plus className="size-3.5 shrink-0 text-ink-2" />
          {t("sidebar.newSession")}
          {!multi && (
            <kbd className="ml-auto rounded-mark border border-line-1/70 px-1.5 py-0.5 font-mono text-micro text-ink-3">
              Ctrl N
            </kbd>
          )}
        </button>
        {multi && (
          <button
            aria-label={t("sidebar.newSession.chooseAgent")}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="mr-1 grid size-6 shrink-0 place-items-center rounded-mark text-ink-3 transition-colors hover:bg-surface-3/70 hover:text-ink-1"
          >
            <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          </button>
        )}
      </div>

      {open && multi && (
        <div className="sc-glass absolute top-full right-0 left-0 sc-z-popover mt-1.5 rounded-card p-1">
          <div className="px-2 py-1.5 text-micro text-ink-3">
            {t("sidebar.newSession.agentHint")}
          </div>
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => {
                onNewWithProfile(p.id);
                setOpen(false);
              }}
              className="flex w-full items-center gap-2 rounded-mark px-2 py-1.5 text-left transition-colors hover:bg-surface-3"
            >
              <span className="min-w-0 flex-1 truncate text-ui-tight text-ink-1">
                {profileLabel(p, t)}
              </span>
              <span className="shrink-0 font-mono text-micro text-ink-3">{p.launch}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
