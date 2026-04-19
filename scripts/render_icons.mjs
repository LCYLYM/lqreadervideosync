import { chromium } from "playwright-core";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readdirSync } from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const iconDir = path.join(rootDir, "public", "icons");
const svgPath = path.join(iconDir, "icon.svg");

const SIZES = [16, 32, 48, 128];

function findChromium() {
  const playwrightBase = path.join(
    process.env.HOME || "",
    "Library",
    "Caches",
    "ms-playwright"
  );
  if (!existsSync(playwrightBase)) return null;
  const entries = readdirSync(playwrightBase).filter((name) =>
    name.startsWith("chromium-")
  );
  if (entries.length === 0) return null;
  entries.sort();
  for (const entry of [...entries].reverse()) {
    const candidates = [
      // newer "Chrome for Testing" layout (arm64 / x64)
      path.join(
        playwrightBase,
        entry,
        "chrome-mac-arm64",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing"
      ),
      path.join(
        playwrightBase,
        entry,
        "chrome-mac",
        "Google Chrome for Testing.app",
        "Contents",
        "MacOS",
        "Google Chrome for Testing"
      ),
      // older Chromium.app layout
      path.join(
        playwrightBase,
        entry,
        "chrome-mac",
        "Chromium.app",
        "Contents",
        "MacOS",
        "Chromium"
      ),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
  }
  return null;
}

async function main() {
  const svg = await readFile(svgPath, "utf8");
  const executablePath = findChromium();
  if (!executablePath) {
    throw new Error(
      "Unable to locate a Playwright Chromium binary. Run `pnpm exec playwright install chromium` first."
    );
  }

  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    for (const size of SIZES) {
      const html = `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: transparent; }
  svg { display: block; width: ${size}px; height: ${size}px; }
</style></head>
<body>${svg}</body></html>`;

      const context = await browser.newContext({
        viewport: { width: size, height: size },
        deviceScaleFactor: 1,
      });
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: "load" });
      const buffer = await page.screenshot({
        omitBackground: true,
        clip: { x: 0, y: 0, width: size, height: size },
        type: "png",
      });
      const outPath = path.join(iconDir, `icon-${size}.png`);
      await writeFile(outPath, buffer);
      console.log(`wrote ${outPath} (${buffer.length} bytes)`);
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

await mkdir(iconDir, { recursive: true });
await main();
