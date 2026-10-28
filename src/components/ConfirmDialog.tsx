import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "./ui/Button";
import { Dialog } from "./ui/Dialog";

/**
 * 破坏性操作的确认框。
 *
 * 立场（所有者定过）：不做回收站、不做宽限期 —— **授权即最终**。
 * 所以这里的责任是「把后果说准」，而不是给用户留后悔药：
 * 说清删什么、不删什么、能不能恢复。说清之后他点确认，就照办。
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  /** 说明后果，建议逐条列清楚「会删什么 / 不会删什么」 */
  body: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  return (
    <Dialog
      open={open}
      onClose={onCancel}
      title={title}
      danger={danger}
      icon={danger ? <AlertTriangle className="size-4" /> : undefined}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onCancel}>
            {cancelLabel ?? t("ui.button.cancel")}
          </Button>
          <Button
            variant={danger ? "secondary" : "primary"}
            size="sm"
            danger={danger}
            onClick={onConfirm}
          >
            {confirmLabel ?? t("app.delete.confirm")}
          </Button>
        </>
      }
    >
      {body}
    </Dialog>
  );
}
