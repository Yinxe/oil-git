import manifest from "./generated/file-icons.json";
import { useTheme, type Theme } from "./theme";
type Mappings = Record<string, string>;
export function fileIconPath(path: string, theme: Theme) {
  const name = path.replace(/\\/g, "/").split("/").pop()!.toLowerCase();
  const names = manifest.names as Mappings,
    extensions = manifest.extensions as Mappings;
  const lightNames = manifest.lightNames as Mappings,
    lightExtensions = manifest.lightExtensions as Mappings;
  let id = (theme === "light" ? lightNames[name] : undefined) || names[name];
  if (!id) {
    const parts = name.split(".");
    for (let i = 1; i < parts.length; i++) {
      const extension = parts.slice(i).join(".");
      id =
        (theme === "light" ? lightExtensions[extension] : undefined) ||
        extensions[extension];
      if (id) break;
    }
  }
  return (manifest.paths as Mappings)[id || manifest.default];
}
export function FileIcon({ path, size = 16 }: { path: string; size?: number }) {
  const { theme } = useTheme();
  return (
    <img
      className="file-icon"
      src={fileIconPath(path, theme)}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
