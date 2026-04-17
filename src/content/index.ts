import { createLogger } from "../shared/logger";
import { CONTENT_PORT_NAME, type PlaybackState, type RuntimeMessage } from "../shared/protocol";
import { collectCompleteArticleSnapshot } from "./articleSnapshot";
import { AimReadDomController } from "./aimReadAdapter";

const logger = createLogger("content");
const controller = new AimReadDomController();
const globalWindow = window as Window & { __readerSyncCollectTimer?: number };
const handledKeyboardEvents = new WeakSet<KeyboardEvent>();
const shortcutStorageKey = "reader-sync-shortcut-settings";

interface ShortcutSettings {
  togglePlayback: string;
  seekBackward: string;
  seekForward: string;
  rateDown: string;
  rateUp: string;
  seekSeconds: number;
}

const defaultShortcutSettings: ShortcutSettings = {
  togglePlayback: "Space",
  seekBackward: "ArrowLeft",
  seekForward: "ArrowRight",
  rateDown: "KeyZ",
  rateUp: "KeyX",
  seekSeconds: 5
};

let shortcutSettings: ShortcutSettings = { ...defaultShortcutSettings };
let articleSnapshotInFlight: Promise<void> | null = null;
let lastCollectedArticleUrl: string | null = null;
let lastArticleSnapshotAttemptAt = 0;
let lastPageContextParagraphIndexes: number[] = [];
let lastPageContextSignature: string | null = null;
let paragraphRevealInFlight: Promise<void> | null = null;
let pendingRevealParagraphIndex: number | null = null;
let lastPlayerState: PlaybackState = "idle";
let contentPort: chrome.runtime.Port | null = null;
let contentPortReconnectTimer: number | null = null;
let contentPageUnloading = false;

function clearContentPortReconnectTimer(): void {
  if (contentPortReconnectTimer !== null) {
    window.clearTimeout(contentPortReconnectTimer);
    contentPortReconnectTimer = null;
  }
}

function scheduleContentPortReconnect(delayMs = 280): void {
  if (contentPortReconnectTimer !== null || contentPageUnloading) {
    return;
  }
  contentPortReconnectTimer = window.setTimeout(() => {
    contentPortReconnectTimer = null;
    connectContentPort();
  }, delayMs);
}

function handleContentPortDisconnect(disconnectedPort: chrome.runtime.Port): void {
  if (contentPort !== disconnectedPort) {
    return;
  }
  contentPort = null;
  if (contentPageUnloading) {
    return;
  }
  logger.warn("Content port disconnected, scheduling reconnect");
  scheduleContentPortReconnect();
}

function connectContentPort(): chrome.runtime.Port {
  if (contentPort) {
    return contentPort;
  }
  clearContentPortReconnectTimer();
  const nextPort = chrome.runtime.connect({ name: CONTENT_PORT_NAME });
  logger.info("Content port connected");
  contentPort = nextPort;
  nextPort.onMessage.addListener(handleRuntimeMessage);
  nextPort.onDisconnect.addListener(() => {
    handleContentPortDisconnect(nextPort);
  });
  window.setTimeout(() => {
    collectAndSendPageContext();
  }, 0);
  return nextPort;
}

function postRuntimeMessage(message: RuntimeMessage, options?: { retry?: boolean }): boolean {
  const retry = options?.retry !== false;
  const targetPort = connectContentPort();

  try {
    targetPort.postMessage(message);
    return true;
  } catch (error) {
    logger.warn("Content port postMessage failed", { type: message.type, error });
    if (contentPort === targetPort) {
      contentPort = null;
    }
    scheduleContentPortReconnect();
    if (!retry) {
      return false;
    }

    try {
      const retriedPort = connectContentPort();
      retriedPort.postMessage(message);
      return true;
    } catch (retryError) {
      logger.warn("Content port retry postMessage failed", { type: message.type, error: retryError });
      scheduleContentPortReconnect(420);
      return false;
    }
  }
}

function isExtensionOwnedNode(node: Node | null): boolean {
  if (!node) {
    return false;
  }

  const element =
    node instanceof Element
      ? node
      : node.parentElement;

  if (!element) {
    return false;
  }

  if (element.id === "reader-sync-style" || element.id === "reader-sync-status-overlay") {
    return true;
  }

  return Boolean(element.closest("#reader-sync-status-overlay, #reader-sync-style, .reader-sync-debug"));
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function normalizeKeyboardKey(value: string): string {
  return value.trim().toLowerCase();
}

function matchesKeyboardShortcut(event: KeyboardEvent, code: string, keys: string[]): boolean {
  if (event.code === code) {
    return true;
  }
  const normalizedEventKey = normalizeKeyboardKey(event.key);
  return keys.some((key) => normalizeKeyboardKey(key) === normalizedEventKey);
}

function matchesConfiguredShortcut(event: KeyboardEvent, configuredValue: string): boolean {
  const normalizedConfiguredValue = configuredValue.trim();
  if (!normalizedConfiguredValue) {
    return false;
  }
  if (event.code === normalizedConfiguredValue) {
    return true;
  }
  const normalizedEventKey = normalizeKeyboardKey(event.key);
  if (normalizeKeyboardKey(normalizedConfiguredValue) === normalizedEventKey) {
    return true;
  }
  if (normalizedConfiguredValue.toLowerCase().startsWith("key") && normalizedConfiguredValue.length === 4) {
    return normalizedEventKey === normalizedConfiguredValue.slice(3).toLowerCase();
  }
  return false;
}

function sanitizeShortcutSettings(rawValue: unknown): ShortcutSettings {
  if (typeof rawValue !== "object" || rawValue === null) {
    return { ...defaultShortcutSettings };
  }
  const asRecord = rawValue as Record<string, unknown>;
  const parsedSeekSeconds = Number.parseInt(String(asRecord.seekSeconds ?? defaultShortcutSettings.seekSeconds), 10);
  return {
    togglePlayback: String(asRecord.togglePlayback ?? defaultShortcutSettings.togglePlayback).trim() || defaultShortcutSettings.togglePlayback,
    seekBackward: String(asRecord.seekBackward ?? defaultShortcutSettings.seekBackward).trim() || defaultShortcutSettings.seekBackward,
    seekForward: String(asRecord.seekForward ?? defaultShortcutSettings.seekForward).trim() || defaultShortcutSettings.seekForward,
    rateDown: String(asRecord.rateDown ?? defaultShortcutSettings.rateDown).trim() || defaultShortcutSettings.rateDown,
    rateUp: String(asRecord.rateUp ?? defaultShortcutSettings.rateUp).trim() || defaultShortcutSettings.rateUp,
    seekSeconds: Number.isFinite(parsedSeekSeconds) ? Math.min(Math.max(parsedSeekSeconds, 1), 60) : defaultShortcutSettings.seekSeconds
  };
}

async function loadShortcutSettings(): Promise<void> {
  const stored = await chrome.storage.local.get(shortcutStorageKey);
  shortcutSettings = sanitizeShortcutSettings(stored[shortcutStorageKey]);
}

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

function isParagraphIndexVisible(paragraphIndex: number): boolean {
  return Boolean(
    document.querySelector(`[data-reader-sync-paragraph-index="${String(paragraphIndex)}"]`) ??
      document.querySelector(`[data-paragraph-trigger="${String(paragraphIndex)}"]`)
  );
}

function resolveVisibleParagraphRange(): { minimum: number; maximum: number } | null {
  if (lastPageContextParagraphIndexes.length === 0) {
    return null;
  }

  return {
    minimum: lastPageContextParagraphIndexes[0],
    maximum: lastPageContextParagraphIndexes[lastPageContextParagraphIndexes.length - 1]
  };
}

function collectAndSendPageContext(): void {
  const pageContext = controller.collectPageContext();
  if (!pageContext) {
    logger.debug("No aim-read article context detected on current page");
    lastPageContextSignature = null;
    lastPageContextParagraphIndexes = [];
    return;
  }
  const contextSignature = JSON.stringify({
    articleUrl: pageContext.articleUrl,
    articleId: pageContext.articleId,
    categoryId: pageContext.categoryId,
    title: pageContext.title,
    paragraphIndexes: pageContext.paragraphs.map((paragraph) => paragraph.paragraphIndex),
    paragraphCount: pageContext.paragraphs.length
  });
  lastPageContextParagraphIndexes = pageContext.paragraphs
    .map((paragraph) => paragraph.paragraphIndex)
    .sort((left, right) => left - right);
  controller.bindParagraphClicks();
  if (contextSignature === lastPageContextSignature) {
    return;
  }
  lastPageContextSignature = contextSignature;
  postRuntimeMessage({
    type: "PAGE_CONTEXT_UPDATE",
    payload: pageContext
  } satisfies RuntimeMessage);
  void ensureArticleSnapshotCollection(pageContext.articleUrl);
}

function scheduleCollect(delayMs = 350): void {
  window.clearTimeout(globalWindow.__readerSyncCollectTimer);
  globalWindow.__readerSyncCollectTimer = window.setTimeout(() => {
    collectAndSendPageContext();
  }, delayMs);
}

async function collectAndSendArticleSnapshot(articleUrl: string): Promise<void> {
  logger.info("Starting full article snapshot collection", { articleUrl });
  try {
    const articleSnapshot = await collectCompleteArticleSnapshot();
    lastCollectedArticleUrl = articleUrl;
    logger.info("Collected full article snapshot", {
      articleUrl,
      articleId: articleSnapshot.articleId,
      paragraphCount: articleSnapshot.paragraphs.length,
      totalPages: articleSnapshot.pageInfo?.totalPages ?? null
    });
    postRuntimeMessage({
      type: "ARTICLE_SNAPSHOT_UPDATE",
      payload: articleSnapshot
    } satisfies RuntimeMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("当前页面不是可识别的 aim-read 剧集文章页")) {
      logger.debug("Skipping article snapshot collection on non-reader page", { articleUrl });
      return;
    }
    logger.warn("Failed to collect full article snapshot", { message });
    postRuntimeMessage({
      type: "ARTICLE_SNAPSHOT_ERROR",
      payload: { message }
    } satisfies RuntimeMessage);
  }
}

function ensureArticleSnapshotCollection(articleUrl: string, options?: { force?: boolean }): Promise<void> {
  const force = options?.force === true;
  const now = Date.now();

  if (!force && lastCollectedArticleUrl === articleUrl) {
    logger.debug("Skipping article snapshot collection because article was already collected", { articleUrl });
    return Promise.resolve();
  }

  if (articleSnapshotInFlight) {
    logger.debug("Reusing in-flight article snapshot collection", { articleUrl, force });
    return articleSnapshotInFlight;
  }

  if (!force && now - lastArticleSnapshotAttemptAt < 1200) {
    logger.debug("Skipping article snapshot collection because of throttle window", { articleUrl, force });
    return Promise.resolve();
  }

  lastArticleSnapshotAttemptAt = now;
  articleSnapshotInFlight = collectAndSendArticleSnapshot(articleUrl)
    .catch((error) => {
      logger.warn("Article snapshot collection failed", {
        message: error instanceof Error ? error.message : String(error)
      });
    })
    .finally(() => {
      articleSnapshotInFlight = null;
    });

  return articleSnapshotInFlight;
}

async function ensureParagraphVisible(paragraphIndex: number): Promise<void> {
  if (isParagraphIndexVisible(paragraphIndex)) {
    collectAndSendPageContext();
    controller.applyPlayerState(paragraphIndex, lastPlayerState);
    return;
  }

  if (paragraphRevealInFlight && pendingRevealParagraphIndex === paragraphIndex) {
    return paragraphRevealInFlight;
  }

  pendingRevealParagraphIndex = paragraphIndex;
  paragraphRevealInFlight = (async () => {
    const visibleRange = resolveVisibleParagraphRange();
    if (!visibleRange) {
      collectAndSendPageContext();
    }

    const currentRange = resolveVisibleParagraphRange();
    const direction =
      currentRange === null
        ? 0
        : paragraphIndex > currentRange.maximum
          ? 1
          : paragraphIndex < currentRange.minimum
            ? -1
            : 0;

    if (direction === 0) {
      collectAndSendPageContext();
      controller.applyPlayerState(paragraphIndex, lastPlayerState);
      return;
    }

    const stepPx = Math.max(Math.round(window.innerHeight * 0.82), 480);
    let stalledRounds = 0;
    let previousScrollY = window.scrollY;

    for (let attempt = 0; attempt < 18; attempt += 1) {
      if (isParagraphIndexVisible(paragraphIndex)) {
        break;
      }

      const nextTop =
        direction > 0
          ? window.scrollY + stepPx
          : Math.max(0, window.scrollY - stepPx);
      if (Math.abs(nextTop - window.scrollY) < 4) {
        break;
      }

      window.scrollTo({ top: nextTop, behavior: "auto" });
      await wait(260);
      collectAndSendPageContext();

      if (Math.abs(window.scrollY - previousScrollY) < 4) {
        stalledRounds += 1;
      } else {
        stalledRounds = 0;
      }
      previousScrollY = window.scrollY;

      if (stalledRounds >= 2) {
        break;
      }
    }

    collectAndSendPageContext();
    controller.applyPlayerState(paragraphIndex, lastPlayerState);
  })()
    .finally(() => {
      paragraphRevealInFlight = null;
      pendingRevealParagraphIndex = null;
    });

  return paragraphRevealInFlight;
}

controller.onParagraphClick((paragraphIndex) => {
  postRuntimeMessage({
    type: "PAGE_PARAGRAPH_CLICKED",
    payload: { paragraphIndex }
  } satisfies RuntimeMessage);
});

function handleRuntimeMessage(message: RuntimeMessage): void {
  switch (message.type) {
    case "COLLECT_ARTICLE_SNAPSHOT": {
      const pageContext = controller.collectPageContext();
      if (!pageContext) {
        logger.debug("Ignoring COLLECT_ARTICLE_SNAPSHOT because page context is unavailable");
        return;
      }
      logger.info("Received COLLECT_ARTICLE_SNAPSHOT", {
        articleUrl: pageContext.articleUrl,
        articleId: pageContext.articleId,
        categoryId: pageContext.categoryId
      });
      void ensureArticleSnapshotCollection(pageContext.articleUrl, { force: true });
      return;
    }
    case "COLLECT_PAGE_CONTEXT":
      collectAndSendPageContext();
      return;
    case "PLAYER_STATE_UPDATE":
      lastPlayerState = message.payload.state;
      controller.applyPlayerState(message.payload.activeParagraphIndex, message.payload.state);
      if (
        typeof message.payload.activeParagraphIndex === "number" &&
        !isParagraphIndexVisible(message.payload.activeParagraphIndex)
      ) {
        void ensureParagraphVisible(message.payload.activeParagraphIndex);
      }
      return;
    default:
      return;
  }
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  handleRuntimeMessage(message as RuntimeMessage);
});

const observer = new MutationObserver((mutations) => {
  const hasRelevantMutation = mutations.some((mutation) => {
    if (!isExtensionOwnedNode(mutation.target)) {
      return true;
    }

    return [...mutation.addedNodes, ...mutation.removedNodes].some((node) => !isExtensionOwnedNode(node));
  });

  if (!hasRelevantMutation) {
    return;
  }

  scheduleCollect();
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true
});

window.addEventListener("load", () => {
  collectAndSendPageContext();
});

window.addEventListener("scroll", () => {
  scheduleCollect(180);
}, { passive: true });

window.addEventListener("resize", () => {
  scheduleCollect(180);
});

function handleReaderPageKeyboardShortcut(event: KeyboardEvent): void {
  if (handledKeyboardEvents.has(event)) {
    return;
  }
  const targetNode = event.target instanceof Node ? event.target : null;
  if (
    isExtensionOwnedNode(targetNode) ||
    isEditableTarget(event.target) ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    event.isComposing
  ) {
    return;
  }

  if (matchesConfiguredShortcut(event, shortcutSettings.togglePlayback)) {
    handledKeyboardEvents.add(event);
    event.preventDefault();
    postRuntimeMessage({
      type: "PLAYER_CONTROL_COMMAND",
      payload: {
        command: "toggle_playback",
        source: "reader-page"
      }
    } satisfies RuntimeMessage);
    return;
  }

  if (matchesConfiguredShortcut(event, shortcutSettings.seekBackward)) {
    handledKeyboardEvents.add(event);
    event.preventDefault();
    postRuntimeMessage({
      type: "PLAYER_CONTROL_COMMAND",
      payload: {
        command: "seek_by",
        deltaMs: -(shortcutSettings.seekSeconds * 1000),
        source: "reader-page"
      }
    } satisfies RuntimeMessage);
    return;
  }

  if (matchesConfiguredShortcut(event, shortcutSettings.seekForward)) {
    handledKeyboardEvents.add(event);
    event.preventDefault();
    postRuntimeMessage({
      type: "PLAYER_CONTROL_COMMAND",
      payload: {
        command: "seek_by",
        deltaMs: shortcutSettings.seekSeconds * 1000,
        source: "reader-page"
      }
    } satisfies RuntimeMessage);
    return;
  }

  if (matchesConfiguredShortcut(event, shortcutSettings.rateDown)) {
    handledKeyboardEvents.add(event);
    event.preventDefault();
    postRuntimeMessage({
      type: "PLAYER_CONTROL_COMMAND",
      payload: {
        command: "step_playback_rate",
        step: -1,
        source: "reader-page"
      }
    } satisfies RuntimeMessage);
    return;
  }

  if (matchesConfiguredShortcut(event, shortcutSettings.rateUp)) {
    handledKeyboardEvents.add(event);
    event.preventDefault();
    postRuntimeMessage({
      type: "PLAYER_CONTROL_COMMAND",
      payload: {
        command: "step_playback_rate",
        step: 1,
        source: "reader-page"
      }
    } satisfies RuntimeMessage);
    return;
  }
}

window.addEventListener("keydown", handleReaderPageKeyboardShortcut, { capture: true });
document.addEventListener("keydown", handleReaderPageKeyboardShortcut, { capture: true });
window.addEventListener("beforeunload", () => {
  contentPageUnloading = true;
  clearContentPortReconnectTimer();
  contentPort?.disconnect();
});

void loadShortcutSettings();
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !(shortcutStorageKey in changes)) {
    return;
  }
  shortcutSettings = sanitizeShortcutSettings(changes[shortcutStorageKey]?.newValue);
});

connectContentPort();
collectAndSendPageContext();
