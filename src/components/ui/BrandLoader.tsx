/**
 * 品牌 S 的 loading 指示器（docs/desktop-ux.md §21.8）。
 *
 * 这是 loading，不是进度条：没有百分比、不回调完成、不因为“走满”改变任何状态。
 * 三档 variant 共用同一套往复时序，只换进度长什么样。
 */
import { useEffect, useId, useRef, useState } from "react";
import {
  LOADER_FLIP_MS,
  LOADER_HOLD_MS,
  LOADER_TRAVEL_MS,
  SWEEP_FROM,
  SWEEP_TO,
  TRAIL_OFFSETS,
} from "@/lib/brand-mark";
import { cn } from "@/lib/utils";
import {
  BrandLoaderView,
  type BrandLoaderVariant,
} from "./brand-loader-view";

export type { BrandLoaderVariant } from "./brand-loader-view";

const TRAVEL = LOADER_TRAVEL_MS;
const HOLD = LOADER_HOLD_MS;
const FLIP = LOADER_FLIP_MS;
const STEP = TRAVEL + HOLD + FLIP;
const CYCLE = TRAVEL + HOLD + FLIP + TRAVEL + FLIP;

const ease = (k: number) => k * k * (3 - 2 * k);
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

function measurePath(path: SVGPathElement | null): number | null {
  if (!path) return null;
  try {
    if (
      typeof path.getTotalLength !== "function" ||
      typeof path.getPointAtLength !== "function"
    ) {
      return null;
    }
    const length = path.getTotalLength();
    if (!Number.isFinite(length) || length <= 0) return null;
    path.getPointAtLength(0);
    return length;
  } catch {
    return null;
  }
}

export function BrandLoader({
  variant = "comet",
  size = 16,
  label,
  className,
}: {
  variant?: BrandLoaderVariant;
  size?: 14 | 16 | 20;
  label?: string;
  className?: string;
}) {
  const maskId = `sc-brand-loader-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [length, setLength] = useState<number | null>(null);
  const [staticMode, setStaticMode] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false,
  );
  const innerRef = useRef<HTMLSpanElement | null>(null);
  const pathRef = useRef<SVGPathElement | null>(null);
  const headRef = useRef<SVGCircleElement | null>(null);
  const trailRefs = useRef<Array<SVGCircleElement | null>>([]);
  const fillRectRef = useRef<SVGRectElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let frame: number | null = null;
    let media: MediaQueryList | null = null;

    const stopFrame = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
    };

    const resetFlip = () => {
      if (innerRef.current) innerRef.current.style.transform = "scaleY(1)";
    };

    const goStatic = () => {
      stopFrame();
      if (cancelled) return;
      setLength(null);
      setStaticMode(true);
      resetFlip();
    };

    const start = (pathLength: number) => {
      if (typeof requestAnimationFrame !== "function") {
        goStatic();
        return;
      }
      const path = pathRef.current;
      if (!path) {
        goStatic();
        return;
      }

      let startedAt: number | null = null;
      const tick = (now: number) => {
        if (cancelled) return;
        if (startedAt === null) startedAt = now;

        const phase = (now - startedAt) % CYCLE;
        let distance: number;
        let direction: 1 | -1;
        let flip: 1 | -1;

        if (phase < TRAVEL) {
          distance = ease(phase / TRAVEL) * pathLength;
          direction = 1;
          flip = 1;
        } else if (phase < TRAVEL + HOLD) {
          distance = pathLength;
          direction = 1;
          flip = 1;
        } else if (phase < STEP) {
          distance = pathLength;
          direction = -1;
          flip = -1;
        } else if (phase < STEP + TRAVEL) {
          distance = (1 - ease((phase - STEP) / TRAVEL)) * pathLength;
          direction = -1;
          flip = -1;
        } else {
          distance = 0;
          direction = 1;
          flip = 1;
        }

        if (innerRef.current) {
          innerRef.current.style.transform = `scaleY(${flip})`;
        }

        try {
          if (variant === "comet") {
            const head = path.getPointAtLength(clamp(distance, 0, pathLength));
            if (headRef.current) {
              headRef.current.setAttribute("cx", String(head.x));
              headRef.current.setAttribute("cy", String(head.y));
            }
            TRAIL_OFFSETS.forEach((offset, index) => {
              const trail = path.getPointAtLength(
                clamp(distance - direction * offset, 0, pathLength),
              );
              const node = trailRefs.current[index];
              if (node) {
                node.setAttribute("cx", String(trail.x));
                node.setAttribute("cy", String(trail.y));
              }
            });
          } else if (variant === "fill" && fillRectRef.current) {
            const x =
              SWEEP_FROM + (distance / pathLength) * (SWEEP_TO - SWEEP_FROM);
            fillRectRef.current.setAttribute("transform", `translate(${x} 0)`);
          } else if (variant === "draw" && pathRef.current) {
            pathRef.current.style.strokeDashoffset = String(pathLength - distance);
          }
        } catch {
          goStatic();
          return;
        }

        frame = requestAnimationFrame(tick);
      };

      frame = requestAnimationFrame(tick);
    };

    const sync = () => {
      stopFrame();
      if (cancelled) return;

      const reduced = media ? media.matches : false;
      setReducedMotion(reduced);
      resetFlip();

      if (reduced) {
        setLength(null);
        setStaticMode(false);
        return;
      }

      const pathLength = measurePath(pathRef.current);
      if (pathLength === null) {
        goStatic();
        return;
      }

      setStaticMode(false);
      setLength(pathLength);
      start(pathLength);
    };

    const onChange = () => sync();

    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      media = window.matchMedia("(prefers-reduced-motion: reduce)");
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", onChange);
      } else {
        media.addListener(onChange);
      }
    }

    sync();

    return () => {
      cancelled = true;
      stopFrame();
      if (media) {
        if (typeof media.removeEventListener === "function") {
          media.removeEventListener("change", onChange);
        } else {
          media.removeListener(onChange);
        }
      }
    };
  }, [variant]);

  const showStatic = staticMode || reducedMotion;

  return (
    <BrandLoaderView
      variant={variant}
      size={size}
      label={label}
      className={cn("inline-flex shrink-0", className)}
      maskId={maskId}
      length={length}
      showStatic={showStatic}
      reducedMotion={reducedMotion}
      innerRef={innerRef}
      refs={{
        pathRef,
        headRef,
        fillRectRef,
        trailRef: (index, node) => {
          trailRefs.current[index] = node;
        },
      }}
    />
  );
}
