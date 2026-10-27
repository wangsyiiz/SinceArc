import { MoreHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Menu } from "./ui/Menu";

export interface MenuItem {
  label: string;
  icon?: ReactNode;
  /** 破坏性操作：红字，并且一般要配确认 */
  danger?: boolean;
  disabled?: boolean;
  /** 禁用时的原因：灰着不解释是最烦人的那种禁用 */
  hint?: string;
  onSelect: () => void;
}

/**
 * 通用「⋯」小菜单。
 *
 * 触发按钮本身不带样式主张：由调用方决定放哪、多大、何时出现（例如会话条目的 hover）。
 */
export function MoreMenu({
  items,
  label,
  className,
  iconSize = 14,
  triggerRef,
}: {
  items: MenuItem[];
  label?: string;
  className?: string;
  iconSize?: number;
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
}) {
  const { t } = useTranslation();
  const ariaLabel = label ?? t("moreMenu.ariaLabel");
  return (
    <Menu
      ariaLabel={ariaLabel}
      triggerRef={triggerRef}
      align="end"
      compact
      triggerVariant="ghost"
      itemSize="caption"
      className={cn("size-6 p-0 text-ink-3 hover:text-ink-1", className)}
      trigger={<MoreHorizontal size={iconSize} aria-hidden="true" />}
      items={items.map((item, index) => ({
        id: `${index}-${item.label}`,
        label: item.label,
        icon: item.icon,
        danger: item.danger,
        disabled: item.disabled,
        disabledReason: item.hint,
        description: item.disabled ? item.hint : undefined,
        onSelect: item.onSelect,
      }))}
    />
  );
}
