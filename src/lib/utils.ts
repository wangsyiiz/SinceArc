import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge 不认识我们的自定义字号档（`text-caption` / `text-ui-tight` / …），
 * 默认会把它当成**文字颜色**，于是同一串 cn() 里后出现的 `text-ink-*` 把字号整条顶掉：
 *
 *   cn("text-caption", "text-ink-1")  →  "text-ink-1"     // 字号没了
 *
 * 表现是「菜单一打开、按钮 hover 时字突然大一级」（实际掉回了继承字号）。
 * 把七档注册进 font-size 组，颜色组保持原样。
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        { text: ["micro", "caption", "ui-tight", "small", "ui", "body", "lead", "title"] },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
