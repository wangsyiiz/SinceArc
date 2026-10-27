import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";
import { useTranslation } from "react-i18next";

interface ConnectErrorStateProps {
  code?: string;
  message: string;
  resumeUnavailable?: boolean;
  newSessionBusy?: boolean;
  /** 正在重试：按钮转圈 + 标题下一条细滑块，点一次就必须看得出来在动 */
  retrying?: boolean;
  onRetry: () => void;
  onNewSession?: () => void;
  onOpenSettings?: () => void;
}

export function ConnectErrorState({
  code,
  message,
  resumeUnavailable = false,
  newSessionBusy = false,
  retrying = false,
  onRetry,
  onNewSession,
  onOpenSettings,
}: ConnectErrorStateProps) {
  const { t } = useTranslation();
  const detail = [code, message].filter(Boolean).join(" ");

  // 不要 title：这块占满消息区，鼠标一挪进来就弹原生 tip，又大又没必要。
  // 说明也不截断，改成限高可滚 —— 省得「看不全只能靠 tip」。
  return (
    <div
      role="alert"
      className="flex flex-1 flex-col justify-center py-12 [&_p]:max-h-24 [&_p]:overflow-y-auto [&_p]:break-words [&_p]:font-mono"
    >
      <EmptyState
        heading={t("connectError.heading")}
        description={detail}
        icon={
          <div className="grid size-12 place-items-center rounded-card border border-line-1 bg-surface-1 text-accent-1">
            <BrandMark className="size-7" />
          </div>
        }
        action={
          <div className="flex flex-col items-center gap-3">
            {retrying && <span className="sc-indeterminate" role="presentation" />}
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button
                variant="primary"
                loading={retrying}
                loadingText={t("connectError.reconnecting")}
                disabled={retrying}
                onClick={onRetry}
              >
                {t("ui.emptyState.retry")}
              </Button>
              {resumeUnavailable && onNewSession && (
                <Button
                  variant="secondary"
                  disabled={newSessionBusy || retrying}
                  onClick={onNewSession}
                >
                  {t("sidebar.newSession")}
                </Button>
              )}
              {onOpenSettings && (
                <Button variant="secondary" disabled={retrying} onClick={onOpenSettings}>
                  {t("ui.button.openSettings")}
                </Button>
              )}
            </div>
          </div>
        }
      />
    </div>
  );
}
