import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";
import type { Block, Inline } from "@/lib/markdown";
import { parseMarkdown } from "@/lib/markdown";
import { openExternal } from "@/lib/ipc";

async function copyText(text: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
    await navigator.clipboard.writeText(text);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    textarea.remove();
  }
}

function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  const [hint, setHint] = useState<"copied" | "failed" | null>(null);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const flash = (next: "copied" | "failed") => {
    setHint(next);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      setHint(null);
      timerRef.current = null;
    }, 1200);
  };

  const copyLink = async () => {
    await copyText(href);
    flash("copied");
  };

  // 成功不提示（fire-and-forget，我们并不知道浏览器真开了）；只有命令报错才说「打不开」。
  const openLink = async () => {
    try {
      await openExternal(href);
    } catch {
      flash("failed");
    }
  };

  return (
    <button
      type="button"
      role="link"
      title={`${href}\n单击复制 · Ctrl+点击在浏览器打开`}
      onClick={(event) => {
        event.preventDefault();
        if (event.ctrlKey || event.metaKey) void openLink();
        else void copyLink();
      }}
      onAuxClick={(event) => {
        // 中键：浏览器里中键=新标签，这里映射成「在系统浏览器打开」。
        if (event.button !== 1) return;
        event.preventDefault();
        void openLink();
      }}
      className="cursor-pointer text-accent-1 underline underline-offset-2 hover:text-ink-1"
    >
      {children}
      {hint === "copied" && <span className="text-ink-3"> · 已复制</span>}
      {hint === "failed" && <span className="text-danger-1"> · 打不开</span>}
    </button>
  );
}

/**
 * 流式光标。正文变成块级元素之后，父级的 `.sc-caret::after` 会被挤到最后一个块下面一行
 * （它是 inline-block，而块级兄弟之后必然换行），所以光标改成渲染在**最后一段行内文本的末尾**。
 */
function CaretMark() {
  return <span className="sc-caret-inline" aria-hidden="true" />;
}

function renderInlines(inlines: Inline[], taskMarker = false, caret = false): ReactNode[] {
  const nodes = inlines.map((inline, index) => {
    switch (inline.kind) {
      case "text": {
        if (taskMarker && (inline.text.startsWith("☐ ") || inline.text.startsWith("☑ "))) {
          return (
            <Fragment key={index}>
              <span className="font-mono">{inline.text.slice(0, 1)}</span>
              {inline.text.slice(1)}
            </Fragment>
          );
        }
        return <Fragment key={index}>{inline.text}</Fragment>;
      }
      case "strong":
        return <strong key={index}>{renderInlines(inline.children)}</strong>;
      case "em":
        return <em key={index}>{renderInlines(inline.children)}</em>;
      case "del":
        return <del key={index}>{renderInlines(inline.children)}</del>;
      case "code":
        return <code key={index}>{inline.text}</code>;
      case "link":
        return (
          <LinkButton key={index} href={inline.href}>
            {renderInlines(inline.children)}
          </LinkButton>
        );
      case "br":
        return <br key={index} />;
    }
  });
  return caret ? [...nodes, <CaretMark key="caret" />] : nodes;
}

const HEADING_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"] as const;

function headingClass(depth: number): string {
  return depth <= 2 ? "text-body font-medium" : "text-ui font-medium";
}

function renderParagraph(
  block: Extract<Block, { kind: "paragraph" }>,
  key: number,
  taskMarker = false,
  caret = false,
) {
  return <p key={key}>{renderInlines(block.children, taskMarker, caret)}</p>;
}

function caretParagraph(key: string) {
  return (
    <p key={key}>
      <CaretMark />
    </p>
  );
}

function renderBlock(block: Block, key: number, caret = false): ReactNode {
  switch (block.kind) {
    case "paragraph":
      return renderParagraph(block, key, false, caret);
    case "heading": {
      const Heading = HEADING_TAGS[block.depth - 1] ?? "h6";
      return (
        <Heading key={key} className={headingClass(block.depth)}>
          {renderInlines(block.children, false, caret)}
        </Heading>
      );
    }
    case "code":
      return (
        <Fragment key={key}>
          <div className="relative">
            {block.lang && (
              <span className="pointer-events-none absolute right-2.5 top-1.5 text-micro text-ink-3">
                {block.lang}
              </span>
            )}
            <pre>
              <code>{block.text}</code>
            </pre>
          </div>
          {caret && caretParagraph("caret")}
        </Fragment>
      );
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      const lastItem = block.items.length - 1;
      return (
        <List
          key={key}
          className={block.task ? "list-none" : undefined}
          {...(block.ordered ? { start: block.start } : {})}
        >
          {block.items.map((item, itemIndex) => {
            const itemCarriesCaret = caret && itemIndex === lastItem;
            return (
              <li key={itemIndex}>
                {item.length === 0 && itemCarriesCaret
                  ? caretParagraph("caret")
                  : item.map((child, childIndex) => {
                      const childCaret = itemCarriesCaret && childIndex === item.length - 1;
                      return block.task && childIndex === 0 && child.kind === "paragraph"
                        ? renderParagraph(child, childIndex, true, childCaret)
                        : renderBlock(child, childIndex, childCaret);
                    })}
              </li>
            );
          })}
        </List>
      );
    }
    case "quote":
      return <blockquote key={key}>{renderBlocks(block.blocks, caret)}</blockquote>;
    case "table":
      return (
        <Fragment key={key}>
          <div className="sc-table-wrap">
            <table>
              <thead>
                <tr>
                  {block.header.map((cell, cellIndex) => (
                    <th
                      key={cellIndex}
                      className="bg-surface-2"
                      style={{ textAlign: block.align[cellIndex] ?? undefined }}
                    >
                      {renderInlines(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.map((cell, cellIndex) => (
                      <td key={cellIndex} style={{ textAlign: block.align[cellIndex] ?? undefined }}>
                        {renderInlines(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {caret && caretParagraph("caret")}
        </Fragment>
      );
    case "hr":
      return (
        <Fragment key={key}>
          <hr />
          {caret && caretParagraph("caret")}
        </Fragment>
      );
  }
}

function renderBlocks(blocks: Block[], caret = false): ReactNode[] {
  return blocks.map((block, index) =>
    renderBlock(block, index, caret && index === blocks.length - 1),
  );
}

export function Markdown({
  source,
  caret = false,
}: {
  source: string;
  caret?: boolean;
}): ReactElement | null {
  const blocks = useMemo(() => parseMarkdown(source), [source]);
  if (blocks.length === 0) return caret ? <div className="sc-prose min-w-0"><p><CaretMark /></p></div> : null;
  return <div className="sc-prose min-w-0">{renderBlocks(blocks, caret)}</div>;
}
