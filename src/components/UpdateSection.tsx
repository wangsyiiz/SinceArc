import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { Button } from "@/components/ui/Button";

/**
 * 设置 → 更新。
 *
 * 口径见 docs/distribution.md §9：
 * - 只订阅正式通道（releases/latest/download/latest.json），预发布不推给用户；
 * - 点了才检查，不在启动时静默下载；
 * - 失败按原因分开说（网络 / 签名 / 安装器），不合并成一句「更新失败」。
 */

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current"; checkedAt: string }
  | { kind: "found"; update: Update; notes: string }
  | { kind: "downloading"; version: string; done: number; total: number }
  | { kind: "installed"; version: string }
  | { kind: "error"; message: string };

const fmtMB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** 把异常翻成人话：区分网络、签名、安装器三类。 */
function explain(e: unknown, t: TFunction): string {
  const raw = e instanceof Error ? e.message : String(e);
  const low = raw.toLowerCase();
  if (low.includes("signature") || low.includes("verif")) {
    return t("settings.update.failure.signature", { raw });
  }
  if (low.includes("releas") || low.includes("latest.json") || low.includes("404")) {
    return t("settings.update.failure.manifest", { raw });
  }
  if (low.includes("network") || low.includes("dns") || low.includes("timed out") || low.includes("connect")) {
    return t("settings.update.failure.network", { raw });
  }
  if (low.includes("installer") || low.includes("nsis") || low.includes("execute")) {
    return t("settings.update.failure.installer", { raw });
  }
  return raw;
}

export function UpdateSection() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => setVersion(null));
  }, []);

  const runCheck = useCallback(async () => {
    setPhase({ kind: "checking" });
    try {
      const update = await check();
      if (!update) {
        setPhase({ kind: "current", checkedAt: new Date().toLocaleString() });
        return;
      }
      setPhase({ kind: "found", update, notes: update.body ?? "" });
    } catch (e) {
      setPhase({ kind: "error", message: explain(e, t) });
    }
  }, [t]);

  const install = useCallback(async (update: Update) => {
    let total = 0;
    let done = 0;
    setPhase({ kind: "downloading", version: update.version, done: 0, total: 0 });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          setPhase({ kind: "downloading", version: update.version, done: 0, total });
        } else if (event.event === "Progress") {
          done += event.data.chunkLength;
          setPhase({ kind: "downloading", version: update.version, done, total });
        } else if (event.event === "Finished") {
          setPhase({ kind: "installed", version: update.version });
        }
      });
      // downloadAndInstall 在 Windows 上会拉起 NSIS，安装完成后需要自己重启
      await relaunch();
    } catch (e) {
      setPhase({ kind: "error", message: explain(e, t) });
    }
  }, [t]);

  return (
    <div className="mt-5">
      <h2 className="text-small font-medium text-ink-2">{t("settings.sections.update")}</h2>
      <div className="mt-3 divide-y divide-line-1/50">
        <div className="flex items-center justify-between gap-6 py-4">
          <div className="min-w-0">
            <span className="text-ui text-ink-1">{t("settings.update.currentVersion")}</span>
            <p className="mt-1 text-caption text-ink-3">
              {t("settings.update.releaseOnly")}
            </p>
          </div>
          <span className="font-mono text-ui text-ink-2">{version ? `v${version}` : "—"}</span>
        </div>

        <div className="py-4">
          <div className="flex items-center justify-between gap-6">
            <div className="min-w-0">
              <span className="text-ui text-ink-1">{t("settings.update.check")}</span>
              <p className="mt-1 text-caption text-ink-3">
                {phase.kind === "current" &&
                  t("settings.update.current", { checkedAt: phase.checkedAt })}
                {phase.kind === "checking" && t("settings.update.checkingManifest")}
                {phase.kind === "idle" && t("settings.update.idle")}
                {phase.kind === "found" &&
                  t("settings.update.found", { version: phase.update.version })}
                {phase.kind === "downloading" &&
                  (phase.total > 0
                    ? t("settings.update.downloadingProgress", {
                        version: phase.version,
                        done: fmtMB(phase.done),
                        total: fmtMB(phase.total),
                      })
                    : t("settings.update.downloading", { version: phase.version }))}
                {phase.kind === "installed" &&
                  t("settings.update.installed", { version: phase.version })}
                {phase.kind === "error" && phase.message}
              </p>
            </div>

            {phase.kind === "found" ? (
              <Button variant="primary" size="sm" onClick={() => void install(phase.update)}>
                {t("settings.update.install")}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void runCheck()}
                disabled={phase.kind === "checking" || phase.kind === "downloading"}
              >
                {phase.kind === "checking"
                  ? t("settings.update.checking")
                  : t("settings.update.check")}
              </Button>
            )}
          </div>

          {phase.kind === "found" && phase.notes && (
            <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-mark border border-line-1 bg-surface-2 p-3 text-caption text-ink-2">
              {phase.notes}
            </pre>
          )}

          {phase.kind === "downloading" && phase.total > 0 && (
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-surface-3">
              <div
                className="h-full bg-ink-1 transition-[width] duration-200 ease-out"
                style={{ width: `${Math.min(100, (phase.done / phase.total) * 100)}%` }}
              />
            </div>
          )}

          {phase.kind === "error" && (
            <p className="mt-3 text-caption text-ink-3">
              {t("settings.update.endpoint")}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
