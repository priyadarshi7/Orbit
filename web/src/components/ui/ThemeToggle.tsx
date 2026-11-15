import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { IconButton } from "./Button";

export function ThemeToggle() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme ?? "dark");
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("orbit-theme", theme);
    } catch {
      /* storage unavailable: the theme still applies for this visit */
    }
  }, [theme]);
  const next = theme === "dark" ? "light" : "dark";
  return (
    <IconButton label={`Switch to ${next} theme`} onClick={() => setTheme(next)}>
      {theme === "dark" ? <Icon.sun /> : <Icon.moon />}
    </IconButton>
  );
}
