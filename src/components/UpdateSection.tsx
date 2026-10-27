import { useCallback, useEffect, useState } from "react";
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
function explain(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const low = raw.toLowerCase();
  if (low.includes("signature") || low.includes("verif")) {
    return `签名校验失败：更新包的签名与客户端内置公钥不匹配，已中止。${raw}`;
  }
  if (low.includes("releas") || low.includes("latest.json") || low.includes("404")) {
    return `拿不到更新清单：仓库还没有正式发布，或网络被挡。${raw}`;
  }
  if (low.includes("network") || low.includes("dns") || low.includes("timed out") || low.includes("connect")) {
    return `网络失败：连不上更新端点。${raw}`;
  }
  if (low.includes("installer") || low.includes("nsis") || low.includes("execute")) {
    return `安装器启动失败：更新包已下载，但拉起安装程序时出错。${raw}`;
  }
  return raw;
}

export function UpdateSection() {
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
      setPhase({ kind: "error", message: explain(e) });
    }
  }, []);

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
      setPhase({ kind: "error", message: explain(e) });
    }
  }, []);

  return (
    <div className="mt-5">
      <h2 className="text-small font-medium text-ink-2">更新</h2>
      <div className="mt-3 divide-y divide-line-1/50">
        <div className="flex items-center justify-between gap-6 py-4">
          <div className="min-w-0">
            <span className="text-ui text-ink-1">当前版本</span>
            <p className="mt-1 text-caption text-ink-3">
              更新只走正式发布；预发布（continuous）不会推给你。
            </p>
          </div>
          <span className="font-mono text-ui text-ink-2">{version ? `v${version}` : "—"}</span>
        </div>

        <div className="py-4">
          <div className="flex items-center justify-between gap-6">
            <div className="min-w-0">
              <span className="text-ui text-ink-1">检查更新</span>
              <p className="mt-1 text-caption text-ink-3">
                {phase.kind === "current" && `已是最新版本（${phase.checkedAt} 检查）`}
                {phase.kind === "checking" && "正在获取更新清单…"}
                {phase.kind === "idle" && "点了才检查，不在启动时静默下载。"}
                {phase.kind === "found" && `发现新版本 v${phase.update.version}`}
                {phase.kind === "downloading" &&
                  (phase.total > 0
                    ? `正在下载 v${phase.version}：${fmtMB(phase.done)} / ${fmtMB(phase.total)}`
                    : `正在下载 v${phase.version}…`)}
                {phase.kind === "installed" && `v${phase.version} 已安装，正在重启…`}
                {phase.kind === "error" && phase.message}
              </p>
            </div>

            {phase.kind === "found" ? (
              <Button variant="primary" size="sm" onClick={() => void install(phase.update)}>
                下载并安装
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void runCheck()}
                disabled={phase.kind === "checking" || phase.kind === "downloading"}
              >
                {phase.kind === "checking" ? "检查中…" : "检查更新"}
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
              更新端点：releases/latest/download/latest.json（见 docs/distribution.md §9）
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
