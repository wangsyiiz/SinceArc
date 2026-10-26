import { useRef, type KeyboardEvent } from "react";

import { CODE_THEMES, type CodeThemeId, type TokenKind } from "../../lib/highlight/themes.ts";

/**
 * 代码配色选择器（§20.3）：每套主题一张卡，卡内用该主题的**真实配色**渲染同一段样例代码。
 *
 * - 样例走 `data-code-theme` + `data-code-tokens` + `data-token`，颜色全部来自 CSS 变量，
 *   组件里**不出现任何色值**，也就不会与主题表脱钩；
 * - 语义是单选组（role=radiogroup / radio + aria-checked），Tab 进组、方向键移动并选中；
 * - 缩略图不是真实代码块：不带语言标签、不带复制按钮、不参与滚动测量。
 */

type SampleLine = readonly (readonly [TokenKind, string])[];

const SAMPLE: readonly SampleLine[] = [
  // 四行都控制在 21 字符内：卡片缩到 160px 宽时也不会横向被裁（真机量过 scrollWidth）。
  [
    ["keyword", "const"],
    ["plain", " n"],
    ["operator", " ="],
    ["plain", " "],
    ["number", "42"],
    ["punct", ";"],
  ],
  [
    ["function", "greet"],
    ["punct", "("],
    ["plain", "who"],
    ["punct", ": "],
    ["type", "User"],
    ["punct", ")"],
  ],
  [
    ["comment", "// 你好，代码"],
  ],
  [
    ["keyword", "return"],
    ["plain", " "],
    ["string", "\"hi\""],
    ["operator", " ||"],
    ["plain", " "],
    ["literal", "null"],
  ],
];

export function CodeThemePicker({
  value,
  onChange,
  label,
}: {
  value: CodeThemeId;
  onChange: (value: CodeThemeId) => void;
  label: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (index: number, delta: number) => {
    const next = (index + delta + CODE_THEMES.length) % CODE_THEMES.length;
    const target = CODE_THEMES[next];
    if (!target) return;
    onChange(target.id);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        event.preventDefault();
        move(index, 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        event.preventDefault();
        move(index, -1);
        break;
      case "Home":
        event.preventDefault();
        move(0, 0);
        break;
      case "End":
        event.preventDefault();
        move(CODE_THEMES.length - 1, 0);
        break;
      default:
        break;
    }
  };

  return (
    <div role="radiogroup" aria-label={label} className="grid grid-cols-2 gap-3 md:grid-cols-3">
      {CODE_THEMES.map((theme, index) => {
        const selected = theme.id === value;
        return (
          <button
            key={theme.id}
            ref={(el) => {
              buttons.current[index] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(theme.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={`sc-theme-card ${selected ? "sc-theme-card-selected" : ""}`}
          >
            <span className="sc-code-thumb" data-code-theme={theme.id}>
              <span data-code-tokens>
                {SAMPLE.map((line, lineIndex) => (
                  <span key={lineIndex} className="block whitespace-pre">
                    {line.map(([kind, text], tokenIndex) => (
                      <span key={tokenIndex} data-token={kind}>
                        {text}
                      </span>
                    ))}
                  </span>
                ))}
              </span>
            </span>
            <span className="mt-2 flex items-center justify-between gap-2">
              <span className="text-ui text-ink-1">{theme.label}</span>
              {selected && <span className="text-caption text-ink-3">已选</span>}
            </span>
          </button>
        );
      })}
    </div>
  );
}
