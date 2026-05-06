import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
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

const targetUrl = args.get("target-url") ?? "https://aim-read.top/daily-feed/185?categoryId=59";
const manifestPath = path.resolve(
  projectRoot,
  args.get("manifest-path") ?? "预处理程序/output/friends_s01e01.synced.json"
);
const subtitlePath = args.get("subtitle-path")
  ? path.resolve(projectRoot, args.get("subtitle-path"))
  : null;
const videoPath = path.resolve(
  projectRoot,
  args.get("video-path") ?? "Friends.S01E01.1994.1080p.Blu-ray.x265.AC3￡cXcY@FRDS.mkv"
);
const extensionDistPath = path.resolve(extensionRoot, args.get("extension-dist") ?? "dist");
const userDataDir = path.resolve(
  extensionRoot,
  args.get("user-data-dir") ?? ".tmp/playwright-extension-profile"
);
const authStatePath = path.resolve(
  extensionRoot,
  args.get("auth-state-path") ?? ".tmp/aim-read-auth-state.json"
);
const browserChannel = args.get("browser-channel") ?? "chromium";
const browserExecutablePath = args.get("browser-executable-path") ?? null;
const proxyServer = args.get("proxy-server") ?? null;
const manifestRouteName = args.get("manifest-route") ?? path.basename(manifestPath);
const smokeSeekSeconds = Number.parseInt(args.get("smoke-seek-seconds") ?? "54", 10);
const reverseClickParagraph = Number.parseInt(args.get("reverse-click-paragraph") ?? "23", 10);
const keyboardSeekSeconds = Number.parseInt(args.get("keyboard-seek-seconds") ?? "5", 10);
const keepOpen = args.get("keep-open") === "1";
const readerReadyTimeoutMs = Number.parseInt(args.get("reader-ready-timeout-ms") ?? "300000", 10);
const useRuntimeSubtitleMode = subtitlePath !== null;
const manifestJson = useRuntimeSubtitleMode ? null : JSON.parse(await fs.readFile(manifestPath, "utf-8"));

function log(message, metadata) {
  if (metadata === undefined) {
    console.log(`[extension-smoke-test] ${message}`);
    return;
  }
  console.log(`[extension-smoke-test] ${message}`, metadata);
}

function isArticleApiUrl(url) {
  return url.includes("/api/articles/") && url.includes("/content/page");
}

function attachPageDebugListeners(page, label, options = {}) {
  const logAllConsole = options.logAllConsole === true;

  page.on("console", (message) => {
    const text = message.text();
    if (!logAllConsole && !text.includes("[reader-sync:")) {
      return;
    }
    log(`${label} console.${message.type()}`, { text });
  });

  page.on("pageerror", (error) => {
    log(`${label} pageerror`, {
      message: error instanceof Error ? error.message : String(error)
    });
  });

  page.on("requestfailed", (request) => {
    if (!isArticleApiUrl(request.url())) {
      return;
    }
    log(`${label} article api request failed`, {
      url: request.url(),
      method: request.method(),
      failureText: request.failure()?.errorText ?? null
    });
  });

  page.on("response", (response) => {
    if (!isArticleApiUrl(response.url())) {
      return;
    }
    log(`${label} article api response`, {
      url: response.url(),
      status: response.status(),
      contentType: response.headers()["content-type"] ?? null
    });
  });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function startManifestServer() {
  const manifestRaw = await fs.readFile(manifestPath);
  const manifestBaseName = path.basename(manifestPath);
  const manifestSlug = manifestJson.source?.slug ?? manifestBaseName.replace(/\.json$/i, "");
  const decoySlug = `${manifestSlug}_archive`;
  const indexPayload = JSON.stringify({
    data: {
      records: {
        [decoySlug]: {
          manifest: {
            slug: decoySlug,
            title: `${manifestJson.source?.title ?? manifestSlug} Archive`,
            articleId: 999999,
            categoryId: manifestJson.source?.categoryId ?? null
          },
          file: {
            path: `${decoySlug}.json`
          },
          tags: ["archive", "backup"],
          description: "decoy entry for candidate ranking"
        },
        [manifestSlug]: {
          manifest: {
            slug: manifestSlug,
            title: manifestJson.source?.title ?? manifestSlug,
            articleId: manifestJson.source?.articleId ?? null,
            categoryId: manifestJson.source?.categoryId ?? null
          },
          file: {
            path: manifestBaseName
          },
          aliases: ["friends", manifestSlug],
          tags: ["canonical", "smoke"],
          description: "canonical sync manifest for smoke verification"
        }
      }
    }
  });
  const server = http.createServer((request, response) => {
    if (!request.url) {
      response.writeHead(400).end("Missing URL");
      return;
    }
    const requestUrl = new URL(request.url, "http://127.0.0.1");
    if (requestUrl.pathname === `/${manifestRouteName}`) {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(manifestRaw);
      return;
    }
    if (requestUrl.pathname === "/index.json") {
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
      });
      response.end(indexPayload);
      return;
    }
    response.writeHead(404).end("Not Found");
  });

  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind local manifest server.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}/`;
  return {
    server,
    baseUrl,
    manifestUrl: `${baseUrl}${manifestRouteName}`,
    indexUrl: `${baseUrl}index.json`,
    manifestSlug
  };
}

async function saveAuthState(context) {
  await fs.mkdir(path.dirname(authStatePath), { recursive: true });
  await context.storageState({ path: authStatePath });
  log("Saved auth state for reuse", { authStatePath });
}

async function pressReaderKeyUntilPlayerStateChanges(readerPage, playerPage, key, predicate, predicateArg, timeoutMs = 5000) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await readerPage.bringToFront();
      await readerPage.evaluate(() => {
        document.body.tabIndex = -1;
        document.body.focus();
        window.focus();
      });
      await readerPage.keyboard.press(key);
      await playerPage.waitForFunction(predicate, predicateArg, { timeout: timeoutMs });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error(`Failed to observe player state change after pressing ${key}.`);
}

async function resolveActiveReaderPage(context, targetUrl) {
  const readerPages = context.pages().filter((candidate) => candidate.url().startsWith(targetUrl));
  return readerPages[readerPages.length - 1] ?? null;
}

async function captureReaderReadinessSnapshot(readerPage) {
  return readerPage.evaluate(() => {
    const paragraphTriggers = Array.from(document.querySelectorAll("[data-paragraph-trigger]"));
    const articleRoot = document.querySelector("main article, article");
    const firstParagraphTrigger = paragraphTriggers[0];
    return {
      readyState: document.readyState,
      title: document.title,
      url: window.location.href,
      articleRootPresent: Boolean(articleRoot),
      overlayPresent: Boolean(document.querySelector("#reader-sync-status-overlay")),
      paragraphTriggerCount: paragraphTriggers.length,
      hasParagraphTwo: Boolean(document.querySelector('[data-paragraph-trigger="2"]')),
      firstParagraphTrigger:
        firstParagraphTrigger?.getAttribute("data-paragraph-trigger") ??
        firstParagraphTrigger?.textContent?.replace(/\s+/g, " ").trim() ??
        null
    };
  });
}

function isExecutionContextResetError(error) {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.message.includes("Execution context was destroyed") ||
    error.message.includes("Cannot find context with specified id") ||
    error.message.includes("Target closed")
  );
}

async function waitForReaderPageReady(readerPage, timeoutMs) {
  const startedAt = Date.now();
  let lastSnapshot = {
    readyState: "unknown",
    title: "",
    url: readerPage.url(),
    articleRootPresent: false,
    overlayPresent: false,
    paragraphTriggerCount: 0,
    hasParagraphTwo: false,
    firstParagraphTrigger: null
  };
  let lastLoggedAt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      lastSnapshot = await captureReaderReadinessSnapshot(readerPage);
    } catch (error) {
      if (!isExecutionContextResetError(error)) {
        throw error;
      }
      await readerPage.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
      continue;
    }
    if (lastSnapshot.paragraphTriggerCount > 0) {
      if (!lastSnapshot.overlayPresent) {
        log("Reader paragraph triggers are ready, but overlay is still pending.", lastSnapshot);
      }
      await readerPage.evaluate(() => {
        window.scrollTo({ top: 0, behavior: "auto" });
      }).catch((error) => {
        if (!isExecutionContextResetError(error)) {
          throw error;
        }
      });
      return lastSnapshot;
    }

    const now = Date.now();
    if (now - lastLoggedAt >= 5000) {
      log("Waiting for reader page to expose paragraph triggers...", lastSnapshot);
      lastLoggedAt = now;
    }

    await readerPage.evaluate(() => {
      const documentElement = document.documentElement;
      const body = document.body;
      if (!documentElement && !body) {
        return;
      }
      const scrollHeight = Math.max(documentElement?.scrollHeight ?? 0, body?.scrollHeight ?? 0);
      const nextTop = Math.min(
        window.scrollY + Math.max(Math.round(window.innerHeight * 0.9), 520),
        Math.max(0, scrollHeight - window.innerHeight)
      );
      if (Math.abs(nextTop - window.scrollY) > 4) {
        window.scrollTo({ top: nextTop, behavior: "auto" });
      }
    }).catch((error) => {
      if (!isExecutionContextResetError(error)) {
        throw error;
      }
    });
    await readerPage.waitForTimeout(1000);
  }

  throw new Error(`Timed out waiting for reader page readiness: ${JSON.stringify(lastSnapshot)}`);
}

async function capturePlayerVideoSnapshot(playerPage) {
  return playerPage.evaluate(() => {
    const video = document.querySelector("video");
    const playOriginalButton = document.querySelector("#play-original-video");
    const preprocessButton = document.querySelector("#preprocess-video");
    return {
      statusText: document.querySelector("#status-text")?.textContent?.trim() ?? null,
      videoName: document.querySelector("#video-name")?.textContent?.trim() ?? null,
      compatibilityStatus: document.querySelector("#video-compatibility-status")?.textContent?.trim() ?? null,
      compatibilitySummary: document.querySelector("#video-compatibility-summary")?.textContent?.trim() ?? null,
      processingStatus: document.querySelector("#video-processing-status")?.textContent?.trim() ?? null,
      processingNote: document.querySelector("#video-processing-note")?.textContent?.trim() ?? null,
      playOriginalDisabled: playOriginalButton instanceof HTMLButtonElement ? playOriginalButton.disabled : null,
      preprocessDisabled: preprocessButton instanceof HTMLButtonElement ? preprocessButton.disabled : null,
      currentSrc: video instanceof HTMLVideoElement ? video.currentSrc : null,
      duration: video instanceof HTMLVideoElement ? video.duration : null,
      readyState: video instanceof HTMLVideoElement ? video.readyState : null
    };
  });
}

async function ensureVideoReadyForSmoke(playerPage) {
  await playerPage.waitForFunction(() => {
    const videoName = document.querySelector("#video-name")?.textContent?.trim() ?? "";
    const compatibilityStatus = document.querySelector("#video-compatibility-status")?.textContent?.trim() ?? "";
    const playOriginalButton = document.querySelector("#play-original-video");
    const preprocessButton = document.querySelector("#preprocess-video");
    const hasLoadedVideoName = videoName !== "" && !videoName.includes("未加载");
    const probeFinished =
      compatibilityStatus !== "" &&
      !compatibilityStatus.includes("等待视频输入") &&
      !compatibilityStatus.includes("正在检测真实流信息");
    const canDirectPlay =
      playOriginalButton instanceof HTMLButtonElement &&
      !playOriginalButton.disabled;
    const canPreprocess =
      preprocessButton instanceof HTMLButtonElement &&
      !preprocessButton.disabled;
    return hasLoadedVideoName && (probeFinished || canDirectPlay || canPreprocess);
  }, null, { timeout: 120000 });

  let snapshot = await capturePlayerVideoSnapshot(playerPage);
  if (typeof snapshot.duration === "number" && Number.isFinite(snapshot.duration) && snapshot.duration > 0) {
    return snapshot;
  }

  if (snapshot.playOriginalDisabled === false) {
    log("Video probe finished; triggering direct play for smoke flow.", snapshot);
    await playerPage.click("#play-original-video");
    await playerPage.waitForFunction(() => {
      const video = document.querySelector("video");
      return Boolean(video && Number.isFinite(video.duration) && video.duration > 0);
    }, null, { timeout: 60000 });
    snapshot = await capturePlayerVideoSnapshot(playerPage);
    return snapshot;
  }

  if (snapshot.preprocessDisabled === false) {
    log("Video requires preprocessing before smoke can continue.", snapshot);
    throw new Error(`Smoke video is not directly playable: ${JSON.stringify(snapshot)}`);
  }

  throw new Error(`Video never became playable: ${JSON.stringify(snapshot)}`);
}

async function main() {
  if (!useRuntimeSubtitleMode && !(await fileExists(manifestPath))) {
    throw new Error(`Manifest file not found: ${manifestPath}`);
  }
  if (useRuntimeSubtitleMode && !(await fileExists(subtitlePath))) {
    throw new Error(`Subtitle file not found: ${subtitlePath}`);
  }
  if (!(await fileExists(videoPath))) {
    throw new Error(`Video file not found: ${videoPath}`);
  }
  if (!(await fileExists(extensionDistPath))) {
    throw new Error(`Extension dist directory not found: ${extensionDistPath}`);
  }
  if (browserExecutablePath && !(await fileExists(browserExecutablePath))) {
    throw new Error(`Browser executable not found: ${browserExecutablePath}`);
  }

  await fs.mkdir(userDataDir, { recursive: true });
  let manifestServer;
  let context;
  let hasSavedAuthState = await fileExists(authStatePath);

  try {
    if (!useRuntimeSubtitleMode) {
      manifestServer = await startManifestServer();
      log("Local manifest server started", manifestServer);
    }

    context = await chromium.launchPersistentContext(userDataDir, {
      channel: browserChannel,
      executablePath: browserExecutablePath ?? undefined,
      headless: false,
      args: [
        `--disable-extensions-except=${extensionDistPath}`,
        `--load-extension=${extensionDistPath}`,
        ...(proxyServer ? [`--proxy-server=${proxyServer}`] : [])
      ]
    });

    if (hasSavedAuthState) {
      await context.setStorageState(authStatePath);
      log("Restored auth state", { authStatePath });
    }

    let serviceWorker = context.serviceWorkers()[0];
    if (!serviceWorker) {
      serviceWorker = await context.waitForEvent("serviceworker");
    }
    serviceWorker.on("close", () => {
      log("Extension service worker closed");
    });
    const extensionId = new URL(serviceWorker.url()).host;
    log("Extension loaded", { extensionId, browserChannel });

    const readerPage = await context.newPage();
    attachPageDebugListeners(readerPage, "reader");
    await readerPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    log("Reader page opened", { url: readerPage.url() });

    if (readerPage.url().includes("/login")) {
      log("Please complete login in the opened browser window. Waiting for the target reading page...");
      await readerPage.waitForURL((url) => url.toString().startsWith(targetUrl), { timeout: 0 });
      await saveAuthState(context);
      hasSavedAuthState = true;
    }

    let syncedReaderPage = readerPage;
    const playerPage = await context.newPage();
    attachPageDebugListeners(playerPage, "player", { logAllConsole: true });
    const playerUrl = useRuntimeSubtitleMode
      ? `chrome-extension://${extensionId}/player/player.html`
      : `chrome-extension://${extensionId}/player/player.html?manifestBaseUrl=${encodeURIComponent(
          manifestServer.baseUrl
        )}&slug=${encodeURIComponent(manifestServer.manifestSlug)}&autofetch=1`;
    await playerPage.goto(playerUrl, { waitUntil: "domcontentloaded" });
    log("Player page opened", { url: playerUrl });

    const readerReadySnapshot = await waitForReaderPageReady(readerPage, readerReadyTimeoutMs);
    log("Reading page is ready for sync.", readerReadySnapshot);

    if (!hasSavedAuthState) {
      await saveAuthState(context);
      hasSavedAuthState = true;
    }

    await playerPage.setInputFiles("#video-file", videoPath);
    const videoReadySnapshot = await ensureVideoReadyForSmoke(playerPage);
    log("Video input is ready for smoke.", videoReadySnapshot);
    if (useRuntimeSubtitleMode) {
      try {
        await playerPage.waitForFunction(() => {
          const connectedOptions = document.querySelectorAll('#page-tab-select option[value]:not([value=""])');
          return connectedOptions.length > 0;
        }, null, { timeout: 120000 });
      } catch (error) {
        const bindingDebugSnapshot = await playerPage.evaluate(() => ({
          connectedTabsStatus: document.querySelector("#connected-tabs-status")?.textContent?.trim() ?? null,
          bindingStatus: document.querySelector("#binding-status")?.textContent?.trim() ?? null,
          pageMatchStatus: document.querySelector("#page-match-status")?.textContent?.trim() ?? null,
          pageTitle: document.querySelector("#page-title")?.textContent?.trim() ?? null,
          pageUrl: document.querySelector("#page-url-display")?.textContent?.trim() ?? null,
          pageParagraphCount: document.querySelector("#page-paragraph-count")?.textContent?.trim() ?? null,
          pageTabOptions: Array.from(document.querySelectorAll("#page-tab-select option")).map((option) => ({
            value: option.getAttribute("value"),
            text: option.textContent?.trim() ?? ""
          })),
          logOutput: document.querySelector("#log-output")?.textContent?.slice(0, 4000) ?? null
        }));
        log("Binding list debug snapshot", bindingDebugSnapshot);
        throw error;
      }
      await playerPage.click("#bind-selected-page");
      await playerPage.waitForFunction(() => {
        const bindingStatus = document.querySelector("#binding-status")?.textContent?.trim() ?? "";
        return bindingStatus !== "" && !bindingStatus.includes("等待页面连接") && !bindingStatus.includes("等待目标阅读页连接");
      }, null, { timeout: 120000 });
      syncedReaderPage = (await resolveActiveReaderPage(context, targetUrl)) ?? readerPage;
      if (syncedReaderPage !== readerPage) {
        log("Switched smoke assertions to the bound reader tab", { url: syncedReaderPage.url() });
      }
      await playerPage.setInputFiles("#subtitle-file", subtitlePath);
      await playerPage.waitForFunction(() => {
        const subtitleName = document.querySelector("#subtitle-name");
        return subtitleName?.textContent && !subtitleName.textContent.includes("未加载");
      });
      try {
        await playerPage.waitForFunction(() => {
          const subtitleStatus = document.querySelector("#subtitle-status");
          const manifestName = document.querySelector("#manifest-name");
          return Boolean(
            subtitleStatus?.textContent &&
              subtitleStatus.textContent.includes("已生成运行时清单") &&
              manifestName?.textContent &&
              !manifestName.textContent.includes("未加载")
          );
        }, null, { timeout: 120000 });
      } catch (error) {
        const runtimeDebugSnapshot = await playerPage.evaluate(() => ({
          statusText: document.querySelector("#status-text")?.textContent?.trim() ?? null,
          subtitleStatus: document.querySelector("#subtitle-status")?.textContent?.trim() ?? null,
          manifestName: document.querySelector("#manifest-name")?.textContent?.trim() ?? null,
          bindingStatus: document.querySelector("#binding-status")?.textContent?.trim() ?? null,
          pageMatchStatus: document.querySelector("#page-match-status")?.textContent?.trim() ?? null,
          pageTitle: document.querySelector("#page-title")?.textContent?.trim() ?? null,
          pageUrl: document.querySelector("#page-url-display")?.textContent?.trim() ?? null,
          pageParagraphCount: document.querySelector("#page-paragraph-count")?.textContent?.trim() ?? null,
          logOutput: document.querySelector("#log-output")?.textContent?.slice(0, 3000) ?? null
        }));
        log("Runtime subtitle generation debug snapshot", runtimeDebugSnapshot);
        throw error;
      }
    } else {
      await playerPage.waitForFunction(() => {
        const manifestName = document.querySelector("#manifest-name");
        return manifestName?.textContent && !manifestName.textContent.includes("未加载");
      }, null);
    }
    await playerPage.waitForFunction(() => {
      const bindingStatus = document.querySelector("#binding-status");
      const nearbyList = document.querySelectorAll("#sync-nearby-list [data-start-ms]");
      return Boolean(bindingStatus?.textContent && nearbyList.length > 0);
    }, null);
    await playerPage.click("#request-page-context");
    log("Player page loaded video and manifest.");

    await playerPage.evaluate((seekSeconds) => {
      const video = document.querySelector("video");
      if (!video) {
        throw new Error("Missing video element");
      }
      video.currentTime = seekSeconds;
      video.dispatchEvent(new Event("seeking"));
      video.dispatchEvent(new Event("timeupdate"));
      video.dispatchEvent(new Event("seeked"));
    }, smokeSeekSeconds);
    try {
      await playerPage.waitForFunction(() => {
        const activeParagraph = document.querySelector("#active-paragraph");
        return Boolean(activeParagraph?.textContent && activeParagraph.textContent.trim() !== "-");
      });
    } catch (error) {
      const seekDebugSnapshot = await playerPage.evaluate(() => {
        const video = document.querySelector("video");
        const nearbyItems = Array.from(document.querySelectorAll("#sync-nearby-list [data-start-ms]")).slice(0, 5);
        return {
          currentTime: video?.currentTime ?? null,
          readyState: video?.readyState ?? null,
          paused: video?.paused ?? null,
          seeking: video?.seeking ?? null,
          activeParagraph: document.querySelector("#active-paragraph")?.textContent?.trim() ?? null,
          subtitleStatus: document.querySelector("#subtitle-status")?.textContent?.trim() ?? null,
          bindingStatus: document.querySelector("#binding-status")?.textContent?.trim() ?? null,
          pageMatchStatus: document.querySelector("#page-match-status")?.textContent?.trim() ?? null,
          currentSyncRange: document.querySelector("#current-sync-range")?.textContent?.trim() ?? null,
          currentSyncScore: document.querySelector("#current-sync-score")?.textContent?.trim() ?? null,
          currentTranscriptPreview: document.querySelector("#current-transcript-preview")?.textContent?.trim() ?? null,
          currentArticlePreview: document.querySelector("#current-article-preview")?.textContent?.trim() ?? null,
          nearbyItems: nearbyItems.map((element) => ({
            paragraphIndex: element.getAttribute("data-paragraph-index"),
            startMs: element.getAttribute("data-start-ms"),
            text: element.textContent?.replace(/\s+/g, " ").trim() ?? null
          })),
          logOutput: document.querySelector("#log-output")?.textContent?.slice(0, 4000) ?? null
        };
      });
      log("Seek debug snapshot", seekDebugSnapshot);
      throw error;
    }
    const expectedParagraphIndex = await playerPage.evaluate(() => {
      const activeParagraph = document.querySelector("#active-paragraph");
      const parsed = Number.parseInt(activeParagraph?.textContent?.trim() ?? "", 10);
      return Number.isFinite(parsed) ? parsed : null;
    });
    if (!Number.isFinite(expectedParagraphIndex)) {
      throw new Error("Player did not resolve a numeric active paragraph after seeking.");
    }

    try {
      await syncedReaderPage.waitForFunction((expectedParagraphIndex) => {
        const overlay = document.querySelector("#reader-sync-status-overlay");
        const active = document.querySelector(".reader-sync-active[data-reader-sync-paragraph-index]");
        const activeParagraphIndex = active?.getAttribute("data-reader-sync-paragraph-index");
        const overlayText = overlay?.textContent?.replace(/\s+/g, " ").trim() ?? "";
        return activeParagraphIndex === String(expectedParagraphIndex) || overlayText.includes(`#${expectedParagraphIndex}`);
      }, expectedParagraphIndex);
    } catch (error) {
      const readerDebugSnapshot = await syncedReaderPage.evaluate(() => ({
        overlayText: document.querySelector("#reader-sync-status-overlay")?.textContent?.replace(/\s+/g, " ").trim() ?? null,
        activeParagraphIndex:
          document
            .querySelector(".reader-sync-active[data-reader-sync-paragraph-index]")
            ?.getAttribute("data-reader-sync-paragraph-index") ?? null,
        markedParagraphCount: document.querySelectorAll("[data-reader-sync-paragraph-index]").length,
        firstMarkedParagraph:
          document.querySelector("[data-reader-sync-paragraph-index]")?.getAttribute("data-reader-sync-paragraph-index") ?? null,
        title: document.title
      }));
      const playerDebugSnapshot = await playerPage.evaluate(() => ({
        activeParagraph: document.querySelector("#active-paragraph")?.textContent?.trim() ?? null,
        bindingStatus: document.querySelector("#binding-status")?.textContent?.trim() ?? null,
        connectedTabsStatus: document.querySelector("#connected-tabs-status")?.textContent?.trim() ?? null,
        pageMatchStatus: document.querySelector("#page-match-status")?.textContent?.trim() ?? null,
        logOutput: document.querySelector("#log-output")?.textContent?.slice(0, 3000) ?? null
      }));
      const openPages = context.pages().map((page) => page.url());
      log("Forward sync debug snapshot", {
        expectedParagraphIndex,
        readerDebugSnapshot,
        playerDebugSnapshot,
        openPages
      });
      throw error;
    }
    const activeParagraphIndex = await syncedReaderPage.evaluate(() => {
      const active = document.querySelector(".reader-sync-active[data-reader-sync-paragraph-index]");
      return active?.getAttribute("data-reader-sync-paragraph-index") ?? null;
    });
    const overlaySnapshot = await syncedReaderPage.evaluate(() => {
      const overlay = document.querySelector("#reader-sync-status-overlay");
      return overlay?.textContent?.replace(/\s+/g, " ").trim() ?? null;
    });
    log("Forward sync is active", { activeParagraphIndex, expectedParagraphIndex });
    log("Reader overlay updated", { overlaySnapshot });

    const playerPreviewSnapshot = await playerPage.evaluate(() => ({
      bindingStatus: document.querySelector("#binding-status")?.textContent?.trim() ?? null,
      subtitleName: document.querySelector("#subtitle-name")?.textContent?.trim() ?? null,
      subtitleStatus: document.querySelector("#subtitle-status")?.textContent?.trim() ?? null,
      transcriptPreview: document.querySelector("#current-transcript-preview")?.textContent?.trim() ?? null,
      articlePreview: document.querySelector("#current-article-preview")?.textContent?.trim() ?? null,
      syncScore: document.querySelector("#current-sync-score")?.textContent?.trim() ?? null,
      nearbyCount: document.querySelectorAll("#sync-nearby-list [data-start-ms]").length,
      remoteIndexStatus: document.querySelector("#remote-index-status")?.textContent?.trim() ?? null,
      connectedTabsStatus: document.querySelector("#connected-tabs-status")?.textContent?.trim() ?? null,
      connectedTabCount: document.querySelectorAll('#page-tab-select option[value]:not([value=""])').length
    }));
    if (
      !playerPreviewSnapshot.bindingStatus ||
      !playerPreviewSnapshot.transcriptPreview ||
      (!useRuntimeSubtitleMode && !playerPreviewSnapshot.remoteIndexStatus)
    ) {
      throw new Error("Player preview panel did not render synced content.");
    }
    if (useRuntimeSubtitleMode && !playerPreviewSnapshot.subtitleStatus?.includes("已生成运行时清单")) {
      throw new Error("Runtime subtitle manifest was not generated.");
    }
    if (
      playerPreviewSnapshot.connectedTabCount === 0 &&
      !playerPreviewSnapshot.bindingStatus.includes("等待页面列表同步")
    ) {
      throw new Error("Binding status did not stay aligned with the snapshot-only connected tabs state.");
    }
    log("Player preview updated", playerPreviewSnapshot);

    await playerPage.click("#drop-zone", { position: { x: 12, y: 12 } });
    const preKeyboardTime = await playerPage.evaluate(() => {
      const video = document.querySelector("video");
      return video?.currentTime ?? null;
    });
    await playerPage.keyboard.press("ArrowRight");
    await playerPage.waitForFunction(
      ({ beforeTime, minimumDeltaSeconds }) => {
        const video = document.querySelector("video");
        return Boolean(video && typeof beforeTime === "number" && video.currentTime >= beforeTime + minimumDeltaSeconds - 1);
      },
      { beforeTime: preKeyboardTime, minimumDeltaSeconds: keyboardSeekSeconds }
    );
    const postKeyboardTime = await playerPage.evaluate(() => {
      const video = document.querySelector("video");
      return video?.currentTime ?? null;
    });
    log("Keyboard seek is active", { preKeyboardTime, postKeyboardTime });

    const preReaderKeyboardState = await playerPage.evaluate(() => {
      const video = document.querySelector("video");
      return {
        currentTime: video?.currentTime ?? null,
        playbackRate: video?.playbackRate ?? null
      };
    });
    await syncedReaderPage.bringToFront();
    await pressReaderKeyUntilPlayerStateChanges(
      syncedReaderPage,
      playerPage,
      "ArrowRight",
      ({ beforeTime, minimumDeltaSeconds }) => {
        const video = document.querySelector("video");
        return Boolean(video && typeof beforeTime === "number" && video.currentTime >= beforeTime + minimumDeltaSeconds - 1);
      },
      { beforeTime: preReaderKeyboardState.currentTime, minimumDeltaSeconds: keyboardSeekSeconds }
    );
    await pressReaderKeyUntilPlayerStateChanges(
      syncedReaderPage,
      playerPage,
      "KeyX",
      (beforeRate) => {
        const video = document.querySelector("video");
        return Boolean(video && typeof beforeRate === "number" && video.playbackRate > beforeRate);
      },
      preReaderKeyboardState.playbackRate
    );
    const postReaderKeyboardState = await playerPage.evaluate(() => {
      const video = document.querySelector("video");
      return {
        currentTime: video?.currentTime ?? null,
        playbackRate: video?.playbackRate ?? null
      };
    });
    log("Reader-page keyboard control is active", {
      preReaderKeyboardState,
      postReaderKeyboardState
    });

    await syncedReaderPage.evaluate(() => {
      window.scrollTo({ top: 0, behavior: "auto" });
    });
    await syncedReaderPage.waitForSelector("[data-paragraph-trigger]", { timeout: 120000 });

    const reverseCandidates = await syncedReaderPage.evaluate((preferredParagraphIndex) => {
      const values = Array.from(document.querySelectorAll("[data-paragraph-trigger]"))
        .map((element) => Number.parseInt(element.getAttribute("data-paragraph-trigger") ?? "", 10))
        .filter((value) => Number.isFinite(value));
      const uniqueValues = [...new Set(values)];
      if (uniqueValues.includes(preferredParagraphIndex)) {
        return [preferredParagraphIndex, ...uniqueValues.filter((value) => value !== preferredParagraphIndex)];
      }
      return uniqueValues;
    }, reverseClickParagraph);

    if (reverseCandidates.length === 0) {
      throw new Error("No visible paragraph trigger is available for reverse-sync smoke verification.");
    }

    const reverseSyncProbeWindow = reverseCandidates.slice(0, 8);
    let reverseSyncResult = null;

    for (const candidateParagraphIndex of reverseSyncProbeWindow) {
      const beforeReverseState = await playerPage.evaluate(() => {
        const video = document.querySelector("video");
        return {
          currentTime: video?.currentTime ?? null,
          activeParagraph: document.querySelector("#active-paragraph")?.textContent?.trim() ?? null
        };
      });

      await syncedReaderPage.click(`[data-paragraph-trigger="${candidateParagraphIndex}"]`);

      try {
        await playerPage.waitForFunction(
          ({ candidateParagraphIndex, beforeTime }) => {
            const video = document.querySelector("video");
            const activeParagraph = document.querySelector("#active-paragraph")?.textContent?.trim() ?? "";
            const numericActiveParagraph = Number.parseInt(activeParagraph, 10);
            const currentTime = video?.currentTime ?? null;
            const hasParagraphMatch = Number.isFinite(numericActiveParagraph) && numericActiveParagraph === candidateParagraphIndex;
            const hasTimeShift =
              typeof currentTime === "number" &&
              Number.isFinite(currentTime) &&
              typeof beforeTime === "number" &&
              Math.abs(currentTime - beforeTime) >= 1.5;
            return hasParagraphMatch || hasTimeShift;
          },
          { candidateParagraphIndex, beforeTime: beforeReverseState.currentTime },
          { timeout: 12000 }
        );

        const afterReverseState = await playerPage.evaluate(() => {
          const video = document.querySelector("video");
          return {
            currentTime: video?.currentTime ?? null,
            activeParagraph: document.querySelector("#active-paragraph")?.textContent?.trim() ?? null
          };
        });

        reverseSyncResult = {
          candidateParagraphIndex,
          beforeReverseState,
          afterReverseState
        };
        break;
      } catch {
        log("Reverse sync candidate did not move the player.", {
          candidateParagraphIndex,
          beforeReverseState
        });
      }
    }

    if (!reverseSyncResult) {
      throw new Error(`Reverse sync could not be verified from visible paragraph candidates: ${JSON.stringify(reverseSyncProbeWindow)}`);
    }

    log("Reverse sync is active", reverseSyncResult);

    if (keepOpen) {
      log("Smoke test finished. Browser remains open because --keep-open=1 was passed.");
      return;
    }
  } finally {
    if (context && !keepOpen) {
      await context.close();
    }

    if (manifestServer && !keepOpen) {
      await new Promise((resolve, reject) => {
        manifestServer.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
