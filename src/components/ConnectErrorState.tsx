import { BrandMark } from "@/components/BrandMark";
import { Button } from "@/components/ui/Button";
import { EmptyState } from "@/components/ui/EmptyState";

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
  const detail = [code, message].filter(Boolean).join(" ");

  return (
    <div
      role="alert"
      title={detail}
      className="flex flex-1 flex-col justify-center py-12 [&_p]:line-clamp-2 [&_p]:break-words [&_p]:font-mono"
    >
      <EmptyState
        title="连不上这个会话"
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
                loadingText="正在重连…"
                disabled={retrying}
                onClick={onRetry}
              >
                重试
              </Button>
              {resumeUnavailable && onNewSession && (
                <Button
                  variant="secondary"
                  disabled={newSessionBusy || retrying}
                  onClick={onNewSession}
                >
                  新建会话
                </Button>
              )}
              {onOpenSettings && (
                <Button variant="secondary" disabled={retrying} onClick={onOpenSettings}>
                  打开设置
                </Button>
              )}
            </div>
          </div>
        }
      />
    </div>
  );
}
