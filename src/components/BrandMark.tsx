/**
 * sincearc 标识：一条连续的 S 曲线（since 的首字母与 arc 是同一个形态），
 * 左上一颗起点圆点。1024 坐标系，颜色一律 currentColor —— 暗色近白、浅色近黑。
 *
 * 为什么不在应用里加辉光：辉光属于品牌物料（图标、启动页、官网），
 * 应用内的标题栏/空态是 chrome，按设计语言走扁平 + 边框，不加光晕。
 */
import { cn } from "@/lib/utils";

export function BrandMark({
  className,
  title,
}: {
  className?: string;
  /** 给了就作为可访问名；纯装饰（旁边已有 sincearc 字样）时不传，自动 aria-hidden */
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      className={cn("shrink-0 text-ink-1", className)}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      <g transform="translate(46 46) translate(-197.6 -215.6) scale(1.386)">
        <path
          d="M 300 240 C 700 240, 760 430, 512 520 C 264 610, 324 810, 724 810"
          fill="none"
          stroke="currentColor"
          strokeWidth={75}
          strokeLinecap="round"
        />
        <circle cx="300" cy="240" r="66.4" fill="currentColor" />
      </g>
    </svg>
  );
}
