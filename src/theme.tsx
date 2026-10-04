import {
  createContext,
  useContext,
  useState,
  useLayoutEffect,
  type ReactNode,
} from "react";
export type Theme = "dark" | "light" | "green";
export const THEMES = [
  { value: "dark", label: "深色" },
  { value: "light", label: "浅色" },
  { value: "green", label: "绿色" },
];
export function loadTheme(): Theme {
  try {
    const value = localStorage.getItem("oil-git.theme");
    if (value === "light" || value === "green" || value === "dark")
      return value;
  } catch {}
  return "dark";
}
export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme =
    theme === "light" ? "light" : "dark";
}
const ThemeContext = createContext<{
  theme: Theme;
  setTheme: (theme: Theme) => void;
}>({ theme: "dark", setTheme() {} });
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setValue] = useState<Theme>(loadTheme);
  useLayoutEffect(() => applyTheme(theme), [theme]);
  const setTheme = (value: Theme) => {
    applyTheme(value);
    try {
      localStorage.setItem("oil-git.theme", value);
    } catch {}
    setValue(value);
  };
  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
export const useTheme = () => useContext(ThemeContext);
