import { createLogger } from "../shared/logger";
import {
  type AimReadArticleSnapshot,
  CONTENT_PORT_NAME,
  type AimReadPageContext,
  type ConnectedAimReadTab,
  type RuntimeMessage,
  PLAYER_PORT_NAME
} from "../shared/protocol";

const logger = createLogger("background");
const playerPorts = new Set<chrome.runtime.Port>();
const contentPorts = new Map<number, chrome.runtime.Port>();
const contentPortTabIds = new WeakMap<chrome.runtime.Port, number>();
const pageContexts = new Map<number, AimReadPageContext>();
const articleSnapshots = new Map<number, AimReadArticleSnapshot>();
const articleSnapshotErrors = new Map<number, string>();

let preferredTabId: number | null = null;

function postMessage(port: chrome.runtime.Port, message: RuntimeMessage): void {
  try {
    port.postMessage(message);
  } catch (error) {
    logger.warn("Port postMessage failed", error);
  }
}

function broadcastToPlayers(message: RuntimeMessage): void {
  for (const port of playerPorts) {
    postMessage(port, message);
  }
}

function broadcastToContent(message: RuntimeMessage, targetTabId: number | null): void {
  if (targetTabId !== null) {
    const port = contentPorts.get(targetTabId);
    if (port) {
      postMessage(port, message);
    }
    return;
  }

  for (const port of contentPorts.values()) {
    postMessage(port, message);
  }
}

async function getFallbackAimReadTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true,
    url: ["https://aim-read.top/*"]
  });
  return tabs[0]?.id ?? null;
}

async function resolveTargetTabId(): Promise<number | null> {
  if (preferredTabId !== null && contentPorts.has(preferredTabId)) {
    return preferredTabId;
  }

  const fallbackTabId = await getFallbackAimReadTabId();
  if (fallbackTabId !== null && contentPorts.has(fallbackTabId)) {
    preferredTabId = fallbackTabId;
    return fallbackTabId;
  }

  const connectedTabId = contentPorts.keys().next().value;
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
  const contentPort = contentPorts.get(targetTabId);
  if (!contentPort) {
    return;
  }
  postMessage(contentPort, { type: "COLLECT_PAGE_CONTEXT" });
}

async function collectPreferredArticleSnapshot(targetTabId: number | null): Promise<void> {
  if (targetTabId === null) {
    return;
  }
  const contentPort = contentPorts.get(targetTabId);
  if (!contentPort) {
    return;
  }
  postMessage(contentPort, { type: "COLLECT_ARTICLE_SNAPSHOT" });
}

async function buildConnectedTabsSnapshot(): Promise<ConnectedAimReadTab[]> {
  const snapshots = await Promise.all(
    Array.from(contentPorts.keys()).map(async (tabId) => {
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
      pageContexts.delete(tabId);
      articleSnapshots.delete(tabId);
      articleSnapshotErrors.delete(tabId);
      if (preferredTabId === tabId) {
        preferredTabId = null;
      }
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
    case "PLAYER_STATE_UPDATE": {
      const targetTabId = await resolveTargetTabId();
      broadcastToContent(message, targetTabId);
      return;
    }
    case "REQUEST_ACTIVE_PAGE_CONTEXT": {
      const targetTabId = await resolveTargetTabId();
      await collectPreferredPageContext(targetTabId);
      await pushActivePageContext(port);
      return;
    }
    case "REQUEST_ACTIVE_ARTICLE_SNAPSHOT": {
      const targetTabId = await resolveTargetTabId();
      await collectPreferredArticleSnapshot(targetTabId);
      await pushActiveArticleSnapshot(port);
      return;
    }
    case "REQUEST_CONNECTED_TABS": {
      await pushConnectedTabsSnapshot();
      await pushActivePageContext(port);
      await pushActiveArticleSnapshot(port);
      return;
    }
    case "SET_PREFERRED_TAB": {
      preferredTabId = message.payload.tabId;
      await collectPreferredPageContext(preferredTabId);
      await collectPreferredArticleSnapshot(preferredTabId);
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
  if (!contentPorts.has(tabId)) {
    return;
  }
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

chrome.runtime.onConnect.addListener((port) => {
  logger.info("Port connected", { name: port.name });
  if (port.name === PLAYER_PORT_NAME) {
    playerPorts.add(port);
    void pushConnectedTabsSnapshot();
    void pushActivePageContext(port);
    void pushActiveArticleSnapshot(port);
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
