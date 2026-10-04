import fs from "node:fs";
import path from "node:path";
import { generateManifest } from "material-icon-theme";
const pkg = path.resolve("node_modules/material-icon-theme");
const manifest = generateManifest();
const mappings = {
  names: manifest.fileNames,
  extensions: manifest.fileExtensions,
  lightNames: manifest.light?.fileNames ?? {},
  lightExtensions: manifest.light?.fileExtensions ?? {},
  default: manifest.file,
  paths: {},
};
const ids = new Set([
  manifest.file,
  ...Object.values(mappings.names),
  ...Object.values(mappings.extensions),
  ...Object.values(mappings.lightNames),
  ...Object.values(mappings.lightExtensions),
]);
fs.mkdirSync("src/generated", { recursive: true });
fs.mkdirSync("public/file-icons", { recursive: true });
for (const id of ids) {
  const definition = manifest.iconDefinitions[id];
  if (!definition) throw Error("Unknown icon " + id);
  const name = path.basename(definition.iconPath);
  const source = path.join(pkg, "icons", name);
  if (!fs.existsSync(source)) throw Error("Missing icon " + name);
  fs.copyFileSync(source, path.join("public/file-icons", name));
  mappings.paths[id] = "/file-icons/" + name;
}
fs.writeFileSync("src/generated/file-icons.json", JSON.stringify(mappings));
fs.copyFileSync(path.join(pkg, "LICENSE"), "public/file-icons/LICENSE.txt");
console.log("已准备 " + ids.size + " 种文件图标");
