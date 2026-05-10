import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(extensionRoot, "..");

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

const extensionDistPath = path.resolve(extensionRoot, args.get("extension-dist") ?? "dist");
const videoPath = path.resolve(
  projectRoot,
  args.get("video-path") ?? "实际用的剧集/output/tests/SE04.01.sample-source.mkv"
);
const userDataDir = path.resolve(
  extensionRoot,
  args.get("user-data-dir") ?? ".tmp/playwright-extension-profile-preprocess-smoke"
);
const browserChannel = args.get("browser-channel") ?? "chromium";
const browserExecutablePath = args.get("browser-executable-path") ?? null;
const timeoutMs = Number.parseInt(args.get("timeout-ms") ?? "300000", 10);

function log(message, metadata) {
  if (metadata === undefined) {
    console.log(`[preprocess-smoke-test] ${message}`);
    return;
  }
  console.log(`[preprocess-smoke-test] ${message}`, metadata);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function captureSnapshot(page) {
  return page.evaluate(() => {
    const video = document.querySelector("video");
    const processButton = document.querySelector("#process-play");
    const riskButton = document.querySelector("#risk-play");
    const progressBar = document.querySelector("#processing-progress");
    return {
      readerStatus: document.querySelector("#reader-status-text")?.textContent?.trim() ?? null,
      videoName: document.querySelector("#video-name")?.textContent?.trim() ?? null,
      videoContainer: document.querySelector("#video-container")?.textContent?.trim() ?? null,
      videoCodec: document.querySelector("#video-codec")?.textContent?.trim() ?? null,
      audioCodec: document.querySelector("#audio-codec")?.textContent?.trim() ?? null,
      transcodePlan: document.querySelector("#video-plan")?.textContent?.trim() ?? null,
      processingProgressValue: progressBar instanceof HTMLProgressElement ? progressBar.value : null,
      processingText: document.querySelector("#processing-text")?.textContent?.trim() ?? null,
      processDisabled: processButton instanceof HTMLButtonElement ? processButton.disabled : null,
      riskDisabled: riskButton instanceof HTMLButtonElement ? riskButton.disabled : null,
      playerActive: document.querySelector("#player-view")?.classList.contains("is-active") ?? false,
      playerStatus: document.querySelector("#player-status")?.textContent?.trim() ?? null,
      currentSrc: video instanceof HTMLVideoElement ? video.currentSrc : null,
      readyState: video instanceof HTMLVideoElement ? video.readyState : null,
      duration: video instanceof HTMLVideoElement && Number.isFinite(video.duration) ? video.duration : null
    };
  });
}

async function main() {
  if (!(await fileExists(extensionDistPath))) {
    throw new Error(`Extension dist directory not found: ${extensionDistPath}`);
  }
  if (!(await fileExists(videoPath))) {
    throw new Error(`Video file not found: ${videoPath}`);
  }
  if (browserExecutablePath && !(await fileExists(browserExecutablePath))) {
    throw new Error(`Browser executable not found: ${browserExecutablePath}`);
  }

  await fs.rm(userDataDir, { recursive: true, force: true });
  await fs.mkdir(userDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: browserChannel,
    executablePath: browserExecutablePath ?? undefined,
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions", "--disable-component-extensions-with-background-pages"],
    args: [
      `--load-extension=${extensionDistPath}`
    ]
  });

  try {
    const extensionId = await resolveExtensionId(context, extensionDistPath);
    const playerUrl = `chrome-extension://${extensionId}/player/player.html`;
    const page = await context.newPage();
    page.on("console", (message) => {
      const text = message.text();
      if (text.includes("[reader-sync:")) {
        log(`player console.${message.type()}`, { text });
      }
    });
    page.on("pageerror", (error) => {
      log("player pageerror", { message: error instanceof Error ? error.message : String(error) });
    });

    await page.goto(playerUrl, { waitUntil: "domcontentloaded" });
    log("Player page opened", { playerUrl, videoPath });
    await page.waitForSelector("#video-file", { state: "attached", timeout: 30000 });
    await page.click("#to-video").catch(() => {});
    await page.setInputFiles("#video-file", videoPath);
    await page.waitForFunction(() => {
      const plan = document.querySelector("#video-plan")?.textContent?.trim() ?? "";
      const processButton = document.querySelector("#process-play");
      return plan.includes("AAC") && processButton instanceof HTMLButtonElement && !processButton.disabled;
    }, null, { timeout: 120000 });
    log("Preprocess action became available", await captureSnapshot(page));

    await page.evaluate(() => {
      document.querySelector("#subtitle-view")?.classList.remove("is-active");
      document.querySelector("#video-view")?.classList.add("is-active");
    });
    await page.click("#process-play");
    await page.waitForFunction(() => {
      const progress = document.querySelector("#processing-progress");
      const video = document.querySelector("video");
      return (
        progress instanceof HTMLProgressElement &&
        progress.value === 100 &&
        document.querySelector("#player-view")?.classList.contains("is-active") &&
        video instanceof HTMLVideoElement &&
        video.currentSrc.startsWith("blob:")
      );
    }, null, { timeout: timeoutMs });

    const completedSnapshot = await captureSnapshot(page);
    log("Preprocess completed and processed video loaded", completedSnapshot);
    if (!completedSnapshot.videoName?.includes(".hvc1.aac.mp4")) {
      throw new Error(`Processed video name did not use expected output profile: ${completedSnapshot.videoName}`);
    }
    if (completedSnapshot.processingProgressValue !== 100) {
      throw new Error(`Expected 100% only after completion, got ${completedSnapshot.processingProgressValue}`);
    }
  } finally {
    await context.close();
  }
}

async function resolveExtensionId(context, unpackedExtensionPath) {
  const existingServiceWorker = context.serviceWorkers()[0];
  if (existingServiceWorker) {
    return new URL(existingServiceWorker.url()).host;
  }

  const extensionPage = await context.newPage();
  try {
    await extensionPage.goto("chrome://extensions/", { waitUntil: "domcontentloaded" });
    await extensionPage.waitForFunction(() => customElements.whenDefined("extensions-manager"), null, { timeout: 30000 });
    const extensionId = await extensionPage.evaluate(async (expectedPath) => {
      const manager = document.querySelector("extensions-manager");
      await customElements.whenDefined("extensions-manager");
      const extensions = manager?.shadowRoot?.querySelector("extensions-item-list")?.extensions ?? [];
      const normalizedExpectedPath = expectedPath.replaceAll("\\\\", "/");
      for (const extension of extensions) {
        const normalizedPath = String(extension.path ?? "").replaceAll("\\\\", "/");
        if (normalizedPath === normalizedExpectedPath) {
          return extension.id;
        }
      }
      return null;
    }, unpackedExtensionPath);
    if (extensionId) {
      return extensionId;
    }
    const snapshot = await extensionPage.evaluate(() => document.body.innerText.slice(0, 2000));
    throw new Error(`Unable to resolve loaded extension id from chrome://extensions. Snapshot: ${snapshot}`);
  } finally {
    await extensionPage.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
