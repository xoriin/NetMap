import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const sourceDir = resolve("node_modules/swagger-ui-dist");
const targetDir = resolve(process.argv[2] ?? "dist/swagger-ui");
const assets = [
  "swagger-ui.css",
  "swagger-ui-bundle.js",
  "swagger-ui-standalone-preset.js",
];

await mkdir(targetDir, { recursive: true });
await Promise.all(
  assets.map((asset) => copyFile(resolve(sourceDir, asset), resolve(targetDir, asset))),
);
