import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

/**
 * 会话条目的右键菜单（§41.6，2026-11-02 改）。
 *
 * 为什么从「hover 出现的 ⋯」改成右键：⋯ 按钮挂在每一行右上角，鼠标扫过列表时它会闪，
 * 而且它和未读徽标、执行中状态共用右边缘，位置一直在挤。右键是低频破坏性操作的自然入口，
 * 不占版面、不需要 hover 才显形。
 *
 * 面板必须是 portal + position: fixed：会话列表在 overflow-y-auto 里，就地渲染会被裁掉。
 */
export function SessionContextMenu({
  x,
  y,
  busy,
  onDelete,
  onClose,
}: {
  x: number;
  y: number;
  busy: boolean;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });

  // 贴着点击点，但不出窗口：右下角右键时往上/往左翻
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 8;
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - rect.width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - rect.height - margin)),
    });
    el.focus();
  }, [x, y]);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onDismiss = () => onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onDismiss);
    window.addEventListener("blur", onDismiss);
    window.addEventListener("scroll", onDismiss, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onDismiss);
      window.removeEventListener("blur", onDismiss);
      window.removeEventListener("scroll", onDismiss, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      tabIndex={-1}
      aria-label={t("moreMenu.ariaLabel")}
      style={{ position: "fixed", top: pos.top, left: pos.left, animation: "sc-pop 120ms var(--ease-pop)" }}
      onContextMenu={(event) => event.preventDefault()}
      className="sc-glass sc-z-popover w-48 rounded-card p-1 focus-visible:outline-none"
    >
      <button
        type="button"
        role="menuitem"
        disabled={busy}
        aria-description={busy ? t("settings.sessionMcp.busyHint") : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (busy) return;
          onDelete();
          onClose();
        }}
        className={cn(
          "flex w-full items-center gap-2 rounded-mark px-2 py-1.5 text-left text-caption transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1",
          busy
            ? "cursor-not-allowed opacity-45 text-danger-1"
            : "text-danger-1 hover:bg-danger-1/10",
        )}
      >
        <Trash2 size={12} aria-hidden="true" />
        {t("settings.sessionMcp.deleteSession")}
      </button>
      {busy && (
        <div className="px-2 pb-1 text-micro text-ink-3">
          {t("settings.sessionMcp.busyHint")}
        </div>
      )}
    </div>,
    document.body,
  );
}
