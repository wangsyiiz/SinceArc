import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowUp, FolderOpen, FolderSearch, Loader2 } from "lucide-react";
import type { AgentProfile } from "@/types";
import type { DirListingDto } from "@/lib/ipc/types";
import { errorTextOf } from "@/lib/errors";
import { asCmdError, listDirs, pickDirectory } from "@/lib/ipc";
import { Button } from "./ui/Button";

/**
 * 工作目录的「浏览」入口（docs/desktop-ux.md §45）：会话状态栏和设置页共用同一套。
 *
 * 为什么共用：两处的形态规则完全一样 —— 本地连接开系统选择器，WSL/SSH 展开远端浏览。
 * 各写一份必然漂（一边能选远端、一边不能，是这类功能最常见的退化）。
 *
 * 只负责**回填**：选完把路径交给调用方，由调用方决定是否提交。
 */
export function CwdBrowse({
  profile,
  value,
  onPicked,
}: {
  profile?: AgentProfile;
  value: string;
  onPicked: (path: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!profile) return null;
  const isLocal = profile.launch === "local";

  const browseLocal = async () => {
    try {
      setError(null);
      const picked = await pickDirectory(
        value.trim() || undefined,
        t("statusbar.cwd.browseTitle"),
      );
      if (picked) onPicked(picked);
    } catch (e) {
      setError(errorTextOf(asCmdError(e), t));
    }
  };

  return (
    <div className="mt-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => (isLocal ? void browseLocal() : setOpen((prev) => !prev))}
      >
        <FolderSearch className="size-3" aria-hidden="true" />
        {isLocal ? t("statusbar.cwd.browse") : t("statusbar.cwd.browseRemote")}
      </Button>
      {error && <p className="mt-1 text-caption text-danger-1">{error}</p>}
      {open && !isLocal && (
        <RemoteDirPicker
          profile={profile}
          startPath={value}
          onPick={(picked) => {
            onPicked(picked);
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

/**
 * 远端目录浏览面板（WSL / SSH，docs/desktop-ux.md §45）。
 *
 * 每次导航一次 IPC：远端一次 `bash -s` 往返（wsl.exe 200–300ms，ssh 再加握手），
 * 所以只在「进目录 / 上一级 / 手输跳转」时查，绝不跟着输入逐字符查。
 * 手输入口一直留着 —— 浏览替代不了 `~`、相对路径和权限受限目录。
 */
export function RemoteDirPicker({
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
    <div className="mt-2 rounded-mark border border-line-1 bg-surface-2/60 p-2">
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

      <div className="max-h-52 overflow-y-auto rounded-mark bg-surface-1/60">
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
              className="flex w-full items-center gap-1.5 px-2 py-1 text-left font-mono text-caption text-ink-2 hover:bg-surface-2"
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
