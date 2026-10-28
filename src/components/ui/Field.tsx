import { cloneElement, isValidElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";

export function Field(props: {
  label: string;
  htmlFor: string;
  required?: boolean;
  optional?: boolean;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  const { label, htmlFor, required, optional, hint, error, children } = props;
  const { t } = useTranslation();
  const control =
    required && isValidElement<Record<string, unknown>>(children)
      ? cloneElement(children, { "aria-required": true })
      : children;
  return (
    <div className="flex flex-col gap-1.5">
      {/* 标签是标签，不和正文抢同一档（13→11，2026-10-24 所有者定 B 方案）。
          表单密集时 13px 的标签会把整页顶大一档；11px + font-medium 仍有层级。 */}
      <label htmlFor={htmlFor} className="text-caption font-medium text-ink-2">
        {label}
        {required && (
          <span aria-hidden="true" className="ml-0.5 text-danger-1">
            *
          </span>
        )}
        {optional && <span className="ml-1 text-ink-3">{t("ui.field.optional")}</span>}
      </label>
      {control}
      {hint && <p className="text-caption text-ink-3">{hint}</p>}
      {error && (
        <p className="text-caption text-danger-1" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * 输入框的焦点反馈是**描边变色**，不是 2px 外环（§1.11 的替代方案）。
 *
 * `focus-visible:outline-none` 是必须的：浏览器默认会给聚焦元素画一圈 UA 描边，
 * 只删掉我们的 outline-2 反而剩下"1px 边框 + 1px UA 环"，看起来还是粗的
 * （2026-10-23 实测：暗色聚焦后 border 1px accent + outline 1px auto）。
 * 抑制 UA 环、把可见性交给 `focus:border-accent-1`，这才是规范要的等价样式。
 */
const controlClass =
  "w-full rounded-control border border-line-2 bg-surface-1 px-3 text-ui text-ink-1 placeholder:text-ink-3 transition-colors hover:bg-surface-2 focus:border-accent-1 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 read-only:border-transparent read-only:bg-surface-1 read-only:text-ink-2 read-only:hover:bg-surface-1 read-only:focus:border-transparent";

export const Input: React.FC<
  React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean }
> = ({ invalid = false, className, ...props }) => (
  <input
    {...props}
    aria-invalid={invalid || undefined}
    className={cn(
      controlClass,
      "h-9",
      invalid && "border-danger-1 focus:border-danger-1",
      className,
    )}
  />
);

export const Textarea: React.FC<
  React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
> = ({ invalid = false, className, ...props }) => (
  <textarea
    {...props}
    aria-invalid={invalid || undefined}
    className={cn(
      controlClass,
      "min-h-20 resize-y py-2",
      invalid && "border-danger-1 focus:border-danger-1",
      className,
    )}
  />
);
