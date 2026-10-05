import "./prepare-icons.mjs";
import fs from "node:fs";
const palettes = JSON.parse(
  fs.readFileSync("scripts/theme-palettes.json", "utf8"),
);
let css =
  "/* Generated from scripts/theme-palettes.json; edit colors there. */\n";
for (const [theme, values] of Object.entries(palettes)) {
  const selector =
    theme === "dark"
      ? ':root, :root[data-theme="dark"]'
      : ':root[data-theme="' + theme + '"]';
  css +=
    selector +
    " {\n" +
    Object.entries(values)
      .map(([key, value]) => "  --" + key + ": " + value + ";")
      .join("\n") +
    "\n  color-scheme: " +
    (theme === "light" ? "light" : "dark") +
    ";\n}\n";
}
fs.writeFileSync("src/themes.css", css);
