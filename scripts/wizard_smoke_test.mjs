import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, "..");

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const current = process.argv[index];
  if (!current.startsWith("--")) {
    continue;
  }
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) {
    args.set(current.slice(2), "1");
    continue;
  }
  args.set(current.slice(2), next);
  index += 1;
}

const targetUrl = args.get("target-url") ?? "https://aim-read.top/daily-feed/319?categoryId=60";
const extensionDistPath = path.resolve(extensionRoot, args.get("extension-dist") ?? "dist");
const authStatePath = path.resolve(extensionRoot, args.get("auth-state-path") ?? ".tmp/aim-read-auth-state.json");
const userDataDir = path.resolve(extensionRoot, args.get("user-data-dir") ?? ".tmp/aim-read-auth-profile");
const browserChannel = args.get("browser-channel") ?? "chromium";
const browserExecutablePath = args.get("browser-executable-path") ?? null;
const proxyServer = args.get("proxy-server") ?? null;
const timeoutMs = Number.parseInt(args.get("timeout-ms") ?? "180000", 10);

function log(message, metadata) {
  if (metadata === undefined) {
    console.log(`[wizard-smoke-test] ${message}`);
    return;
  }
  console.log(`[wizard-smoke-test] ${message}`, metadata);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (!(await fileExists(extensionDistPath))) {
    throw new Error(`Extension dist directory not found: ${extensionDistPath}`);
  }
  if (!(await fileExists(authStatePath))) {
    throw new Error(`Auth state not found: ${authStatePath}. Run pnpm run auth:refresh first.`);
  }
  if (browserExecutablePath && !(await fileExists(browserExecutablePath))) {
    throw new Error(`Browser executable not found: ${browserExecutablePath}`);
  }

  await fs.mkdir(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: browserChannel,
    executablePath: browserExecutablePath ?? undefined,
    headless: false,
    storageState: authStatePath,
    args: [
      `--disable-extensions-except=${extensionDistPath}`,
      `--load-extension=${extensionDistPath}`,
      ...(proxyServer ? [`--proxy-server=${proxyServer}`] : [])
    ]
  });

  try {
    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker", { timeout: timeoutMs });
    }
    const extensionId = new URL(serviceWorker.url()).host;
    log("Extension loaded", { extensionId });

    const readerPage = await context.newPage();
    await readerPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    if (readerPage.url().includes("/login")) {
      throw new Error(`Saved auth state is expired. Run pnpm run auth:refresh and retry. Current URL: ${readerPage.url()}`);
    }
    await readerPage.waitForSelector("#reader-sync-status-overlay", { timeout: timeoutMs });
    log("Reader overlay loaded", {
      url: readerPage.url(),
      title: await readerPage.title()
    });

    const playerPage = await context.newPage();
    const playerUrl = `chrome-extension://${extensionId}/player/player.html`;
    await playerPage.goto(playerUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await playerPage.waitForFunction(() => {
      const readerStatus = document.querySelector("#reader-status-text")?.textContent ?? "";
      const localStatus = document.querySelector("#local-subtitle-state")?.textContent ?? "";
      return readerStatus.includes("已检测到 reader 页面") && localStatus.includes("S04E01");
    }, null, { timeout: timeoutMs });

    await playerPage.waitForFunction(() => {
      const nextButton = document.querySelector("#to-video");
      return nextButton instanceof HTMLButtonElement && !nextButton.disabled;
    }, null, { timeout: timeoutMs });

    const subtitleSnapshot = await playerPage.evaluate(() => ({
      readerStatus: document.querySelector("#reader-status-text")?.textContent?.trim() ?? null,
      readerContext: document.querySelector("#reader-context-value")?.textContent?.trim() ?? null,
      localSubtitleState: document.querySelector("#local-subtitle-state")?.textContent?.trim() ?? null,
      resultTitle: document.querySelector("#subtitle-result-title")?.textContent?.trim() ?? null,
      resultDetail: document.querySelector("#subtitle-result-detail")?.textContent?.trim() ?? null,
      nextDisabled: document.querySelector("#to-video") instanceof HTMLButtonElement
        ? document.querySelector("#to-video").disabled
        : null
    }));
    log("Wizard subtitle step is ready", subtitleSnapshot);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const themeMode = await playerPage.evaluate(() => document.documentElement.dataset.themeMode ?? null);
      if (themeMode === "light") {
        break;
      }
      await playerPage.click("#theme-toggle");
      await playerPage.waitForTimeout(300);
    }
    await playerPage.waitForFunction(() => document.documentElement.dataset.themeMode === "light", null, { timeout: 10000 });
    await readerPage.waitForFunction(() => {
      const overlay = document.querySelector("#reader-sync-status-overlay");
      return overlay instanceof HTMLElement && overlay.dataset.themeMode === "light" && overlay.dataset.theme === "light";
    }, null, { timeout: 10000 });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const themeMode = await playerPage.evaluate(() => document.documentElement.dataset.themeMode ?? null);
      if (themeMode === "dark") {
        break;
      }
      await playerPage.click("#theme-toggle");
      await playerPage.waitForTimeout(300);
    }
    await playerPage.waitForFunction(() => document.documentElement.dataset.themeMode === "dark", null, { timeout: 10000 });
    await readerPage.waitForFunction(() => {
      const overlay = document.querySelector("#reader-sync-status-overlay");
      return overlay instanceof HTMLElement && overlay.dataset.themeMode === "dark" && overlay.dataset.theme === "dark";
    }, null, { timeout: 10000 });

    const themeSnapshot = await Promise.all([
      playerPage.evaluate(async () => {
        const stored = await chrome.storage.local.get("reader-sync-player-theme");
        return {
          playerThemeMode: document.documentElement.dataset.themeMode ?? null,
          playerTheme: document.documentElement.dataset.theme ?? null,
          storageThemeMode: stored["reader-sync-player-theme"] ?? null
        };
      }),
      readerPage.evaluate(() => {
        const overlay = document.querySelector("#reader-sync-status-overlay");
        return {
          overlayThemeMode: overlay instanceof HTMLElement ? overlay.dataset.themeMode ?? null : null,
          overlayTheme: overlay instanceof HTMLElement ? overlay.dataset.theme ?? null : null
        };
      })
    ]);
    log("Theme sync is active", {
      ...themeSnapshot[0],
      ...themeSnapshot[1]
    });
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error("[wizard-smoke-test] failed", error);
  process.exitCode = 1;
});
