// src/shared/logger.ts
var localLogBufferLimit = 400;
var localLogBuffer = [];
var logSink = null;
var logSequence = 0;
function sanitizeMetadata(value, depth = 0) {
  if (value === null || value === void 0) {
    return value;
  }
  if (depth >= 4) {
    return "[MaxDepth]";
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "function" || typeof value === "symbol") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 80).map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (typeof value === "object") {
    const output = {};
    for (const [key, nestedValue] of Object.entries(value).slice(0, 80)) {
      output[key] = sanitizeMetadata(nestedValue, depth + 1);
    }
    return output;
  }
  return String(value);
}
function resolveLocation() {
  try {
    return globalThis.location?.href;
  } catch {
    return void 0;
  }
}
function resolveUserAgent() {
  try {
    return globalThis.navigator?.userAgent;
  } catch {
    return void 0;
  }
}
function setReaderSyncLogSink(sink, options) {
  logSink = sink;
  if (sink && options?.flushExisting !== false) {
    for (const entry of localLogBuffer) {
      sink(entry);
    }
  }
}
function log(level, scope, message, metadata) {
  const prefix = `[reader-sync:${scope}]`;
  if (metadata === void 0) {
    console[level](`${prefix} ${message}`);
  } else {
    console[level](`${prefix} ${message}`, metadata);
  }
  const entry = {
    id: `${Date.now()}-${++logSequence}`,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    scope,
    message,
    location: resolveLocation(),
    userAgent: resolveUserAgent()
  };
  if (metadata !== void 0) {
    entry.metadata = sanitizeMetadata(metadata);
  }
  localLogBuffer.push(entry);
  if (localLogBuffer.length > localLogBufferLimit) {
    localLogBuffer.splice(0, localLogBuffer.length - localLogBufferLimit);
  }
  try {
    logSink?.(entry);
  } catch (error) {
    console.warn(`${prefix} log sink failed`, error);
  }
}
function createLogger(scope) {
  return {
    debug(message, metadata) {
      log("debug", scope, message, metadata);
    },
    info(message, metadata) {
      log("info", scope, message, metadata);
    },
    warn(message, metadata) {
      log("warn", scope, message, metadata);
    },
    error(message, metadata) {
      log("error", scope, message, metadata);
    }
  };
}

// src/shared/protocol.ts
var PLAYER_PORT_NAME = "reader-sync-player";
var CONTENT_PORT_NAME = "reader-sync-content";

// src/shared/zip-writer.ts
var textEncoder = new TextEncoder();
var crc32Table = buildCrc32Table();
function buildCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 3988292384 ^ value >>> 1 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}
function crc32(bytes) {
  let crc = 4294967295;
  for (const byte of bytes) {
    crc = crc32Table[(crc ^ byte) & 255] ^ crc >>> 8;
  }
  return (crc ^ 4294967295) >>> 0;
}
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    date: year - 1980 << 9 | date.getMonth() + 1 << 5 | date.getDate(),
    time: date.getHours() << 11 | date.getMinutes() << 5 | Math.floor(date.getSeconds() / 2)
  };
}
function writeUint16(target, offset, value) {
  target[offset] = value & 255;
  target[offset + 1] = value >>> 8 & 255;
}
function writeUint32(target, offset, value) {
  target[offset] = value & 255;
  target[offset + 1] = value >>> 8 & 255;
  target[offset + 2] = value >>> 16 & 255;
  target[offset + 3] = value >>> 24 & 255;
}
function normalizeZipPath(path) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.\./g, "_").trim();
}
function resolveEntryBytes(entry) {
  if ("bytes" in entry) {
    return entry.bytes;
  }
  return textEncoder.encode(entry.content);
}
function createZipArchive(entries, date = /* @__PURE__ */ new Date()) {
  const chunks = [];
  const centralDirectoryChunks = [];
  const timestamp = dosDateTime(date);
  let offset = 0;
  for (const entry of entries) {
    const fileName = normalizeZipPath(entry.path);
    if (!fileName) {
      continue;
    }
    const fileNameBytes = textEncoder.encode(fileName);
    const contentBytes = resolveEntryBytes(entry);
    const checksum = crc32(contentBytes);
    const localHeader = new Uint8Array(30 + fileNameBytes.length);
    writeUint32(localHeader, 0, 67324752);
    writeUint16(localHeader, 4, 20);
    writeUint16(localHeader, 6, 2048);
    writeUint16(localHeader, 8, 0);
    writeUint16(localHeader, 10, timestamp.time);
    writeUint16(localHeader, 12, timestamp.date);
    writeUint32(localHeader, 14, checksum);
    writeUint32(localHeader, 18, contentBytes.length);
    writeUint32(localHeader, 22, contentBytes.length);
    writeUint16(localHeader, 26, fileNameBytes.length);
    writeUint16(localHeader, 28, 0);
    localHeader.set(fileNameBytes, 30);
    chunks.push(localHeader, contentBytes);
    const centralDirectoryHeader = new Uint8Array(46 + fileNameBytes.length);
    writeUint32(centralDirectoryHeader, 0, 33639248);
    writeUint16(centralDirectoryHeader, 4, 20);
    writeUint16(centralDirectoryHeader, 6, 20);
    writeUint16(centralDirectoryHeader, 8, 2048);
    writeUint16(centralDirectoryHeader, 10, 0);
    writeUint16(centralDirectoryHeader, 12, timestamp.time);
    writeUint16(centralDirectoryHeader, 14, timestamp.date);
    writeUint32(centralDirectoryHeader, 16, checksum);
    writeUint32(centralDirectoryHeader, 20, contentBytes.length);
    writeUint32(centralDirectoryHeader, 24, contentBytes.length);
    writeUint16(centralDirectoryHeader, 28, fileNameBytes.length);
    writeUint16(centralDirectoryHeader, 30, 0);
    writeUint16(centralDirectoryHeader, 32, 0);
    writeUint16(centralDirectoryHeader, 34, 0);
    writeUint16(centralDirectoryHeader, 36, 0);
    writeUint32(centralDirectoryHeader, 38, 0);
    writeUint32(centralDirectoryHeader, 42, offset);
    centralDirectoryHeader.set(fileNameBytes, 46);
    centralDirectoryChunks.push(centralDirectoryHeader);
    offset += localHeader.length + contentBytes.length;
  }
  const centralDirectoryOffset = offset;
  let centralDirectorySize = 0;
  for (const chunk of centralDirectoryChunks) {
    centralDirectorySize += chunk.length;
  }
  const endOfCentralDirectory = new Uint8Array(22);
  writeUint32(endOfCentralDirectory, 0, 101010256);
  writeUint16(endOfCentralDirectory, 4, 0);
  writeUint16(endOfCentralDirectory, 6, 0);
  writeUint16(endOfCentralDirectory, 8, centralDirectoryChunks.length);
  writeUint16(endOfCentralDirectory, 10, centralDirectoryChunks.length);
  writeUint32(endOfCentralDirectory, 12, centralDirectorySize);
  writeUint32(endOfCentralDirectory, 16, centralDirectoryOffset);
  writeUint16(endOfCentralDirectory, 20, 0);
  const totalLength = [...chunks, ...centralDirectoryChunks, endOfCentralDirectory].reduce(
    (sum, chunk) => sum + chunk.length,
    0
  );
  const archive = new Uint8Array(totalLength);
  let writeOffset = 0;
  for (const chunk of [...chunks, ...centralDirectoryChunks, endOfCentralDirectory]) {
    archive.set(chunk, writeOffset);
    writeOffset += chunk.length;
  }
  return archive;
}

// src/background/service-worker.ts
var logger = createLogger("background");
var playerPorts = /* @__PURE__ */ new Set();
var contentPorts = /* @__PURE__ */ new Map();
var contentPortTabIds = /* @__PURE__ */ new WeakMap();
var pageContexts = /* @__PURE__ */ new Map();
var articleSnapshots = /* @__PURE__ */ new Map();
var articleSnapshotErrors = /* @__PURE__ */ new Map();
var feedbackFormUrl = "https://my.feishu.cn/share/base/form/shrcngqXdrdIP1Qzmr02Wq7070b";
var runtimeLogLimit = 2e3;
var runtimeLogs = [];
var preferredTabId = null;
function rememberRuntimeLog(entry) {
  runtimeLogs.push(entry);
  if (runtimeLogs.length > runtimeLogLimit) {
    runtimeLogs.splice(0, runtimeLogs.length - runtimeLogLimit);
  }
}
setReaderSyncLogSink(rememberRuntimeLog);
function wait(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}
function postMessage(port, message) {
  try {
    port.postMessage(message);
    return true;
  } catch (error) {
    logger.warn("Port postMessage failed", error);
    return false;
  }
}
function broadcastToPlayers(message) {
  for (const port of playerPorts) {
    postMessage(port, message);
  }
}
function getKnownReaderTabIds() {
  return Array.from(/* @__PURE__ */ new Set([...pageContexts.keys(), ...articleSnapshots.keys(), ...contentPorts.keys()]));
}
function sanitizeFeedbackFileToken(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "reader-sync-feedback";
}
function formatTimestampForFileName(date = /* @__PURE__ */ new Date()) {
  return date.toISOString().replace(/[:.]/g, "-");
}
function dataUrlToBytes(dataUrl) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.*)$/);
  if (!match) {
    throw new Error("\u622A\u56FE\u8FD4\u56DE\u7684\u6570\u636E\u683C\u5F0F\u4E0D\u53EF\u8BC6\u522B\u3002");
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
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 32768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
function buildRuntimeDiagnostics(description, screenshotIncluded) {
  return {
    exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
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
async function captureActiveTabScreenshot() {
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
async function exportFeedbackBundle(description, includeScreenshot) {
  let screenshotError = null;
  const screenshotEntry = includeScreenshot ? await captureActiveTabScreenshot().catch((error) => {
    screenshotError = error instanceof Error ? error.message : String(error);
    logger.warn("Feedback screenshot capture failed", { error: screenshotError });
    return null;
  }) : null;
  const diagnostics = buildRuntimeDiagnostics(description, screenshotEntry !== null);
  diagnostics.feedback = {
    ...diagnostics.feedback,
    screenshotRequested: includeScreenshot,
    screenshotError
  };
  const logs = [...runtimeLogs];
  const entries = [
    {
      path: "logs/reader-sync-runtime-logs.json",
      content: `${JSON.stringify(logs, null, 2)}
`
    },
    {
      path: "logs/reader-sync-runtime-logs.txt",
      content: `${logs.map((entry) => {
        const metadata = entry.metadata === void 0 ? "" : ` ${JSON.stringify(entry.metadata)}`;
        return `${entry.timestamp} [${entry.level}] [${entry.scope}] ${entry.message}${metadata}`;
      }).join("\n")}
`
    },
    {
      path: "feedback/feedback.json",
      content: `${JSON.stringify(diagnostics, null, 2)}
`
    },
    {
      path: "feedback/feedback.txt",
      content: [
        "Reader Sync \u7528\u6237\u53CD\u9988",
        "",
        `\u5BFC\u51FA\u65F6\u95F4\uFF1A${diagnostics.exportedAt}`,
        `\u63D2\u4EF6\u7248\u672C\uFF1A${chrome.runtime.getManifest().version}`,
        `\u95EE\u9898\u63CF\u8FF0\uFF1A${description.trim() || "\u672A\u586B\u5199"}`,
        `\u5305\u542B\u622A\u56FE\uFF1A${screenshotEntry ? "\u662F" : "\u5426"}`,
        `\u65E5\u5FD7\u6761\u6570\uFF1A${logs.length}`,
        "",
        `\u8BF7\u5728\u98DE\u4E66\u8868\u5355\u7EE7\u7EED\u53CD\u9988\uFF1A${feedbackFormUrl}`
      ].join("\n")
    }
  ];
  if (screenshotEntry) {
    entries.push(screenshotEntry);
  } else if (includeScreenshot && screenshotError) {
    entries.push({
      path: "screenshot/error.txt",
      content: `\u622A\u56FE\u5931\u8D25\uFF1A${screenshotError}
`
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
async function postMessageToReaderTab(tabId, message) {
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
async function tryPostMessageToReaderTab(tabId, message) {
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
function broadcastToContent(message, targetTabId) {
  if (targetTabId !== null) {
    void postMessageToReaderTab(targetTabId, message);
    return;
  }
  for (const tabId of getKnownReaderTabIds()) {
    void postMessageToReaderTab(tabId, message);
  }
}
async function getFallbackAimReadTabId() {
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
function isAimReadArticleUrl(url) {
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
async function collectPageContextFromAllAimReadTabs(options) {
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
function getConnectedReaderTabIds() {
  return Array.from(pageContexts.keys());
}
async function resolveTargetTabId() {
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
async function collectPreferredPageContext(targetTabId) {
  if (targetTabId === null) {
    return;
  }
  await postMessageToReaderTab(targetTabId, { type: "COLLECT_PAGE_CONTEXT" });
}
async function collectPreferredArticleSnapshot(targetTabId) {
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
async function buildConnectedTabsSnapshot() {
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
        };
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
  return snapshots.filter((snapshot) => snapshot !== null).sort((left, right) => {
    if (left.preferred !== right.preferred) {
      return left.preferred ? -1 : 1;
    }
    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }
    return left.tabId - right.tabId;
  });
}
async function pushConnectedTabsSnapshot() {
  const tabs = await buildConnectedTabsSnapshot();
  broadcastToPlayers({
    type: "CONNECTED_TABS_RESPONSE",
    payload: {
      preferredTabId,
      tabs
    }
  });
}
async function refreshConnectedTabsState(port, options) {
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
async function pushActivePageContext(port) {
  const targetTabId = await resolveTargetTabId();
  const message = {
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
async function pushActiveArticleSnapshot(port) {
  const targetTabId = await resolveTargetTabId();
  const message = {
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
function removePort(port) {
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
function resolveContentPortTabId(port) {
  const rememberedTabId = contentPortTabIds.get(port);
  if (typeof rememberedTabId === "number") {
    return rememberedTabId;
  }
  const senderTabId = port.sender?.tab?.id;
  return typeof senderTabId === "number" ? senderTabId : null;
}
async function handlePlayerMessage(port, message) {
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
function handleContentMessage(message, tabId) {
  switch (message.type) {
    case "LOG_ENTRY":
      rememberRuntimeLog(message.payload);
      return;
    case "PAGE_CONTEXT_UPDATE": {
      let shouldRefreshArticleSnapshot = !articleSnapshots.has(tabId);
      if (articleSnapshots.has(tabId)) {
        const existingSnapshot = articleSnapshots.get(tabId);
        if (existingSnapshot && (existingSnapshot.articleId !== null && existingSnapshot.articleId !== message.payload.articleId || existingSnapshot.articleUrl !== message.payload.articleUrl)) {
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
chrome.runtime.onMessage.addListener((rawMessage) => {
  const message = rawMessage;
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
  port.onMessage.addListener((rawMessage) => {
    const message = rawMessage;
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
//# sourceMappingURL=service-worker.js.map
