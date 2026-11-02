import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import {
  ArrowUp,
  Check,
  ChevronDown,
  Copy,
  FolderOpen,
  FolderSearch,
  Loader2,
  Lock,
} from "lucide-react";
import type { AgentProfile } from "@/types";
import type { DirListingDto } from "@/lib/ipc/types";
import { errorTextOf } from "@/lib/errors";
import { asCmdError, listDirs, pickDirectory, sessionRecentCwds } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Button } from "./ui/Button";
import { useAnchoredLayer } from "./ui/Menu";

/**
 * 状态栏左端的工作目录（docs/desktop-ux.md §45）。
 *
 * 会话还没发出第一条用户消息 → 可点开更换；发出过就锁定，只读展示 + 复制路径。
 * 换目录在协议层是 `session/new` 重建 ACP 会话，所以只能在没有上下文损失的时候做。
 */
export function CwdButton({
  cwd,
  profile,
  editable,
  onChange,
}: {
  cwd: string;
  profile?: AgentProfile;
  editable: boolean;
  /** 返回 null = 改成功；返回字符串 = 已经本地化好的错误文案。 */
  onChange?: (next: string) => Promise<string | null>;
}) {
  const { t } = useTranslation();
  const layer = useAnchoredLayer({ align: "start", prefer: "below" });
  const [draft, setDraft] = useState(cwd);
  const [recent, setRecent] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  /** 只有本地连接能开系统目录选择器；WSL/SSH 是远端路径 */
  const isLocal = profile?.launch === "local";
  /** 远端浏览面板是否展开（WSL / SSH） */
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    setDraft(cwd);
  }, [cwd]);

  useEffect(() => {
    if (!layer.open) return;
    setError(null);
    setCopied(false);
    setDraft(cwd);
    if (editable && profile) {
      let alive = true;
      sessionRecentCwds(profile.id)
        .then((paths) => {
          if (alive) setRecent(paths.filter((path) => path !== cwd));
        })
        .catch(() => {
          if (alive) setRecent([]);
        });
      return () => {
        alive = false;
      };
    }
    return undefined;
  }, [cwd, editable, layer.open, profile]);

  const apply = async (next: string) => {
    if (busy || !onChange) return;
    const value = next.trim();
    if (!value) {
      setError(t("statusbar.cwd.empty"));
      return;
    }
    setBusy(true);
    setError(null);
    const failure = await onChange(value);
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    layer.setOpen(false);
  };

  /**
   * 系统目录选择器。只对本地连接给入口 —— WSL/SSH 的工作目录是远端路径，
   * 系统选择器只能选 Windows 本机磁盘（远端走各自的浏览弹窗，尚未实现）。
   */
  const browse = async () => {
    try {
      const picked = await pickDirectory(draft.trim() || undefined, t("statusbar.cwd.browseTitle"));
      // 只回填、不提交：让他看清选中的是哪一级目录，再点「更换」。
      if (picked) setDraft(picked);
    } catch (e) {
      setError(errorTextOf(asCmdError(e), t));
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(cwd);
      setCopied(true);
    } catch (e) {
      setError(errorTextOf(asCmdError(e), t));
    }
  };

  return (
    <>
      <Button
        ref={layer.triggerRef}
        variant="ghost"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={layer.open}
        aria-label={editable ? t("statusbar.cwd.change") : t("statusbar.cwd.lockedAria")}
        className="h-auto min-w-0 justify-start gap-1.5 rounded-mark px-1.5 py-1 font-mono text-caption font-normal"
        onClick={() => layer.toggle()}
      >
        {editable ? (
          <FolderOpen className="size-3 shrink-0 text-ink-3" aria-hidden="true" />
        ) : (
          <Lock className="size-3 shrink-0 text-ink-3/70" aria-hidden="true" />
        )}
        <span className="truncate">{cwd || t("statusbar.cwd.emptyValue")}</span>
        <ChevronDown className="size-3 shrink-0 text-ink-3" />
      </Button>

      {layer.open &&
        createPortal(
          <div
            ref={layer.panelRef}
            style={layer.style}
            role="dialog"
            aria-label={t("statusbar.cwd.dialogAria")}
            className="z-50 w-[min(460px,calc(100vw-24px))] rounded-card border border-line-1 bg-bg-1 p-3 shadow-pop"
          >
            <div className="mb-2 flex items-center justify-between">
              <span className="text-caption font-medium text-ink-1">{t("statusbar.cwd.title")}</span>
              {!editable && (
                <span className="flex items-center gap-1 text-micro text-ink-3">
                  <Lock className="size-3" aria-hidden="true" />
                  {t("statusbar.cwd.lockedTag")}
                </span>
              )}
            </div>

            <code className="mb-2 block break-all rounded-mark bg-bg-2 px-2 py-1.5 font-mono text-caption text-ink-2">
              {cwd || t("statusbar.cwd.emptyValue")}
            </code>

            {editable ? (
              <>
                <input
                  autoFocus
                  value={draft}
                  spellCheck={false}
                  placeholder={t("statusbar.cwd.placeholder")}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void apply(draft);
                    }
                    if (e.key === "Escape") layer.setOpen(false);
                  }}
                  className="w-full rounded-mark border border-line-1 bg-surface-1 px-2 py-1.5 font-mono text-caption text-ink-1 placeholder:text-ink-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                />
                <div className="mt-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => (isLocal ? void browse() : setBrowsing((open) => !open))}
                  >
                    <FolderSearch className="size-3" aria-hidden="true" />
                    {isLocal ? t("statusbar.cwd.browse") : t("statusbar.cwd.browseRemote")}
                  </Button>
                </div>
                {browsing && !isLocal && profile && (
                  <RemotePicker
                    profile={profile}
                    startPath={draft}
                    onPick={(picked) => {
                      setDraft(picked);
                      setBrowsing(false);
                    }}
                  />
                )}
                {recent.length > 0 && (
                  <div className="mt-2">
                    <div className="mb-1 text-micro text-ink-3">{t("statusbar.cwd.recent")}</div>
                    <div className="flex flex-col gap-0.5">
                      {recent.map((path) => (
                        <button
                          key={path}
                          type="button"
                          onClick={() => setDraft(path)}
                          className="truncate rounded-mark px-1.5 py-1 text-left font-mono text-caption text-ink-2 hover:bg-bg-2"
                          title={path}
                        >
                          {path}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="mt-2 flex items-center gap-2">
                  {profile?.cwd && profile.cwd !== draft && (
                    <Button variant="ghost" size="sm" onClick={() => setDraft(profile.cwd ?? "")}>
                      {t("statusbar.cwd.useProfile")}
                    </Button>
                  )}
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" onClick={() => layer.setOpen(false)}>
                      {t("common.cancel")}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={busy || !draft.trim() || draft.trim() === cwd}
                      onClick={() => void apply(draft)}
                    >
                      <Check className="size-3" aria-hidden="true" />
                      {busy ? t("statusbar.cwd.applying") : t("statusbar.cwd.apply")}
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-2">
                <p className="min-w-0 flex-1 text-caption text-ink-3">{t("statusbar.cwd.lockedHint")}</p>
                <Button variant="ghost" size="sm" onClick={() => void copy()}>
                  <Copy className="size-3" aria-hidden="true" />
                  {copied ? t("statusbar.cwd.copied") : t("statusbar.cwd.copy")}
                </Button>
              </div>
            )}

            {error && (
              <p className={cn("mt-2 text-caption text-danger-1")} role="alert">
                {error}
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * 远端目录浏览面板（WSL / SSH，docs/desktop-ux.md §45）。
 *
 * 每次导航一次 IPC：远端一次 `bash -s` 往返（wsl.exe 200–300ms，ssh 再加握手），
 * 所以只在「进目录 / 上一级 / 手输跳转」时查，绝不跟着输入逐字符查。
 * 手输入口一直留着 —— 浏览替代不了 `~`、相对路径和权限受限目录。
 */
function RemotePicker({
  profile,
  startPath,
  onPick,
}: {
  profile: AgentProfile;
  startPath: string;
  onPick: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [path, setPath] = useState(startPath.trim() || undefined);
  const [listing, setListing] = useState<DirListingDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jump, setJump] = useState("");

  const load = useCallback(
    async (target?: string) => {
      setBusy(true);
      setError(null);
      try {
        setListing(await listDirs(profile, target));
      } catch (e) {
        const err = asCmdError(e);
        setListing(null);
        setError(errorTextOf(err, t));
      } finally {
        setBusy(false);
      }
    },
    [profile, t],
  );

  useEffect(() => {
    void load(path);
  }, [load, path]);

  return (
    <div className="mt-2 rounded-mark border border-line-1 bg-bg-2/60 p-2">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !listing?.parent}
          onClick={() => listing?.parent && setPath(listing.parent)}
          aria-label={t("statusbar.cwd.up")}
        >
          <ArrowUp className="size-3" aria-hidden="true" />
        </Button>
        <code className="min-w-0 flex-1 truncate font-mono text-caption text-ink-2">
          {listing?.path ?? path ?? "~"}
        </code>
        {busy && <Loader2 className="size-3 shrink-0 animate-spin text-ink-3" aria-hidden="true" />}
      </div>

      <div className="max-h-52 overflow-y-auto rounded-mark bg-bg-1/60">
        {error && <p className="px-2 py-1.5 text-caption text-danger-1">{error}</p>}
        {!error && listing && listing.entries.length === 0 && !busy && (
          <p className="px-2 py-1.5 text-caption text-ink-3">{t("statusbar.cwd.noSubdirs")}</p>
        )}
        {!error &&
          listing?.entries.map((entry: DirListingDto["entries"][number]) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => setPath(entry.path)}
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left font-mono text-caption text-ink-2 hover:bg-bg-2"
              title={entry.path}
            >
              <FolderOpen className="size-3 shrink-0 text-ink-3" aria-hidden="true" />
              <span className="truncate">{entry.name}</span>
            </button>
          ))}
        {listing?.truncated && (
          <p className="px-2 py-1.5 text-micro text-warn-1">{t("statusbar.cwd.truncated")}</p>
        )}
      </div>

      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          value={jump}
          spellCheck={false}
          placeholder={t("statusbar.cwd.jumpPlaceholder")}
          onChange={(e) => setJump(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && jump.trim()) {
              e.preventDefault();
              setPath(jump.trim());
              setJump("");
            }
          }}
          className="min-w-0 flex-1 rounded-mark border border-line-1 bg-surface-1 px-2 py-1 font-mono text-caption text-ink-1 placeholder:text-ink-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
        />
        <Button
          variant="primary"
          size="sm"
          disabled={!listing || busy}
          onClick={() => listing && onPick(listing.path)}
        >
          {t("statusbar.cwd.useThis")}
        </Button>
      </div>
    </div>
  );
}
