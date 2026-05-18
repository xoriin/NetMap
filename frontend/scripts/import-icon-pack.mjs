import fs from "node:fs/promises";
import path from "node:path";

function slugify(input) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
}

function titleCase(input) {
  return input
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function extractIconMarkup(svgText) {
  const matches = svgText.match(/<(path|circle|rect|line|polyline|polygon|ellipse)\b[^>]*\/?>/gi) || [];
  return matches.join("");
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(file) {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function main() {
  const [, , packIdArg, sourceDirArg, packNameArg] = process.argv;
  if (!packIdArg || !sourceDirArg) {
    console.error("Usage: npm run import-icon-pack -- <pack-id> <source-svg-dir> [Pack Name]");
    process.exit(1);
  }

  const cwd = process.cwd();
  const packId = slugify(packIdArg);
  const sourceDir = path.resolve(cwd, sourceDirArg);
  const packName = (packNameArg || titleCase(packIdArg)).trim();
  const outputDir = path.resolve(cwd, "public", "icon-packs");
  const outputFile = path.resolve(outputDir, `${packId}.json`);
  const indexFile = path.resolve(outputDir, "index.json");

  await ensureDir(outputDir);
  const files = await fs.readdir(sourceDir, { withFileTypes: true });
  const svgs = files.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".svg"));
  if (svgs.length === 0) {
    console.error(`No SVG files found in ${sourceDir}`);
    process.exit(1);
  }

  const icons = [];
  for (const entry of svgs) {
    const filePath = path.join(sourceDir, entry.name);
    const raw = await fs.readFile(filePath, "utf8");
    const markup = extractIconMarkup(raw);
    if (!markup) continue;
    const base = entry.name.replace(/\.svg$/i, "");
    const value = slugify(base);
    icons.push({
      value: value || "unknown",
      label: titleCase(base),
      path: markup,
    });
  }

  if (icons.length === 0) {
    console.error("No supported SVG shapes found. Expected path/circle/rect/line/polyline/polygon/ellipse.");
    process.exit(1);
  }

  await fs.writeFile(outputFile, `${JSON.stringify({ icons }, null, 2)}\n`, "utf8");

  const existingIndex = (await readJson(indexFile)) || { packs: [] };
  const packs = Array.isArray(existingIndex.packs) ? existingIndex.packs : [];
  const nextEntry = { id: packId, name: packName, file: `${packId}.json` };
  const filtered = packs.filter((pack) => String(pack?.id || "") !== packId);
  filtered.push(nextEntry);
  filtered.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  await fs.writeFile(indexFile, `${JSON.stringify({ packs: filtered }, null, 2)}\n`, "utf8");

  console.log(`Imported ${icons.length} icons to public/icon-packs/${packId}.json`);
  console.log(`Registered pack "${packName}" in public/icon-packs/index.json`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
