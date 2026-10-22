import { AlertTriangle, ChevronDown } from "lucide-react";
import type { ModeOption } from "@/lib/ipc";
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
  followLabel = "跟随连接默认",
  fallbackLabel,
  warning,
  onChoose,
  disabled = false,
  compact = false,
  variant = "session",
}: ModeSelectProps) {
  const unsupported = available.length === 0;
  const locked = disabled || unsupported;
  const currentLabel = (available.find((mode) => mode.id === current)?.name ?? current) || "未上报";

  const items: MenuItem[] = [
    {
      id: "follow",
      label: followLabel,
      hint: fallbackLabel ?? "agent 默认",
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
            label: "注意",
            description: warning,
            icon: <AlertTriangle className="size-3 shrink-0 text-warn-1" />,
            disabled: true,
            disabledReason: warning,
          },
        ]
      : []),
  ];

  return (
    <Menu
      ariaLabel="文件编辑审批模式"
      align="end"
      compact={compact}
      triggerVariant="ghost"
      className="max-w-60"
      disabled={locked}
      disabledReason={
        unsupported ? "该连接没有报上来可选模式" : disabled ? "当前不可选择模式" : undefined
      }
      section={variant === "session" ? "文件编辑审批" : undefined}
      description={
        variant === "session" ? "只管文件编辑；命令是否询问由 agent 自己的审批策略决定" : undefined
      }
      items={items}
      trigger={
        <span className="flex min-w-0 items-center gap-1.5" title={warning ?? undefined}>
          <span className="truncate">{unsupported ? "不支持" : currentLabel}</span>
          {following && !unsupported && (
            <span className="shrink-0 rounded-mark border border-line-1 px-1 text-caption text-ink-3">
              跟随
            </span>
          )}
          <ChevronDown className="size-3 shrink-0 text-ink-3" aria-hidden="true" />
        </span>
      }
    />
  );
}
