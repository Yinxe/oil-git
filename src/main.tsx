import { createRoot } from "react-dom/client";
import App from "./App";
import { ThemeProvider, applyTheme, loadTheme } from "./theme";
import "./themes.css";
import "./styles.css";
applyTheme(loadTheme());
createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <App />
  </ThemeProvider>,
);
