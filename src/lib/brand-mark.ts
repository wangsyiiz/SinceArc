/**
 * 品牌 S 的唯一几何源：BrandMark 与 BrandLoader 都从这里取路径与变换。
 * 1024 坐标系；颜色不进常量，渲染处一律 currentColor。
 */
export const BRAND_VIEWBOX = "0 0 1024 1024";
export const S_PATH = "M 300 240 C 700 240, 760 430, 512 520 C 264 610, 324 810, 724 810";
export const S_GROUP = "translate(46 46) translate(-197.6 -215.6) scale(1.386)";
export const S_START = { cx: 300, cy: 240, r: 66.4 };
export const S_STROKE = 75;
export const SWEEP_FROM = 150;
export const SWEEP_TO = 962;
export const TRAIL_OFFSETS = [70, 140, 210];

/**
 * BrandLoader 的时间轴（§21.8）：去程 → 停 → 翻转 → 回程 → 翻转，一圈 3.9s。
 * 时序只在这里写一份：组件按它算相位，视图层按它生成翻转的 CSS transition。
 */
export const LOADER_TRAVEL_MS = 1400;
export const LOADER_HOLD_MS = 60;
export const LOADER_FLIP_MS = 520;
export const LOADER_FLIP_EASING = "cubic-bezier(.45,.05,.55,.95)";
