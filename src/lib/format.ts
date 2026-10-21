import type { Activity } from "@/types";

export const now = () => new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
export const isWrite = (a: Activity) => a.kind === "edit" || a.kind === "execute";
