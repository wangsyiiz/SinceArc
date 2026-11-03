import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { CapabilityDto } from "@/lib/ipc";
import { type CapabilityMap } from "@/lib/gh-display";
import { cn } from "@/lib/utils";
import { Tooltip } from "../ui/Tooltip";

function denyText(
  capability: CapabilityDto | undefined,
  t: TFunction,
): string {
  if (!capability) return t("repo.dash.denied.unavailable");
  switch (capability.reason) {
    case "readonly":
      return t("repo.dash.readonly");
    case "missingScope":
      return t("repo.dash.denied.missingScope", { scope: capability.scope ?? "" });
    case "archived":
      return t("repo.dash.denied.archived");
    case "noPermission":
      return t("repo.dash.denied.noPermission");
    default:
      return t("repo.dash.denied.unavailable");
  }
}

/**
 * 写动作按钮：只读期渲染但不可点。
 * 不用原生 `disabled`，否则 hover/focus 事件被浏览器吞掉，Tooltip 就失效了。
 */
export function WriteAction({
  action,
  label,
  capabilities,
  icon,
  className,
}: {
  action: string;
  label: string;
  capabilities: CapabilityMap;
  icon?: ReactNode;
  className?: string;
}) {
  const { t } = useTranslation();
  const capability = capabilities[action];
  const allowed = capability?.allowed === true;
  const button = (
    <button
      type="button"
      aria-disabled={allowed ? undefined : "true"}
      onClick={(event) => {
        if (!allowed) event.preventDefault();
      }}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-control border border-control bg-surface-2 px-2.5 text-small text-ink-1 transition-colors hover:bg-surface-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-1",
        !allowed && "cursor-not-allowed opacity-50",
        className,
      )}
    >
      {icon}
      {label}
    </button>
  );
  if (allowed) return button;
  return <Tooltip label={denyText(capability, t)}>{button}</Tooltip>;
}
