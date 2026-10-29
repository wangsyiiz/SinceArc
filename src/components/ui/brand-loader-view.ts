/**
 * BrandLoader 的纯视图层：不依赖 DOM 几何，便于在 node --test 下做结构断言。
 * 时间轴与 rAF 留在 BrandLoader.tsx。
 *
 * 这里的 import 用相对路径而不是 `@/`：`npm test` 是 `node --test`（只剥类型、不认 tsconfig
 * 的 paths），值导入走别名会在加载期抛 ERR_MODULE_NOT_FOUND，整份测试文件直接失效。
 */
import { createElement as h, Fragment } from "react";
import type { ReactElement, Ref } from "react";
import {
  BRAND_VIEWBOX,
  LOADER_FLIP_EASING,
  LOADER_FLIP_MS,
  S_GROUP,
  S_PATH,
  S_START,
  S_STROKE,
  SWEEP_FROM,
  SWEEP_TO,
  TRAIL_OFFSETS,
} from "../../lib/brand-mark.ts";

export type BrandLoaderVariant = "comet" | "fill" | "draw";

export const TRAIL_RADII = [58, 52, 46];
export const TRAIL_OPACITY = [0.5, 0.28, 0.16];

export interface BrandLoaderRootProps {
  variant: BrandLoaderVariant;
  size: 14 | 16 | 20;
  label?: string;
}

export function brandLoaderRootProps({
  variant,
  size,
  label,
}: BrandLoaderRootProps): {
  "data-brand-loader": string;
  "data-variant": BrandLoaderVariant;
  role: "img" | undefined;
  "aria-label": string | undefined;
  "aria-hidden": true | undefined;
  style: { width: number; height: number };
} {
  return {
    "data-brand-loader": "",
    "data-variant": variant,
    role: label ? "img" : undefined,
    "aria-label": label,
    "aria-hidden": label ? undefined : true,
    style: { width: size, height: size },
  };
}

export interface BrandLoaderViewProps {
  variant: BrandLoaderVariant;
  size: 14 | 16 | 20;
  label?: string;
  className?: string;
  maskId: string;
  length: number | null;
  showStatic: boolean;
  reducedMotion: boolean;
  innerRef?: Ref<HTMLSpanElement>;
  refs?: BrandLoaderArtRefs;
}

export function BrandLoaderView({
  variant,
  size,
  label,
  className,
  maskId,
  length,
  showStatic,
  reducedMotion,
  innerRef,
  refs = {},
}: BrandLoaderViewProps): ReactElement {
  return h(
    "span",
    {
      ...brandLoaderRootProps({ variant, size, label }),
      className,
    },
    h(
      "span",
      {
        ref: innerRef,
        className: "inline-flex size-full",
        style: {
          transform: "scaleY(1)",
          transformOrigin: "center",
          transition: `transform ${LOADER_FLIP_MS}ms ${LOADER_FLIP_EASING}`,
        },
      },
      h(
        "svg",
        {
          viewBox: BRAND_VIEWBOX,
          "aria-hidden": "true",
          focusable: "false",
          className: reducedMotion
            ? "block size-full sc-brand-loader-breathe"
            : "block size-full",
          style: { display: "block", width: "100%", height: "100%" },
        },
        brandLoaderArt({ variant, maskId, length, showStatic, refs }),
      ),
    ),
  );
}

export interface BrandLoaderArtRefs {
  pathRef?: Ref<SVGPathElement>;
  headRef?: Ref<SVGCircleElement>;
  fillRectRef?: Ref<SVGRectElement>;
  trailRef?: (index: number, node: SVGCircleElement | null) => void;
}

export function brandLoaderArt({
  variant,
  maskId,
  length,
  showStatic,
  refs = {},
}: {
  variant: BrandLoaderVariant;
  maskId: string;
  length: number | null;
  showStatic: boolean;
  refs?: BrandLoaderArtRefs;
}): ReactElement {
  const animate = length !== null && !showStatic;

  if (variant === "comet") {
    return h(
      Fragment,
      null,
      h(
        "g",
        { transform: S_GROUP, opacity: showStatic ? 1 : 0.16 },
        h("path", {
          ref: refs.pathRef,
          d: S_PATH,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: S_STROKE,
          strokeLinecap: "round",
        }),
        h("circle", {
          cx: S_START.cx,
          cy: S_START.cy,
          r: S_START.r,
          fill: "currentColor",
        }),
      ),
      animate
        ? h(
            "g",
            { transform: S_GROUP },
            ...TRAIL_OFFSETS.map((offset, index) =>
              h("circle", {
                key: offset,
                ref: refs.trailRef
                  ? (node: SVGCircleElement | null) => refs.trailRef?.(index, node)
                  : undefined,
                cx: S_START.cx,
                cy: S_START.cy,
                r: TRAIL_RADII[index],
                fill: "currentColor",
                opacity: TRAIL_OPACITY[index],
              }),
            ),
            h("circle", {
              ref: refs.headRef,
              cx: S_START.cx,
              cy: S_START.cy,
              r: 70,
              fill: "currentColor",
              opacity: 1,
            }),
          )
        : null,
    );
  }

  if (variant === "fill") {
    return h(
      Fragment,
      null,
      h(
        "defs",
        null,
        h(
          "mask",
          {
            id: maskId,
            maskUnits: "userSpaceOnUse",
            x: 0,
            y: 0,
            width: 1024,
            height: 1024,
          },
          h(
            "g",
            { transform: S_GROUP },
            h("path", {
              ref: refs.pathRef,
              d: S_PATH,
              stroke: "white",
              strokeWidth: S_STROKE,
              fill: "none",
              strokeLinecap: "round",
            }),
            h("circle", {
              cx: S_START.cx,
              cy: S_START.cy,
              r: S_START.r,
              fill: "white",
            }),
          ),
        ),
      ),
      animate
        ? h(
            "g",
            { mask: `url(#${maskId})` },
            h("rect", {
              ref: refs.fillRectRef,
              x: -900,
              y: -200,
              width: 900,
              height: 1424,
              fill: "currentColor",
              transform: `translate(${SWEEP_FROM} 0)`,
              "data-sweep-from": SWEEP_FROM,
              "data-sweep-to": SWEEP_TO,
            }),
          )
        : null,
      showStatic
        ? h(
            "g",
            { transform: S_GROUP },
            h("path", {
              d: S_PATH,
              fill: "none",
              stroke: "currentColor",
              strokeWidth: S_STROKE,
              strokeLinecap: "round",
            }),
            h("circle", {
              cx: S_START.cx,
              cy: S_START.cy,
              r: S_START.r,
              fill: "currentColor",
            }),
          )
        : null,
    );
  }

  return h(
    Fragment,
    null,
    h(
      "g",
      { transform: S_GROUP, opacity: showStatic ? 1 : 0.16 },
      h("path", {
        d: S_PATH,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: S_STROKE,
        strokeLinecap: "round",
      }),
      h("circle", {
        cx: S_START.cx,
        cy: S_START.cy,
        r: S_START.r,
        fill: "currentColor",
      }),
    ),
    h(
      "g",
      { transform: S_GROUP, opacity: animate ? 1 : 0 },
      h("path", {
        ref: refs.pathRef,
        d: S_PATH,
        fill: "none",
        stroke: "currentColor",
        strokeWidth: S_STROKE,
        strokeLinecap: "round",
        strokeDasharray: length ?? 0,
        strokeDashoffset: length ?? 0,
      }),
    ),
  );
}
