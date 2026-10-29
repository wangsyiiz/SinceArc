/**
 * BrandLoader 的三档结构（docs/desktop-ux.md §21.8 / §21.8 验收 1、4、5）。
 *
 * 视图层是纯函数（brand-loader-view.ts，不走 JSX），所以 `node --test` 可以直接渲染它、
 * 遍历元素树逐条断言：S 的几何只有一份、fill 的遮罩里同时有路径和起点圆点、
 * comet 的亮点与三层拖尾半径对得上、reduced-motion 只挂呼吸类。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ReactElement } from "react";

import {
  S_PATH,
  S_START,
  SWEEP_FROM,
  SWEEP_TO,
  TRAIL_OFFSETS,
} from "../../lib/brand-mark.ts";
import { BrandLoaderView, brandLoaderRootProps } from "./brand-loader-view.ts";

interface El {
  type: string;
  props: Record<string, any>;
}

/** 摊平元素树（只保留宿主元素，丢掉 Fragment / 字符串 / null）。 */
function flatten(node: unknown, out: El[] = []): El[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    node.forEach((child) => flatten(child, out));
    return out;
  }
  if (typeof node === "string" || typeof node === "number") return out;
  const el = node as { type: unknown; props: Record<string, any> };
  if (typeof el.type === "string") out.push({ type: el.type, props: el.props ?? {} });
  flatten(el.props?.children, out);
  return out;
}

function render(variant: "comet" | "fill" | "draw", over: Record<string, any> = {}) {
  const tree = BrandLoaderView({
    variant,
    size: 16,
    maskId: "mask-1",
    length: 1266,
    showStatic: false,
    reducedMotion: false,
    ...over,
  }) as ReactElement<any>;
  return { root: tree, nodes: flatten(tree) };
}

const byTag = (nodes: El[], tag: string) => nodes.filter((n) => n.type === tag);

test("根节点带 data-brand-loader / data-variant 与尺寸，无 label 时 aria-hidden", () => {
  const root = brandLoaderRootProps({ variant: "comet", size: 16 });
  assert.equal(root["data-brand-loader"], "");
  assert.equal(root["data-variant"], "comet");
  assert.deepEqual(root.style, { width: 16, height: 16 });
  assert.equal(root["aria-hidden"], true);
  assert.equal(root.role, undefined);
});

test("有 label 时是可访问名（role=img + aria-label），不再 aria-hidden", () => {
  const root = brandLoaderRootProps({ variant: "fill", size: 20, label: "思考中" });
  assert.equal(root.role, "img");
  assert.equal(root["aria-label"], "思考中");
  assert.equal(root["aria-hidden"], undefined);
  assert.deepEqual(root.style, { width: 20, height: 20 });
});

test("翻转层用 CSS transition（520ms 缓动），不是逐帧改 scaleY 的瞬跳", () => {
  const { root } = render("comet");
  const inner = (root.props.children as ReactElement).props;
  assert.match(String(inner.style.transition), /transform 520ms cubic-bezier/);
  assert.equal(inner.style.transformOrigin, "center");
});

test("comet：轨道 S 与起点圆点用同一份几何，亮点 r=70、拖尾 3 层", () => {
  const { nodes } = render("comet");
  const paths = byTag(nodes, "path");
  assert.ok(paths.length >= 1);
  assert.equal(paths[0].props.d, S_PATH, "轨道路径必须与 BrandMark 同一份 d");

  const radii = byTag(nodes, "circle").map((c) => c.props.r);
  assert.ok(radii.includes(S_START.r), "起点圆点半径来自 S_START");
  assert.ok(radii.includes(70), "亮点 r=70");
  assert.deepEqual(
    TRAIL_OFFSETS.map((_, i) => [58, 52, 46][i]).sort((a, b) => a - b),
    radii.filter((r) => [58, 52, 46].includes(r)).sort((a, b) => a - b),
    "三层拖尾半径 58/52/46 各一个",
  );
});

test("fill：遮罩里同时有路径与起点圆点，竖条从 SWEEP_FROM 起步", () => {
  const { nodes } = render("fill");
  const mask = byTag(nodes, "mask")[0];
  assert.ok(mask, "fill 必须有 mask");
  assert.equal(mask.props.id, "mask-1");

  const maskChildren = flatten(mask.props.children);
  const maskedPath = byTag(maskChildren, "path")[0];
  const maskedCircle = byTag(maskChildren, "circle")[0];
  assert.equal(maskedPath.props.d, S_PATH);
  assert.equal(maskedPath.props.stroke, "white");
  assert.ok(maskedCircle, "遮罩里少了起点圆点，圆点会永远是暗的");

  const rect = byTag(nodes, "rect")[0];
  assert.ok(rect, "fill 必须有扫描竖条");
  assert.equal(rect.props.x, -900);
  assert.equal(rect.props.width, 900);
  assert.equal(rect.props.height, 1424);
  assert.equal(rect.props.transform, `translate(${SWEEP_FROM} 0)`);
  assert.equal(rect.props["data-sweep-from"], SWEEP_FROM);
  assert.equal(rect.props["data-sweep-to"], SWEEP_TO);
});

test("draw：路径的 dasharray 取实测长度，起点是全长（等于还没画）", () => {
  const { nodes } = render("draw");
  const drawn = byTag(nodes, "path").find((p) => "strokeDasharray" in p.props)!;
  assert.ok(drawn, "draw 必须有带 dasharray 的路径");
  assert.equal(drawn.props.strokeDasharray, 1266);
  assert.equal(drawn.props.strokeDashoffset, 1266);
  assert.equal(drawn.props.d, S_PATH);
});

test("length 未知（jsdom / 几何 API 缺失）时不渲染动态层，只剩静态轨道", () => {
  const { nodes } = render("comet", { length: null, showStatic: true });
  const gs = byTag(nodes, "g");
  assert.equal(gs.length, 1, "只有轨道那一组");
  assert.equal(gs[0].props.opacity, 1, "静态时轨道要亮出来");
  assert.equal(byTag(nodes, "circle").some((c) => c.props.r === 70), false);
});

test("reduced-motion：挂呼吸类、不挂位移动画", () => {
  const { nodes } = render("comet", { reducedMotion: true, showStatic: true });
  const svg = byTag(nodes, "svg")[0];
  assert.match(String(svg.props.className), /sc-brand-loader-breathe/);
  assert.equal(/animate|transition/.test(String(svg.props.className)), false);
});
