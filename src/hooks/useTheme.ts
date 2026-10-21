import { useEffect, useState } from "react";
import type { ThemeMode } from "@/types";

export function useTheme(): { theme: ThemeMode; setTheme: (theme: ThemeMode) => void } {
  const [theme, setTheme] = useState<ThemeMode>("dark");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  return { theme, setTheme };
}
