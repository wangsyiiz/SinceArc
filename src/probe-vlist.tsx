import { useCallback, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useVirtualList } from "./lib/virtual/useVirtualList.ts";
import {
  __resetHeightClassCache,
  estimateMessageHeight,
} from "./lib/virtual/message-height.ts";

/**
 * 虚拟列表性能探针（不打包进正式产物：只由 probe-vlist.html 引用）。
 *
 * 目的：量化「消息条数增长 → 帧时间变差」到底出在哪。
 *   ?n=5000    消息条数
 *   ?md=0.3    含 markdown 块语法（```/表格）的比例 —— 只有这类消息会触发 parseMarkdown
 *   ?cache=1   估计值按消息 id 缓存（对照修复方案：同一份数据、同一个页面）
 */

interface Msg {
  id: string;
  text: string;
  atomKind?: string;
}

const params = new URLSearchParams(location.search);
const N = Number(params.get("n") ?? "5000");
const MD = Number(params.get("md") ?? "0.3");
const CACHE = params.get("cache") === "1";

// 压测样本数据，不进界面文案
const plainText = (i: number) =>
  `第 ${i} 条：这条是普通正文，模拟大部分回复长度，大约一两句话，没有代码块也没有表格。`; // i18n-ignore

const codeText = (i: number) =>
  `改好了（第 ${i} 条）。\n\n\`\`\`ts\nexport function double(x: number): number {\n  return x * 2;\n}\n\`\`\`\n\n其余说明文字在这里。`; // i18n-ignore

const tableText = (i: number) =>
  `第 ${i} 条对比：\n\n| 方案 | 代价 |\n| --- | --- |\n| A | 小 |\n| B | 大 |\n`; // i18n-ignore

// 确定性伪随机：同一份数据每次跑都一样，两次测量才可比
const messages: Msg[] = Array.from({ length: N }, (_, i) => {
  const r = ((i * 2654435761) % 1000) / 1000;
  const text = r < MD ? (i % 3 === 0 ? tableText(i) : codeText(i)) : plainText(i);
  return { id: `m${i}`, text, atomKind: "text" };
});

const cache = new Map<string, number>();
const stats = { calls: 0, ms: 0, parses: 0 };

function estimateRaw(index: number): number {
  const msg = messages[index];
  // 对照基线：每次都清掉分类缓存，等价于改造前"每帧重新判断/解析"的成本。
  __resetHeightClassCache();
  const t0 = performance.now();
  const height = estimateMessageHeight(msg);
  stats.ms += performance.now() - t0;
  stats.calls += 1;
  if (msg?.text && /```|~~~|!\[|\|/.test(msg.text)) stats.parses += 1;
  return height;
}

function estimateCached(index: number): number {
  const msg = messages[index];
  if (!msg) return 72;
  const hit = cache.get(msg.id);
  if (hit !== undefined) {
    stats.calls += 1;
    return hit;
  }
  const height = estimateRaw(index);
  cache.set(msg.id, height);
  return height;
}

function Probe() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const estimate = CACHE ? estimateCached : estimateRaw;
  const keyOf = useCallback((index: number) => messages[index]?.id ?? `i${index}`, []);
  const { rows, totalSize, measureRow } = useVirtualList({
    count: messages.length,
    keyOf,
    estimate,
    scrollRef,
  });

  const runScroll = useCallback(async (steps: number, pxPerStep: number) => {
    const el = scrollRef.current;
    if (!el) return null;
    stats.calls = 0;
    stats.ms = 0;
    stats.parses = 0;
    el.scrollTop = 0;
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    const frameMs: number[] = [];
    let last = performance.now();
    await new Promise<void>((resolve) => {
      let done = 0;
      const step = (now: number) => {
        frameMs.push(now - last);
        last = now;
        el.scrollTop += pxPerStep;
        done += 1;
        if (done < steps) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });

    const sorted = [...frameMs].sort((a, b) => a - b);
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
    return {
      count: messages.length,
      cache: CACHE,
      mdRatio: MD,
      frames: frameMs.length,
      p50: +at(0.5).toFixed(2),
      p95: +at(0.95).toFixed(2),
      max: +(sorted[sorted.length - 1] ?? 0).toFixed(2),
      estCalls: stats.calls,
      estMs: +stats.ms.toFixed(1),
      estParses: stats.parses,
      callsPerFrame: +(stats.calls / Math.max(1, frameMs.length)).toFixed(1),
    };
  }, []);

  (window as unknown as { __probe: unknown }).__probe = { runScroll };

  return (
    <div
      ref={scrollRef}
      /* 配色由 probe-vlist.html 的 body 决定，这里不写颜色（样式棘轮与令牌校验都盯着 .tsx） */
      style={{ height: "100vh", overflowY: "auto" }}
    >
      <div style={{ height: totalSize, position: "relative" }}>
        {rows.map((row) => (
          <div
            key={row.key}
            data-index={row.index}
            ref={measureRow}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "100%",
              transform: `translateY(${row.start}px)`,
              padding: "8px 12px",
              whiteSpace: "pre-wrap",
              font: "13px/1.6 ui-monospace, Consolas, monospace",
            }}
          >
            {messages[row.index]?.text}
          </div>
        ))}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root") as HTMLElement).render(<Probe />);
