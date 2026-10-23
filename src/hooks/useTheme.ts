import { useEffect } from "react";
import type { ThemeMode } from "@/types";

export function useTheme(theme: ThemeMode): void {
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
}
