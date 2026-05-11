import { createLogger, type ReaderSyncLogEntry, setReaderSyncLogSink } from "../shared/logger";
import {
  type AimReadArticleSnapshot,
  CONTENT_PORT_NAME,
  type AimReadPageContext,
  type ConnectedAimReadTab,
  type RuntimeMessage,
  PLAYER_PORT_NAME
} from "../shared/protocol";
import { createZipArchive, type ZipFileEntry } from "../shared/zip-writer";

const logger = createLogger("background");
const playerPorts = new Set<chrome.runtime.Port>();
const contentPorts = new Map<number, chrome.runtime.Port>();
const contentPortTabIds = new WeakMap<chrome.runtime.Port, number>();
const pageContexts = new Map<number, AimReadPageContext>();
const articleSnapshots = new Map<number, AimReadArticleSnapshot>();
const articleSnapshotErrors = new Map<number, string>();
const feedbackFormUrl = "https://my.feishu.cn/share/base/form/shrcngqXdrdIP1Qzmr02Wq7070b";
const runtimeLogLimit = 2000;
const runtimeLogs: ReaderSyncLogEntry[] = [];

let preferredTabId: number | null = null;

function rememberRuntimeLog(entry: ReaderSyncLogEntry): void {
  runtimeLogs.push(entry);
  if (runtimeLogs.length > runtimeLogLimit) {
    runtimeLogs.splice(0, runtimeLogs.length - runtimeLogLimit);
  }
}

setReaderSyncLogSink(rememberRuntimeLog);

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function postMessage(port: chrome.runtime.Port, message: RuntimeMessage): boolean {
  try {
    port.postMessage(message);
    return true;
  } catch (error) {
    logger.warn("Port postMessage failed", error);
    return false;
  }
}

function broadcastToPlayers(message: RuntimeMessage): void {
  for (const port of playerPorts) {
    postMessage(port, message);
  }
}

function getKnownReaderTabIds(): number[] {
  return Array.from(new Set([...pageContexts.keys(), ...articleSnapshots.keys(), ...contentPorts.keys()]));
}

function sanitizeFeedbackFileToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64) || "reader-sync-feedback";
}

function formatTimestampForFileName(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function dataUrlToBytes(dataUrl: string): { bytes: Uint8Array; mimeType: string } {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/);
  if (!match) {
    throw new Error("截图返回的数据格式不可识别。");
  }
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return {
    mimeType: match[1],
    bytes
  };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function buildRuntimeDiagnostics(description: string, screenshotIncluded: boolean): Record<string, unknown> {
  return {
    exportedAt: new Date().toISOString(),
    extension: {
      id: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      name: chrome.runtime.getManifest().name
    },
    feedback: {
      description: description.trim() || null,
      screenshotIncluded
    },
    runtime: {
      preferredTabId,
      playerPortCount: playerPorts.size,
      contentPortCount: contentPorts.size,
      connectedReaderTabIds: getKnownReaderTabIds()
    },
    readerTabs: Array.from(pageContexts.entries()).map(([tabId, pageContext]) => ({
      tabId,
      title: pageContext.title,
      articleUrl: pageContext.articleUrl,
      articleId: pageContext.articleId,
      categoryId: pageContext.categoryId,
      paragraphCount: pageContext.paragraphs.length,
      capturedAt: pageContext.capturedAt,
      hasArticleSnapshot: articleSnapshots.has(tabId),
      articleSnapshotError: articleSnapshotErrors.get(tabId) ?? null
    }))
  };
}

async function captureActiveTabScreenshot(): Promise<ZipFileEntry | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const activeTab = tabs[0];
  if (!activeTab || typeof activeTab.windowId !== "number") {
    logger.warn("No active tab is available for feedback screenshot");
    return null;
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: "png" });
  const { bytes } = dataUrlToBytes(dataUrl);
  return {
    path: "screenshot/current-tab.png",
    bytes
  };
}

async function exportFeedbackBundle(description: string, includeScreenshot: boolean): Promise<{
  fileName: string;
  logCount: number;
  screenshotIncluded: boolean;
}> {
  let screenshotError: string | null = null;
  const screenshotEntry = includeScreenshot ? await captureActiveTabScreenshot().catch((error) => {
    screenshotError = error instanceof Error ? error.message : String(error);
    logger.warn("Feedback screenshot capture failed", { error: screenshotError });
    return null;
  }) : null;
  const diagnostics = buildRuntimeDiagnostics(description, screenshotEntry !== null);
  diagnostics.feedback = {
    ...(diagnostics.feedback as Record<string, unknown>),
    screenshotRequested: includeScreenshot,
    screenshotError
  };
  const logs = [...runtimeLogs];
  const entries: ZipFileEntry[] = [
    {
      path: "logs/reader-sync-runtime-logs.json",
      content: `${JSON.stringify(logs, null, 2)}\n`
    },
    {
      path: "logs/reader-sync-runtime-logs.txt",
      content: `${logs.map((entry) => {
        const metadata = entry.metadata === undefined ? "" : ` ${JSON.stringify(entry.metadata)}`;
        return `${entry.timestamp} [${entry.level}] [${entry.scope}] ${entry.message}${metadata}`;
      }).join("\n")}\n`
    },
    {
      path: "feedback/feedback.json",
      content: `${JSON.stringify(diagnostics, null, 2)}\n`
    },
    {
      path: "feedback/feedback.txt",
      content: [
        "Reader Sync 用户反馈",
        "",
        `导出时间：${diagnostics.exportedAt}`,
        `插件版本：${chrome.runtime.getManifest().version}`,
        `问题描述：${description.trim() || "未填写"}`,
        `包含截图：${screenshotEntry ? "是" : "否"}`,
        `日志条数：${logs.length}`,
        "",
        `请在飞书表单继续反馈：${feedbackFormUrl}`
      ].join("\n")
    }
  ];
  if (screenshotEntry) {
    entries.push(screenshotEntry);
  } else if (includeScreenshot && screenshotError) {
    entries.push({
      path: "screenshot/error.txt",
      content: `截图失败：${screenshotError}\n`
    });
  }

  const archive = createZipArchive(entries);
  const dataUrl = `data:application/zip;base64,${bytesToBase64(archive)}`;
  const fileName = `${sanitizeFeedbackFileToken(chrome.runtime.getManifest().name)}-${formatTimestampForFileName()}.zip`;
  await chrome.downloads.download({
    url: dataUrl,
    filename: fileName,
    saveAs: false
  });
  await chrome.tabs.create({ url: feedbackFormUrl });
  return {
    fileName,
    logCount: logs.length,
    screenshotIncluded: screenshotEntry !== null
  };
}

async function postMessageToReaderTab(tabId: number, message: RuntimeMessage): Promise<void> {
  const port = contentPorts.get(tabId);
  if (port) {
    postMessage(port, message);
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    logger.warn("tabs.sendMessage failed", { tabId, type: message.type, error });
  }
}

async function tryPostMessageToReaderTab(tabId: number, message: RuntimeMessage): Promise<boolean> {
  const port = contentPorts.get(tabId);
  if (port) {
    return postMessage(port, message);
  }

  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch (error) {
    logger.warn("tabs.sendMessage failed", { tabId, type: message.type, error });
    return false;
  }
}

function broadcastToContent(message: RuntimeMessage, targetTabId: number | null): void {
  if (targetTabId !== null) {
    void postMessageToReaderTab(targetTabId, message);
    return;
  }

  for (const tabId of getKnownReaderTabIds()) {
    void postMessageToReaderTab(tabId, message);
  }
}

async function getFallbackAimReadTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: ["https://aim-read.top/*"]
  });
  for (const tab of tabs) {
    if (typeof tab.id === "number" && pageContexts.has(tab.id)) {
      return tab.id;
    }
  }
  return null;
}

function isAimReadArticleUrl(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  try {
    const parsedUrl = new URL(url);
    return /^\/daily-feed\/\d+/.test(parsedUrl.pathname);
  } catch {
    return false;
  }
}

async function collectPageContextFromAllAimReadTabs(options?: { reloadUnresponsiveArticleTabs?: boolean }): Promise<{
  candidateCount: number;
  deliveredCount: number;
  reloadedCount: number;
}> {
  const tabs = await chrome.tabs.query({
    url: ["https://aim-read.top/*"]
  });

  let deliveredCount = 0;
  let reloadedCount = 0;

  await Promise.all(
    tabs.map(async (tab) => {
      if (typeof tab.id !== "number") {
        return;
      }

      const delivered = await tryPostMessageToReaderTab(tab.id, { type: "COLLECT_PAGE_CONTEXT" });
      if (delivered) {
        deliveredCount += 1;
        return;
      }

      if (!options?.reloadUnresponsiveArticleTabs || !isAimReadArticleUrl(tab.url)) {
        return;
      }

      try {
        await chrome.tabs.reload(tab.id);
        reloadedCount += 1;
      } catch (error) {
        logger.warn("Failed to reload aim-read article tab during refresh", { tabId: tab.id, error });
      }
    })
  );

  return {
    candidateCount: tabs.length,
    deliveredCount,
    reloadedCount
  };
}

function getConnectedReaderTabIds(): number[] {
  return Array.from(pageContexts.keys());
}

async function resolveTargetTabId(): Promise<number | null> {
  if (preferredTabId !== null && contentPorts.has(preferredTabId) && pageContexts.has(preferredTabId)) {
    return preferredTabId;
  }

  const fallbackTabId = await getFallbackAimReadTabId();
  if (fallbackTabId !== null && contentPorts.has(fallbackTabId)) {
    preferredTabId = fallbackTabId;
    return fallbackTabId;
  }

  const connectedTabId = getConnectedReaderTabIds()[0];
  if (typeof connectedTabId === "number") {
    preferredTabId = connectedTabId;
    return connectedTabId;
  }

  preferredTabId = null;
  return null;
}

async function collectPreferredPageContext(targetTabId: number | null): Promise<void> {
  if (targetTabId === null) {
    return;
  }
  await postMessageToReaderTab(targetTabId, { type: "COLLECT_PAGE_CONTEXT" });
}

async function collectPreferredArticleSnapshot(targetTabId: number | null): Promise<void> {
  if (targetTabId === null) {
    logger.warn("Skipping article snapshot request because no target reader tab is available");
    return;
  }
  const targetTab = await chrome.tabs.get(targetTabId).catch(() => null);
  if (!isAimReadArticleUrl(targetTab?.url)) {
    logger.debug("Skipping article snapshot request for non-article aim-read tab", {
      targetTabId,
      url: targetTab?.url ?? null
    });
    return;
  }
  logger.info("Requesting article snapshot from reader tab", { targetTabId });
  await postMessageToReaderTab(targetTabId, { type: "COLLECT_ARTICLE_SNAPSHOT" });
}

async function buildConnectedTabsSnapshot(): Promise<ConnectedAimReadTab[]> {
  const snapshots = await Promise.all(
    getConnectedReaderTabIds().map(async (tabId) => {
      try {
        const tab = await chrome.tabs.get(tabId);
        const pageContext = pageContexts.get(tabId) ?? null;
        return {
          tabId,
          windowId: tab.windowId,
          active: Boolean(tab.active),
          title: pageContext?.title ?? tab.title ?? "Untitled aim-read tab",
          url: pageContext?.articleUrl ?? tab.url ?? "",
          articleId: pageContext?.articleId ?? null,
          categoryId: pageContext?.categoryId ?? null,
          paragraphCount: pageContext?.paragraphs.length ?? 0,
          preferred: preferredTabId === tabId,
          capturedAt: pageContext?.capturedAt ?? null
        } satisfies ConnectedAimReadTab;
      } catch (error) {
        logger.warn("Failed to snapshot connected tab", { tabId, error });
        contentPorts.delete(tabId);
        pageContexts.delete(tabId);
        if (preferredTabId === tabId) {
          preferredTabId = null;
        }
        return null;
      }
    })
  );

  return snapshots
    .filter((snapshot): snapshot is ConnectedAimReadTab => snapshot !== null)
    .sort((left, right) => {
      if (left.preferred !== right.preferred) {
        return left.preferred ? -1 : 1;
      }
      if (left.active !== right.active) {
        return left.active ? -1 : 1;
      }
      return left.tabId - right.tabId;
    });
}

async function pushConnectedTabsSnapshot(): Promise<void> {
  const tabs = await buildConnectedTabsSnapshot();
  broadcastToPlayers({
    type: "CONNECTED_TABS_RESPONSE",
    payload: {
      preferredTabId,
      tabs
    }
  });
}

async function refreshConnectedTabsState(
  port?: chrome.runtime.Port,
  options?: { reloadUnresponsiveArticleTabs?: boolean }
): Promise<void> {
  const refreshResult = await collectPageContextFromAllAimReadTabs({
    reloadUnresponsiveArticleTabs: options?.reloadUnresponsiveArticleTabs === true
  });

  if (refreshResult.candidateCount > 0) {
    await wait(refreshResult.reloadedCount > 0 ? 900 : 180);
  }

  logger.info("Refreshed connected aim-read tabs", refreshResult);

  await pushConnectedTabsSnapshot();
  await pushActivePageContext(port);
  await pushActiveArticleSnapshot(port);
}

async function pushActivePageContext(port?: chrome.runtime.Port): Promise<void> {
  const targetTabId = await resolveTargetTabId();
  const message: RuntimeMessage = {
    type: "ACTIVE_PAGE_CONTEXT_RESPONSE",
    payload: {
      tabId: typeof targetTabId === "number" ? targetTabId : null,
      pageContext: targetTabId === null ? null : pageContexts.get(targetTabId) ?? null
    }
  };

  if (port) {
    postMessage(port, message);
  } else {
    broadcastToPlayers(message);
  }
}

async function pushActiveArticleSnapshot(port?: chrome.runtime.Port): Promise<void> {
  const targetTabId = await resolveTargetTabId();
  const message: RuntimeMessage = {
    type: "ACTIVE_ARTICLE_SNAPSHOT_RESPONSE",
    payload: {
      tabId: typeof targetTabId === "number" ? targetTabId : null,
      articleSnapshot: targetTabId === null ? null : articleSnapshots.get(targetTabId) ?? null,
      error: targetTabId === null ? null : articleSnapshotErrors.get(targetTabId) ?? null
    }
  };

  if (port) {
    postMessage(port, message);
  } else {
    broadcastToPlayers(message);
  }
}

function removePort(port: chrome.runtime.Port): void {
  if (playerPorts.delete(port)) {
    return;
  }

  for (const [tabId, candidate] of contentPorts.entries()) {
    if (candidate === port) {
      contentPorts.delete(tabId);
      break;
    }
  }

  void pushConnectedTabsSnapshot();
  void pushActivePageContext();
  void pushActiveArticleSnapshot();
}

function resolveContentPortTabId(port: chrome.runtime.Port): number | null {
  const rememberedTabId = contentPortTabIds.get(port);
  if (typeof rememberedTabId === "number") {
    return rememberedTabId;
  }
  const senderTabId = port.sender?.tab?.id;
  return typeof senderTabId === "number" ? senderTabId : null;
}

async function handlePlayerMessage(port: chrome.runtime.Port, message: RuntimeMessage): Promise<void> {
  switch (message.type) {
    case "LOG_ENTRY": {
      rememberRuntimeLog(message.payload);
      return;
    }
    case "PLAYER_STATE_UPDATE": {
      const targetTabId = await resolveTargetTabId();
      broadcastToContent(message, targetTabId);
      return;
    }
    case "EXPORT_FEEDBACK_BUNDLE": {
      try {
        const result = await exportFeedbackBundle(message.payload.description, message.payload.includeScreenshot);
        postMessage(port, {
          type: "EXPORT_FEEDBACK_BUNDLE_RESULT",
          payload: {
            ok: true,
            ...result
          }
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Feedback bundle export failed", { error: errorMessage });
        postMessage(port, {
          type: "EXPORT_FEEDBACK_BUNDLE_RESULT",
          payload: {
            ok: false,
            error: errorMessage
          }
        });
      }
      return;
    }
    case "REQUEST_ACTIVE_PAGE_CONTEXT": {
      const targetTabId = await resolveTargetTabId();
      await collectPreferredPageContext(targetTabId);
      await wait(120);
      await pushActivePageContext(port);
      return;
    }
    case "REQUEST_ACTIVE_ARTICLE_SNAPSHOT": {
      const targetTabId = await resolveTargetTabId();
      logger.info("Player requested active article snapshot", { targetTabId });
      await collectPreferredArticleSnapshot(targetTabId);
      await pushActiveArticleSnapshot(port);
      return;
    }
    case "REQUEST_CONNECTED_TABS": {
      await refreshConnectedTabsState(port);
      return;
    }
    case "REFRESH_READER_TABS": {
      await refreshConnectedTabsState(port, { reloadUnresponsiveArticleTabs: true });
      return;
    }
    case "SET_PREFERRED_TAB": {
      preferredTabId = message.payload.tabId;
      await collectPreferredPageContext(preferredTabId);
      await collectPreferredArticleSnapshot(preferredTabId);
      await wait(120);
      await pushConnectedTabsSnapshot();
      await pushActivePageContext();
      await pushActiveArticleSnapshot();
      return;
    }
    default:
      return;
  }
}

function handleContentMessage(message: RuntimeMessage, tabId: number): void {
  switch (message.type) {
    case "LOG_ENTRY":
      rememberRuntimeLog(message.payload);
      return;
    case "PAGE_CONTEXT_UPDATE": {
      let shouldRefreshArticleSnapshot = !articleSnapshots.has(tabId);
      if (articleSnapshots.has(tabId)) {
        const existingSnapshot = articleSnapshots.get(tabId);
        if (
          existingSnapshot &&
          ((existingSnapshot.articleId !== null && existingSnapshot.articleId !== message.payload.articleId) ||
            existingSnapshot.articleUrl !== message.payload.articleUrl)
        ) {
          articleSnapshots.delete(tabId);
          shouldRefreshArticleSnapshot = true;
        }
      }
      pageContexts.set(tabId, message.payload);
      articleSnapshotErrors.delete(tabId);
      if (preferredTabId === null) {
        preferredTabId = tabId;
      }
      broadcastToPlayers({
        type: "ACTIVE_PAGE_CONTEXT_RESPONSE",
        payload: {
          tabId,
          pageContext: message.payload
        }
      });
      if (shouldRefreshArticleSnapshot) {
        void collectPreferredArticleSnapshot(tabId);
      }
      void pushConnectedTabsSnapshot();
      void pushActivePageContext();
      return;
    }
    case "ARTICLE_SNAPSHOT_UPDATE":
      logger.info("Received article snapshot update from reader tab", {
        tabId,
        articleId: message.payload.articleId,
        paragraphCount: message.payload.paragraphs.length,
        totalPages: message.payload.pageInfo?.totalPages ?? null
      });
      articleSnapshots.set(tabId, message.payload);
      articleSnapshotErrors.delete(tabId);
      if (preferredTabId === null) {
        preferredTabId = tabId;
      }
      broadcastToPlayers({
        type: "ACTIVE_ARTICLE_SNAPSHOT_RESPONSE",
        payload: {
          tabId,
          articleSnapshot: message.payload,
          error: null
        }
      });
      void pushActiveArticleSnapshot();
      return;
    case "ARTICLE_SNAPSHOT_ERROR":
      logger.warn("Received article snapshot error from reader tab", {
        tabId,
        message: message.payload.message
      });
      articleSnapshots.delete(tabId);
      articleSnapshotErrors.set(tabId, message.payload.message);
      if (preferredTabId === null) {
        preferredTabId = tabId;
      }
      broadcastToPlayers({
        type: "ACTIVE_ARTICLE_SNAPSHOT_RESPONSE",
        payload: {
          tabId,
          articleSnapshot: null,
          error: message.payload.message
        }
      });
      void pushActiveArticleSnapshot();
      return;
    case "PAGE_PARAGRAPH_CLICKED":
      preferredTabId = tabId;
      void pushConnectedTabsSnapshot();
      void pushActivePageContext();
      void pushActiveArticleSnapshot();
      broadcastToPlayers({
        type: "PLAYER_SEEK_COMMAND",
        payload: {
          paragraphIndex: message.payload.paragraphIndex,
          seekMs: 0
        }
      });
      return;
    case "PLAYER_CONTROL_COMMAND":
      preferredTabId = tabId;
      void pushConnectedTabsSnapshot();
      void pushActivePageContext();
      broadcastToPlayers(message);
      return;
    default:
      return;
  }
}

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("player/player.html")
  }).catch((error) => {
    logger.error("Failed to open player page", error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  contentPorts.delete(tabId);
  pageContexts.delete(tabId);
  articleSnapshots.delete(tabId);
  articleSnapshotErrors.delete(tabId);
  if (preferredTabId === tabId) {
    preferredTabId = null;
  }
  void pushConnectedTabsSnapshot();
  void pushActivePageContext();
  void pushActiveArticleSnapshot();
});

chrome.tabs.onUpdated.addListener((tabId) => {
  if (!contentPorts.has(tabId)) {
    return;
  }
  void pushConnectedTabsSnapshot();
});

chrome.runtime.onMessage.addListener((rawMessage: unknown) => {
  const message = rawMessage as RuntimeMessage;
  if (message.type === "LOG_ENTRY") {
    rememberRuntimeLog(message.payload);
  }
});

chrome.runtime.onConnect.addListener((port) => {
  logger.info("Port connected", { name: port.name });
  if (port.name === PLAYER_PORT_NAME) {
    playerPorts.add(port);
    void refreshConnectedTabsState(port);
  }
  if (port.name === CONTENT_PORT_NAME) {
    const tabId = port.sender?.tab?.id;
    if (typeof tabId === "number") {
      contentPorts.set(tabId, port);
      contentPortTabIds.set(port, tabId);
      if (preferredTabId === null) {
        preferredTabId = tabId;
      }
      void collectPreferredPageContext(tabId);
      void collectPreferredArticleSnapshot(tabId);
      void pushConnectedTabsSnapshot();
    }
  }

  port.onDisconnect.addListener(() => {
    removePort(port);
  });

  port.onMessage.addListener((rawMessage: unknown) => {
    const message = rawMessage as RuntimeMessage;
    if (port.name === PLAYER_PORT_NAME) {
      void handlePlayerMessage(port, message);
      return;
    }

    if (port.name === CONTENT_PORT_NAME) {
      const tabId = resolveContentPortTabId(port);
      if (typeof tabId === "number") {
        handleContentMessage(message, tabId);
      }
    }
  });
});
