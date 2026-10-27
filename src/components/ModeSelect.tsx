import { useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ModeOption } from "@/lib/ipc";
import { useHoverCard } from "./ui/HoverCard";
import { Menu, type MenuItem } from "./ui/Menu";

interface ModeSelectProps {
  /** 当前生效的模式（agent 报的，或我们推成功的） */
  current: string | null;
  /** 可选模式；空数组 = 这个连接没报上来，按钮要显示「不支持」并禁用 */
  available: ModeOption[];
  /** 是否处于「跟随 / 不指定」状态（规范 §5.2：这个状态必须能看出来，不能只显示当前值） */
  following: boolean;
  /** 「跟随」那一行的标题：会话里是「跟随连接默认」，设置页是「不指定」 */
  followLabel?: string;
  /** 跟随状态下实际生效的是哪个模式 —— 显示在那一行的行尾（对勾之前） */
  fallbackLabel?: string | null;
  warning?: string | null;
  /** null = 改回跟随 / 不指定 */
  onChoose: (modeId: string | null) => void;
  disabled?: boolean;
  /** 状态栏用紧凑尺寸，设置页用常规尺寸 */
  compact?: boolean;
  /**
   * session = 会话内选择器，带「只管文件编辑」说明块；
   * connection = 连接默认选择器，**不带**说明块 —— 那里用户在配这个值本身，
   * 一行不可选的分组标题只是噪音。
   */
  variant?: "session" | "connection";
}

export function ModeSelect({
  current,
  available,
  following,
  followLabel,
  fallbackLabel,
  warning,
  onChoose,
  disabled = false,
  compact = false,
  variant = "session",
}: ModeSelectProps) {
  const { t } = useTranslation();
  const followLabelText = followLabel ?? t("mode.follow.default");
  const unsupported = available.length === 0;
  const locked = disabled || unsupported;
  const currentLabel =
    (available.find((mode) => mode.id === current)?.name ?? current) ||
    t("mode.current.unreported");
  const [warningEl, setWarningEl] = useState<HTMLSpanElement | null>(null);
  const warningHover = useHoverCard({ disabled: !warning || locked });

  const items: MenuItem[] = [
    {
      id: "follow",
      label: followLabelText,
      // 曾经挂在 hint（右侧），和同一条目的对勾抢位置（§3.3）。它是解释不是值，走下行。
      description: fallbackLabel ?? t("mode.fallback.agentDefault"),
      checked: following,
      onSelect: () => onChoose(null),
    },
    ...available.map((mode) => ({
      id: `mode:${mode.id}`,
      label: mode.name,
      description: mode.description ?? undefined,
      checked: !following && mode.id === current,
      onSelect: () => onChoose(mode.id),
    })),
    ...(warning
      ? [
          {
            id: "warning",
            label: t("mode.warning"),
            description: warning,
            icon: <AlertTriangle className="size-3 shrink-0 text-warn-1" />,
            disabled: true,
            disabledReason: warning,
          },
        ]
      : []),
  ];

  return (
    <>
      <Menu
        ariaLabel={t("mode.aria")}
        align="end"
        compact={compact}
        triggerVariant="ghost"
        className="max-w-60"
        disabled={locked}
        disabledReason={
          unsupported
            ? t("mode.disabled.unsupported")
            : disabled
              ? t("mode.disabled.current")
              : undefined
        }
        section={variant === "session" ? t("mode.section") : undefined}
        description={
          variant === "session"
            ? t("mode.description")
            : undefined
        }
        items={items}
        trigger={
          <span
            ref={setWarningEl}
            {...warningHover.triggerProps(warningEl)}
            className="flex min-w-0 items-center gap-1.5"
          >
            <span className="truncate">
              {unsupported ? t("mode.unsupported") : currentLabel}
            </span>
            {following && !unsupported && (
              <span className="shrink-0 rounded-mark border border-line-1 px-1 text-caption text-ink-3">
                {t("mode.following")}
              </span>
            )}
            <ChevronDown className="size-3 shrink-0 text-ink-3" aria-hidden="true" />
          </span>
        }
      />
      {warningHover.card(
        <span className="break-words text-caption text-ink-2">{warning}</span>,
      )}
    </>
  );
}
