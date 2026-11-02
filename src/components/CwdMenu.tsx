import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Copy, FolderOpen, Lock } from "lucide-react";
import type { AgentProfile } from "@/types";
import { errorTextOf } from "@/lib/errors";
import { asCmdError, sessionRecentCwds } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { Button } from "./ui/Button";
import { CwdBrowse } from "./CwdPicker";
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
            className="sc-glass sc-z-popover w-[min(460px,calc(100vw-24px))] rounded-card p-3"
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

            <code className="mb-2 block break-all rounded-mark bg-surface-2/60 px-2 py-1.5 font-mono text-caption text-ink-2">
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
                  className="w-full rounded-mark border border-line-2 bg-surface-1 px-2 py-1.5 font-mono text-caption text-ink-1 placeholder:text-ink-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1"
                />
                <CwdBrowse profile={profile} value={draft} onPicked={setDraft} />
                {recent.length > 0 && (
                  <div className="mt-2">
                    <div className="mb-1 text-micro text-ink-3">{t("statusbar.cwd.recent")}</div>
                    <div className="flex flex-col gap-0.5">
                      {recent.map((path) => (
                        <button
                          key={path}
                          type="button"
                          onClick={() => setDraft(path)}
                          className="truncate rounded-mark px-1.5 py-1 text-left font-mono text-caption text-ink-2 hover:bg-surface-2"
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
