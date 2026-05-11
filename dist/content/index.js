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
var CONTENT_PORT_NAME = "reader-sync-content";

// src/content/articleSnapshot.ts
var logger = createLogger("article-snapshot");
var ARTICLE_API_REQUEST_TIMEOUT_MS = 8e3;
var ARTICLE_API_PAGE_SIZE_STRATEGIES = [500, 200, 100];
function parseNumericQueryParameter(name) {
  const value = new URL(window.location.href).searchParams.get(name);
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
function resolveArticleIdFromUrl() {
  const match = window.location.pathname.match(/\/daily-feed\/(\d+)/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}
function isNonArticlePageError(error) {
  return error instanceof Error && error.message.includes("\u5F53\u524D\u9875\u9762\u4E0D\u662F\u53EF\u8BC6\u522B\u7684 aim-read \u5267\u96C6\u6587\u7AE0\u9875");
}
function isObject(value) {
  return typeof value === "object" && value !== null;
}
function asString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
function asNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
function looksLikeArticlePayload(value) {
  if (!isObject(value)) {
    return false;
  }
  return Array.isArray(value.paragraphs) || isObject(value.pageInfo) || isObject(value.articleInfo);
}
function unwrapArticleApiPayload(rawValue) {
  if (!isObject(rawValue)) {
    throw new Error("\u6587\u7AE0\u63A5\u53E3\u8FD4\u56DE\u7ED3\u6784\u65E0\u6548\u3002");
  }
  if (looksLikeArticlePayload(rawValue)) {
    return rawValue;
  }
  const envelope = rawValue;
  if (typeof envelope.code === "number" && envelope.code !== 200) {
    throw new Error(asString(envelope.msg) ?? `\u6587\u7AE0\u63A5\u53E3\u8BF7\u6C42\u5931\u8D25 (code ${envelope.code})`);
  }
  if (looksLikeArticlePayload(envelope.data)) {
    return envelope.data;
  }
  throw new Error("\u6587\u7AE0\u63A5\u53E3\u8FD4\u56DE\u7ED3\u6784\u65E0\u6548\u3002");
}
function normalizeParagraph(rawParagraph, currentPage) {
  if (!isObject(rawParagraph)) {
    return null;
  }
  const paragraphIndex = asNumber(rawParagraph.paragraphIndex);
  const text = asString(rawParagraph.content) ?? asString(rawParagraph.text);
  if (paragraphIndex === null || !text) {
    return null;
  }
  const translation = asString(rawParagraph.translation);
  const contentPage = asNumber(rawParagraph.contentPage) ?? currentPage ?? void 0;
  return {
    paragraphIndex,
    text,
    translation: translation ?? void 0,
    contentPage
  };
}
async function fetchArticlePage(articleId, page, pageSize) {
  const endpoint = `/api/articles/${articleId}/content/page?page=${page}&pageSize=${pageSize}`;
  const controller2 = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller2.abort();
  }, ARTICLE_API_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(endpoint, {
      credentials: "include",
      headers: {
        accept: "application/json"
      },
      signal: controller2.signal
    });
  } catch (error) {
    if (controller2.signal.aborted) {
      throw new Error(`\u6587\u7AE0\u63A5\u53E3\u8BF7\u6C42\u8D85\u65F6 (${ARTICLE_API_REQUEST_TIMEOUT_MS}ms)`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
  if (!response.ok) {
    throw new Error(`\u6587\u7AE0\u63A5\u53E3\u8BF7\u6C42\u5931\u8D25 (${response.status})`);
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("\u6587\u7AE0\u63A5\u53E3\u8FD4\u56DE\u4E86\u975E JSON \u5185\u5BB9\uFF0C\u767B\u5F55\u6001\u53EF\u80FD\u5DF2\u5931\u6548\u3002");
  }
  return unwrapArticleApiPayload(await response.json());
}
async function collectArticleSnapshotFromApiWithPageSize(articleId, categoryId, pageSize) {
  const paragraphsByIndex = /* @__PURE__ */ new Map();
  let title = null;
  let totalPages = null;
  let totalElements = null;
  let currentPage = 1;
  let hasNext = true;
  logger.info("Starting article snapshot collection from API", {
    articleId,
    categoryId,
    articleUrl: window.location.href,
    pageSize
  });
  while (hasNext) {
    logger.info("Fetching article snapshot page", {
      articleId,
      currentPage,
      pageSize
    });
    const payload = await fetchArticlePage(articleId, currentPage, pageSize);
    const pageInfo = isObject(payload.pageInfo) ? payload.pageInfo : null;
    const pageNumber = asNumber(pageInfo?.currentPage) ?? currentPage;
    const normalizedParagraphs = Array.isArray(payload.paragraphs) ? payload.paragraphs.map((paragraph) => normalizeParagraph(paragraph, pageNumber)).filter((paragraph) => paragraph !== null) : [];
    for (const paragraph of normalizedParagraphs) {
      paragraphsByIndex.set(paragraph.paragraphIndex, paragraph);
    }
    title = title ?? (isObject(payload.articleInfo) ? asString(payload.articleInfo.titleEn) ?? asString(payload.articleInfo.title) : null) ?? document.title;
    totalPages = totalPages ?? asNumber(pageInfo?.totalPages);
    totalElements = totalElements ?? asNumber(pageInfo?.totalElements);
    logger.info("Fetched article snapshot page", {
      articleId,
      currentPage: pageNumber,
      paragraphCount: normalizedParagraphs.length,
      totalPages,
      totalElements
    });
    if (totalPages !== null && currentPage >= totalPages) {
      hasNext = false;
    } else if (typeof pageInfo?.hasNext === "boolean") {
      hasNext = pageInfo.hasNext;
    } else {
      hasNext = normalizedParagraphs.length >= pageSize;
    }
    currentPage += 1;
    if (currentPage > 200) {
      throw new Error("\u6587\u7AE0\u5206\u9875\u6570\u91CF\u5F02\u5E38\uFF0C\u5DF2\u505C\u6B62\u6293\u53D6\u3002");
    }
  }
  const paragraphs = Array.from(paragraphsByIndex.values()).sort((left, right) => left.paragraphIndex - right.paragraphIndex);
  if (paragraphs.length === 0) {
    throw new Error("\u6587\u7AE0\u63A5\u53E3\u8FD4\u56DE\u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u6784\u5EFA\u5B8C\u6574\u6BB5\u843D\u5FEB\u7167\u3002");
  }
  logger.info("Collected article snapshot from API", {
    articleId,
    paragraphCount: paragraphs.length,
    totalPages,
    totalElements: totalElements ?? paragraphs.length
  });
  return {
    articleUrl: window.location.href,
    articleId,
    categoryId,
    title: title ?? document.title,
    capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
    paragraphCount: totalElements ?? paragraphs.length,
    paragraphs,
    pageInfo: {
      totalPages,
      pageSize,
      totalElements: totalElements ?? paragraphs.length
    }
  };
}
async function collectArticleSnapshotFromApi() {
  const articleId = resolveArticleIdFromUrl();
  if (articleId === null) {
    throw new Error("\u5F53\u524D\u9875\u9762\u4E0D\u662F\u53EF\u8BC6\u522B\u7684 aim-read \u5267\u96C6\u6587\u7AE0\u9875\u3002");
  }
  const categoryId = parseNumericQueryParameter("categoryId");
  const failures = [];
  for (const pageSize of ARTICLE_API_PAGE_SIZE_STRATEGIES) {
    try {
      logger.info("Trying article snapshot API strategy", {
        articleId,
        categoryId,
        articleUrl: window.location.href,
        pageSize
      });
      return await collectArticleSnapshotFromApiWithPageSize(articleId, categoryId, pageSize);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`pageSize=${pageSize}: ${message}`);
      logger.warn("Article snapshot API strategy failed", {
        articleId,
        categoryId,
        pageSize,
        message
      });
    }
  }
  throw new Error(`\u6587\u7AE0\u63A5\u53E3\u6293\u53D6\u5931\u8D25\uFF1A${failures.join(" | ")}`);
}
function findArticleRoot() {
  return document.querySelector("main article") ?? document.querySelector("article");
}
function extractVisibleText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const chunks = [];
  let currentNode = walker.nextNode();
  while (currentNode) {
    const parentElement = currentNode.parentElement;
    if (parentElement && !parentElement.closest("button, script, style, [aria-hidden='true'], .reader-sync-debug")) {
      const text = currentNode.textContent?.replace(/\s+/g, " ").trim();
      if (text) {
        chunks.push(text);
      }
    }
    currentNode = walker.nextNode();
  }
  return chunks.join(" ").replace(/\s+/g, " ").trim();
}
function findParagraphContainers(articleRoot) {
  const containers = [];
  const seen = /* @__PURE__ */ new Set();
  const triggerButtons = Array.from(articleRoot.querySelectorAll("[data-paragraph-trigger]"));
  for (const triggerButton of triggerButtons) {
    let current = triggerButton.parentElement;
    let bestMatch = null;
    while (current && current !== articleRoot) {
      const paragraphTriggerCount = current.querySelectorAll("[data-paragraph-trigger]").length;
      const text = extractVisibleText(current);
      const hasParagraphText = text.length > 0;
      if (paragraphTriggerCount === 1 && hasParagraphText) {
        bestMatch = current;
      }
      if (paragraphTriggerCount > 1 && bestMatch) {
        break;
      }
      current = current.parentElement;
    }
    const container = bestMatch ?? triggerButton.parentElement;
    if (container && !seen.has(container)) {
      seen.add(container);
      containers.push(container);
    }
  }
  return containers.sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
}
function collectVisibleParagraphsFromDom() {
  const articleRoot = findArticleRoot();
  if (!articleRoot) {
    return [];
  }
  const collectedParagraphs = findParagraphContainers(articleRoot).map((container, index) => {
    const triggerButton = container.querySelector("[data-paragraph-trigger]");
    const rawParagraphIndex = triggerButton?.getAttribute("data-paragraph-trigger");
    const paragraphIndex = rawParagraphIndex ? Number.parseInt(rawParagraphIndex, 10) : index + 1;
    if (!Number.isFinite(paragraphIndex)) {
      return null;
    }
    const text = extractVisibleText(container);
    if (!text) {
      return null;
    }
    return {
      paragraphIndex,
      text,
      contentPage: (() => {
        const pageContainer = container.closest("[data-content-page]");
        const rawPage = pageContainer?.getAttribute("data-content-page");
        const parsed = rawPage ? Number.parseInt(rawPage, 10) : Number.NaN;
        return Number.isFinite(parsed) ? parsed : void 0;
      })()
    };
  });
  return collectedParagraphs.filter((paragraph) => paragraph !== null);
}
async function wait(delayMs) {
  await new Promise((resolve) => window.setTimeout(resolve, delayMs));
}
async function collectArticleSnapshotByAutoScroll() {
  const articleId = resolveArticleIdFromUrl();
  if (articleId === null) {
    throw new Error("\u5F53\u524D\u9875\u9762\u4E0D\u662F\u53EF\u8BC6\u522B\u7684 aim-read \u5267\u96C6\u6587\u7AE0\u9875\u3002");
  }
  const titleElement = document.querySelector("[data-article-title]") ?? document.querySelector("main article h1") ?? document.querySelector("article h1");
  const title = titleElement?.textContent?.trim() ?? document.title;
  const categoryId = parseNumericQueryParameter("categoryId");
  const mergedParagraphs = /* @__PURE__ */ new Map();
  const startScrollY = window.scrollY;
  let stableRounds = 0;
  let previousCount = 0;
  logger.info("Starting article snapshot collection by auto scroll", {
    articleId,
    categoryId,
    articleUrl: window.location.href
  });
  try {
    for (let round = 0; round < 24; round += 1) {
      const visibleParagraphs = collectVisibleParagraphsFromDom();
      for (const paragraph of visibleParagraphs) {
        mergedParagraphs.set(paragraph.paragraphIndex, paragraph);
      }
      const currentCount = mergedParagraphs.size;
      if (currentCount === previousCount) {
        stableRounds += 1;
      } else {
        stableRounds = 0;
        previousCount = currentCount;
      }
      const sentinel = Array.from(document.querySelectorAll("body *")).find((element) => (element.textContent ?? "").includes("\u6EDA\u52A8\u4EE5\u52A0\u8F7D\u66F4\u591A\u5185\u5BB9"));
      const hasMoreHint = Boolean(sentinel);
      if (!hasMoreHint && stableRounds >= 1) {
        break;
      }
      if (stableRounds >= 2) {
        break;
      }
      window.scrollTo({
        top: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight),
        behavior: "auto"
      });
      await wait(700);
    }
  } finally {
    window.scrollTo({ top: startScrollY, behavior: "auto" });
  }
  const paragraphs = Array.from(mergedParagraphs.values()).sort((left, right) => left.paragraphIndex - right.paragraphIndex);
  if (paragraphs.length === 0) {
    throw new Error("\u61D2\u52A0\u8F7D\u8865\u9F50\u5931\u8D25\uFF0C\u6CA1\u6709\u6293\u5230\u53EF\u7528\u6BB5\u843D\u3002");
  }
  logger.info("Collected article snapshot by auto scroll", {
    articleId,
    paragraphCount: paragraphs.length
  });
  return {
    articleUrl: window.location.href,
    articleId,
    categoryId,
    title,
    capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
    paragraphCount: paragraphs.length,
    paragraphs
  };
}
async function collectCompleteArticleSnapshot() {
  try {
    return await collectArticleSnapshotFromApi();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (isNonArticlePageError(error)) {
      logger.debug("Skipping article snapshot API collection on non-reader page", {
        articleUrl: window.location.href
      });
    } else {
      logger.warn(`Article snapshot API collection failed, falling back to auto scroll: ${message}`);
    }
    return collectArticleSnapshotByAutoScroll();
  }
}

// src/shared/theme.ts
var playerThemeStorageKey = "reader-sync-player-theme";
function sanitizeReaderSyncThemeMode(value) {
  return value === "light" || value === "dark" || value === "auto" ? value : "auto";
}
function resolveReaderSyncThemeMode(mode, prefersDark) {
  if (mode === "auto") {
    return prefersDark ? "dark" : "light";
  }
  return mode;
}

// src/content/aimReadAdapter.ts
var MARKER_ATTRIBUTE = "data-reader-sync-paragraph-index";
var STYLE_ELEMENT_ID = "reader-sync-style";
var STATUS_OVERLAY_ID = "reader-sync-status-overlay";
var OVERLAY_MODE_STORAGE_KEY = "reader-sync-reader-overlay-mode";
var ANALYSIS_TRIGGER_LABEL = "\u6BB5\u843D\u89E3\u6790";
var ANALYSIS_EMPTY_HINT = "\u70B9\u51FB\u6BB5\u843D\u5DE6\u4FA7 Sparkle \u67E5\u770B\u53E5\u5B50\u89E3\u6790";
function parseNumericQueryParameter2(name) {
  const value = new URL(window.location.href).searchParams.get(name);
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
function extractVisibleText2(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const chunks = [];
  let currentNode = walker.nextNode();
  while (currentNode) {
    const parentElement = currentNode.parentElement;
    if (parentElement && !parentElement.closest("button, script, style, [aria-hidden='true'], .reader-sync-debug")) {
      const text = currentNode.textContent?.replace(/\s+/g, " ").trim();
      if (text) {
        chunks.push(text);
      }
    }
    currentNode = walker.nextNode();
  }
  return chunks.join(" ").replace(/\s+/g, " ").trim();
}
function buildDomPath(element) {
  const steps = [];
  let current = element;
  while (current && current !== document.body) {
    const parent = current.parentElement;
    if (!parent) {
      break;
    }
    const siblings = Array.from(parent.children).filter(
      (child) => child.tagName === current?.tagName
    );
    const siblingIndex = siblings.indexOf(current) + 1;
    steps.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblingIndex})`);
    current = parent;
  }
  return steps.join(" > ");
}
function findArticleRoot2() {
  return document.querySelector("main article") ?? document.querySelector("article");
}
function findParagraphContainers2(articleRoot) {
  const containers = [];
  const seen = /* @__PURE__ */ new Set();
  const triggerButtons = Array.from(
    articleRoot.querySelectorAll("[data-paragraph-trigger]")
  );
  for (const triggerButton of triggerButtons) {
    let current = triggerButton.parentElement;
    let bestMatch = null;
    while (current && current !== articleRoot) {
      const paragraphTriggerCount = current.querySelectorAll("[data-paragraph-trigger]").length;
      const text = extractVisibleText2(current);
      const hasParagraphText = text.length > 0;
      if (paragraphTriggerCount === 1 && hasParagraphText) {
        bestMatch = current;
      }
      if (paragraphTriggerCount > 1 && bestMatch) {
        break;
      }
      current = current.parentElement;
    }
    const container = bestMatch ?? triggerButton.parentElement;
    if (container && !seen.has(container)) {
      seen.add(container);
      containers.push(container);
    }
  }
  return containers.sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top);
}
function resolveParagraphIndex(container, fallbackIndex) {
  const triggerButton = container.querySelector("[data-paragraph-trigger]");
  const rawValue = triggerButton?.getAttribute("data-paragraph-trigger");
  if (rawValue) {
    const parsed = Number.parseInt(rawValue, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallbackIndex + 1;
}
function resolveContentPage(container) {
  const pageContainer = container.closest("[data-content-page]");
  const rawValue = pageContainer?.getAttribute("data-content-page");
  if (!rawValue) {
    return void 0;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) ? parsed : void 0;
}
function truncateText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}\u2026`;
}
function playbackStateLabel(state) {
  switch (state) {
    case "playing":
      return "\u64AD\u653E\u4E2D";
    case "paused":
      return "\u5DF2\u6682\u505C";
    case "loading":
      return "\u8F7D\u5165\u4E2D";
    case "ended":
      return "\u5DF2\u7ED3\u675F";
    case "error":
      return "\u5F02\u5E38";
    default:
      return "\u7B49\u5F85\u8FDE\u63A5";
  }
}
function sanitizeOverlayMode(rawValue) {
  return rawValue === "docked" ? "docked" : "expanded";
}
function ensureStyle() {
  if (document.getElementById(STYLE_ELEMENT_ID)) {
    return;
  }
  const styleElement = document.createElement("style");
  styleElement.id = STYLE_ELEMENT_ID;
  styleElement.textContent = `
    #${STATUS_OVERLAY_ID} {
      --rs-accent: #c96442;
      --rs-surface: rgba(255, 253, 247, 0.94);
      --rs-ink: #2a2620;
      --rs-ink-muted: rgba(42, 38, 32, 0.7);
      --rs-line: rgba(42, 38, 32, 0.1);
      --rs-shadow: 0 16px 40px rgba(20, 14, 8, 0.16);
      --rs-dot-idle: #9a968c;
      --rs-dot-idle-halo: rgba(154, 150, 140, 0.18);
    }

    #${STATUS_OVERLAY_ID}[data-theme="dark"] {
      --rs-surface: rgba(30, 28, 24, 0.94);
      --rs-ink: #f0e9dc;
      --rs-ink-muted: rgba(240, 233, 220, 0.72);
      --rs-line: rgba(255, 248, 236, 0.12);
      --rs-shadow: 0 16px 40px rgba(0, 0, 0, 0.48);
      --rs-dot-idle: #7a746a;
      --rs-dot-idle-halo: rgba(122, 116, 106, 0.24);
    }

    [${MARKER_ATTRIBUTE}] {
      position: relative;
      transition: background-color 160ms ease, box-shadow 160ms ease;
      scroll-margin-block: 12vh;
    }

    [${MARKER_ATTRIBUTE}].reader-sync-active {
      background: rgba(201, 100, 66, 0.12);
      box-shadow: inset 3px 0 0 #c96442;
      border-radius: 6px;
    }

    #${STATUS_OVERLAY_ID} {
      position: fixed;
      right: 14px;
      bottom: 14px;
      z-index: 2147483647;
      overflow: visible;
      color: var(--rs-ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      transition:
        right 200ms cubic-bezier(0.2, 0.9, 0.2, 1),
        opacity 160ms ease;
      pointer-events: auto;
    }

    #${STATUS_OVERLAY_ID}[data-overlay-mode="expanded"] {
      width: min(312px, calc(100vw - 28px));
    }

    #${STATUS_OVERLAY_ID}[data-overlay-mode="docked"] {
      right: -32px;
      width: 84px;
      height: 72px;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-status-card,
    #${STATUS_OVERLAY_ID} .reader-sync-overlay-toggle-docked {
      border: 1px solid var(--rs-line);
      background: var(--rs-surface);
      box-shadow: var(--rs-shadow);
      backdrop-filter: blur(14px) saturate(1.1);
    }

    #${STATUS_OVERLAY_ID} .reader-sync-status-card {
      padding: 12px 14px;
      border-radius: 14px;
      display: grid;
      gap: 8px;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-overlay-toggle {
      appearance: none;
      border: none;
      color: inherit;
      font: inherit;
      cursor: pointer;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-overlay-toggle:focus-visible {
      outline: 2px solid var(--rs-accent);
      outline-offset: 3px;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-overlay-toggle-docked {
      width: 100%;
      height: 100%;
      padding: 10px 14px 10px 16px;
      border-radius: 999px 0 0 999px;
      display: flex;
      align-items: center;
      gap: 8px;
      justify-content: flex-start;
      transition:
        box-shadow 180ms ease,
        border-color 180ms ease;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-overlay-toggle-docked:hover {
      border-color: var(--rs-accent);
    }

    #${STATUS_OVERLAY_ID} .reader-sync-docked-dot {
      flex: 0 0 auto;
      width: 10px;
      height: 10px;
      border-radius: 999px;
      background: var(--rs-dot-idle);
      box-shadow: 0 0 0 4px var(--rs-dot-idle-halo);
    }

    #${STATUS_OVERLAY_ID}[data-player-state="playing"] .reader-sync-docked-dot {
      background: #2f7656;
      box-shadow: 0 0 0 4px rgba(47, 118, 86, 0.18);
    }

    #${STATUS_OVERLAY_ID}[data-player-state="paused"] .reader-sync-docked-dot,
    #${STATUS_OVERLAY_ID}[data-player-state="ended"] .reader-sync-docked-dot {
      background: #9b6b1f;
      box-shadow: 0 0 0 4px rgba(155, 107, 31, 0.18);
    }

    #${STATUS_OVERLAY_ID}[data-player-state="error"] .reader-sync-docked-dot {
      background: #b6493a;
      box-shadow: 0 0 0 4px rgba(182, 73, 58, 0.18);
    }

    #${STATUS_OVERLAY_ID} .reader-sync-docked-body {
      display: grid;
      gap: 2px;
      text-align: left;
      min-width: 0;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-docked-body strong {
      font-size: 12px;
      font-weight: 600;
      color: var(--rs-ink);
      line-height: 1.1;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-docked-body span {
      font-size: 10px;
      color: var(--rs-ink-muted);
      line-height: 1.1;
      white-space: nowrap;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-docked-body span::after {
      content: "";
    }

    #${STATUS_OVERLAY_ID} .reader-sync-status-topline {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-status-label {
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--rs-ink-muted);
      font-weight: 600;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-status-top {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 0;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-state-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 10px;
      border-radius: 999px;
      background: rgba(201, 100, 66, 0.1);
      color: var(--rs-accent);
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-state-pill::before {
      content: "";
      width: 6px;
      height: 6px;
      border-radius: 999px;
      background: currentColor;
      box-shadow: 0 0 0 3px rgba(201, 100, 66, 0.18);
    }

    #${STATUS_OVERLAY_ID}[data-player-state="playing"] .reader-sync-state-pill {
      background: rgba(47, 118, 86, 0.14);
      color: #2f7656;
    }

    #${STATUS_OVERLAY_ID}[data-player-state="playing"] .reader-sync-state-pill::before {
      box-shadow: 0 0 0 3px rgba(47, 118, 86, 0.2);
    }

    #${STATUS_OVERLAY_ID}[data-player-state="paused"] .reader-sync-state-pill,
    #${STATUS_OVERLAY_ID}[data-player-state="ended"] .reader-sync-state-pill {
      background: rgba(155, 107, 31, 0.14);
      color: #9b6b1f;
    }

    #${STATUS_OVERLAY_ID}[data-player-state="paused"] .reader-sync-state-pill::before,
    #${STATUS_OVERLAY_ID}[data-player-state="ended"] .reader-sync-state-pill::before {
      box-shadow: 0 0 0 3px rgba(155, 107, 31, 0.2);
    }

    #${STATUS_OVERLAY_ID}[data-player-state="error"] .reader-sync-state-pill {
      background: rgba(182, 73, 58, 0.14);
      color: #b6493a;
    }

    #${STATUS_OVERLAY_ID}[data-player-state="error"] .reader-sync-state-pill::before {
      box-shadow: 0 0 0 3px rgba(182, 73, 58, 0.2);
    }

    #${STATUS_OVERLAY_ID} .reader-sync-overlay-action {
      flex: 0 0 auto;
      min-height: 28px;
      padding: 0 10px;
      border-radius: 999px;
      background: rgba(201, 100, 66, 0.1);
      color: var(--rs-accent);
      font-size: 11px;
      font-weight: 600;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: background-color 160ms ease;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-overlay-action:hover {
      background: rgba(201, 100, 66, 0.2);
    }

    #${STATUS_OVERLAY_ID} .reader-sync-status-title {
      font-size: 13px;
      font-weight: 600;
      line-height: 1.4;
      color: var(--rs-ink);
    }

    #${STATUS_OVERLAY_ID} .reader-sync-status-meta {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      font-size: 11px;
      color: var(--rs-ink-muted);
    }

    #${STATUS_OVERLAY_ID} .reader-sync-status-meta strong {
      display: block;
      margin-bottom: 2px;
      color: var(--rs-ink);
      font-size: 12px;
      font-weight: 600;
    }

    @media (prefers-reduced-motion: reduce) {
      #${STATUS_OVERLAY_ID},
      #${STATUS_OVERLAY_ID} * {
        transition: none !important;
      }
    }
  `;
  document.documentElement.append(styleElement);
}
function shouldAutoScrollIntoView(element) {
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const topThreshold = viewportHeight * 0.32;
  const bottomThreshold = viewportHeight * 0.68;
  return rect.top < topThreshold || rect.bottom > bottomThreshold;
}
function resolveActiveAnalysisPanel() {
  return document.querySelector('[role="tabpanel"][data-state="active"][id*="analysis"]') ?? document.querySelector('[role="tabpanel"][data-state="active"][aria-labelledby*="analysis"]');
}
function normalizeElementText(element) {
  return element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}
function resolveActiveAnalysisParagraphIndex() {
  const panel = resolveActiveAnalysisPanel();
  const text = normalizeElementText(panel);
  const match = text.match(/第\s*(\d+)\s*段/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}
function isAnalysisFollowEnabled() {
  const panel = resolveActiveAnalysisPanel();
  if (!panel) {
    return false;
  }
  const text = normalizeElementText(panel);
  if (!text || text.includes(ANALYSIS_EMPTY_HINT)) {
    return false;
  }
  return resolveActiveAnalysisParagraphIndex() !== null;
}
function findParagraphAnalysisTrigger(activeNode, paragraphIndex) {
  return activeNode.querySelector(
    `button[data-paragraph-trigger="${String(paragraphIndex)}"][aria-label="${ANALYSIS_TRIGGER_LABEL}"]`
  ) ?? activeNode.querySelector(
    `button[data-paragraph-trigger="${String(paragraphIndex)}"]`
  ) ?? activeNode.querySelector(
    `button[aria-label="${ANALYSIS_TRIGGER_LABEL}"]`
  );
}
var AimReadDomController = class {
  clickHandlers = /* @__PURE__ */ new Set();
  statusOverlay;
  statusOverlayElements;
  activeParagraphIndex = null;
  activeElement = null;
  lastFollowedAnalysisParagraphIndex = null;
  playerState = null;
  currentTitle = document.title;
  visibleParagraphCount = 0;
  overlayMode = "expanded";
  themeMode = "auto";
  themeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  constructor() {
    ensureStyle();
    this.statusOverlay = this.ensureStatusOverlay();
    this.statusOverlayElements = this.ensureStatusOverlayElements();
    void this.loadOverlayMode();
    void this.loadThemeMode();
    this.themeMediaQuery.addEventListener("change", () => {
      if (this.themeMode === "auto") {
        this.applyThemeMode();
      }
    });
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") {
        return;
      }
      if (OVERLAY_MODE_STORAGE_KEY in changes) {
        this.overlayMode = sanitizeOverlayMode(changes[OVERLAY_MODE_STORAGE_KEY]?.newValue);
        this.renderStatusOverlay();
      }
      if (playerThemeStorageKey in changes) {
        this.themeMode = sanitizeReaderSyncThemeMode(changes[playerThemeStorageKey]?.newValue);
        this.applyThemeMode();
      }
    });
    this.renderStatusOverlay();
    this.applyThemeMode();
  }
  collectPageContext() {
    const articleRoot = findArticleRoot2();
    if (!articleRoot) {
      return null;
    }
    const articleId = (() => {
      const match = window.location.pathname.match(/\/daily-feed\/(\d+)/);
      if (!match) {
        return null;
      }
      return Number.parseInt(match[1], 10);
    })();
    const titleElement = document.querySelector("[data-article-title]") ?? articleRoot.querySelector("h1");
    const title = titleElement?.textContent?.trim() ?? document.title;
    const containers = findParagraphContainers2(articleRoot);
    const paragraphs = containers.map((container, index) => {
      const paragraphIndex = resolveParagraphIndex(container, index);
      container.setAttribute(MARKER_ATTRIBUTE, String(paragraphIndex));
      return {
        paragraphIndex,
        text: extractVisibleText2(container),
        domPath: buildDomPath(container),
        contentPage: resolveContentPage(container),
        top: container.getBoundingClientRect().top + window.scrollY
      };
    }).filter((paragraph) => paragraph.text.length > 0);
    this.currentTitle = title;
    this.visibleParagraphCount = paragraphs.length;
    this.syncActiveNode();
    this.renderStatusOverlay();
    return {
      articleUrl: window.location.href,
      articleId,
      categoryId: parseNumericQueryParameter2("categoryId"),
      title,
      capturedAt: (/* @__PURE__ */ new Date()).toISOString(),
      paragraphs
    };
  }
  bindParagraphClicks() {
    const nodes = document.querySelectorAll(`[${MARKER_ATTRIBUTE}]`);
    nodes.forEach((node) => {
      if (node.dataset.readerSyncBound === "true") {
        return;
      }
      node.dataset.readerSyncBound = "true";
      node.addEventListener("click", (event) => {
        const target = event.target;
        if (target instanceof HTMLElement && target.closest("button")) {
          return;
        }
        const value = node.getAttribute(MARKER_ATTRIBUTE);
        const paragraphIndex = value ? Number.parseInt(value, 10) : Number.NaN;
        if (!Number.isFinite(paragraphIndex)) {
          return;
        }
        for (const handler of this.clickHandlers) {
          handler(paragraphIndex);
        }
      });
    });
  }
  onParagraphClick(handler) {
    this.clickHandlers.add(handler);
  }
  applyPlayerState(activeParagraphIndex, state) {
    this.playerState = state;
    this.highlightParagraph(activeParagraphIndex);
    this.renderStatusOverlay();
  }
  highlightParagraph(paragraphIndex) {
    if (this.activeParagraphIndex === paragraphIndex && (paragraphIndex === null || this.activeElement)) {
      return;
    }
    if (this.activeElement) {
      this.activeElement.classList.remove("reader-sync-active");
      this.activeElement = null;
    }
    this.activeParagraphIndex = paragraphIndex;
    this.syncActiveNode(true);
    this.renderStatusOverlay();
  }
  ensureStatusOverlay() {
    const existing = document.getElementById(STATUS_OVERLAY_ID);
    if (existing instanceof HTMLDivElement) {
      return existing;
    }
    const overlay = document.createElement("div");
    overlay.id = STATUS_OVERLAY_ID;
    overlay.setAttribute("aria-live", "polite");
    overlay.dataset.overlayMode = this.overlayMode;
    overlay.dataset.theme = resolveReaderSyncThemeMode(this.themeMode, this.themeMediaQuery.matches);
    overlay.dataset.themeMode = this.themeMode;
    document.documentElement.append(overlay);
    return overlay;
  }
  ensureStatusOverlayElements() {
    const dockedToggle = document.createElement("button");
    dockedToggle.type = "button";
    dockedToggle.className = "reader-sync-overlay-toggle reader-sync-overlay-toggle-docked";
    dockedToggle.setAttribute("aria-expanded", "false");
    dockedToggle.setAttribute("aria-label", "\u5C55\u5F00 Reader Sync \u540C\u6B65\u72B6\u6001");
    dockedToggle.title = "\u5C55\u5F00\u540C\u6B65\u72B6\u6001";
    dockedToggle.hidden = true;
    dockedToggle.addEventListener("click", () => {
      void this.setOverlayMode("expanded");
    });
    const dockedDot = document.createElement("span");
    dockedDot.className = "reader-sync-docked-dot";
    dockedDot.setAttribute("aria-hidden", "true");
    const dockedBody = document.createElement("span");
    dockedBody.className = "reader-sync-docked-body";
    const dockedParagraphTag = document.createElement("strong");
    const dockedStateText = document.createElement("span");
    dockedBody.append(dockedParagraphTag, dockedStateText);
    dockedToggle.append(dockedDot, dockedBody);
    const expandedCard = document.createElement("div");
    expandedCard.className = "reader-sync-status-card";
    const topLine = document.createElement("div");
    topLine.className = "reader-sync-status-topline";
    const topRow = document.createElement("div");
    topRow.className = "reader-sync-status-top";
    const expandedLabel = document.createElement("span");
    expandedLabel.className = "reader-sync-status-label";
    const expandedStatePill = document.createElement("span");
    expandedStatePill.className = "reader-sync-state-pill";
    topRow.append(expandedLabel, expandedStatePill);
    const collapseButton = document.createElement("button");
    collapseButton.type = "button";
    collapseButton.className = "reader-sync-overlay-toggle reader-sync-overlay-action";
    collapseButton.textContent = "\u8D34\u8FB9";
    collapseButton.setAttribute("aria-expanded", "true");
    collapseButton.setAttribute("aria-label", "\u8D34\u8FB9\u6536\u8D77 Reader Sync \u540C\u6B65\u72B6\u6001");
    collapseButton.title = "\u8D34\u8FB9\u6536\u8D77";
    collapseButton.addEventListener("click", () => {
      void this.setOverlayMode("docked");
    });
    const expandedTitle = document.createElement("div");
    expandedTitle.className = "reader-sync-status-title";
    const meta = document.createElement("div");
    meta.className = "reader-sync-status-meta";
    const currentParagraph = document.createElement("div");
    const expandedCurrentParagraphValue = document.createElement("strong");
    const expandedCurrentParagraphLabel = document.createElement("span");
    currentParagraph.append(expandedCurrentParagraphValue, expandedCurrentParagraphLabel);
    const paragraphCount = document.createElement("div");
    const expandedParagraphCountValue = document.createElement("strong");
    const expandedParagraphCountLabel = document.createElement("span");
    paragraphCount.append(expandedParagraphCountValue, expandedParagraphCountLabel);
    topLine.append(topRow, collapseButton);
    meta.append(currentParagraph, paragraphCount);
    expandedCard.append(topLine, expandedTitle, meta);
    this.statusOverlay.append(expandedCard, dockedToggle);
    return {
      dockedToggle,
      dockedParagraphTag,
      dockedStateText,
      expandedCard,
      expandedCollapseButton: collapseButton,
      expandedLabel,
      expandedStatePill,
      expandedTitle,
      expandedCurrentParagraphValue,
      expandedCurrentParagraphLabel,
      expandedParagraphCountValue,
      expandedParagraphCountLabel
    };
  }
  async loadOverlayMode() {
    try {
      const stored = await chrome.storage.local.get(OVERLAY_MODE_STORAGE_KEY);
      this.overlayMode = sanitizeOverlayMode(stored[OVERLAY_MODE_STORAGE_KEY]);
      this.renderStatusOverlay();
    } catch {
      this.overlayMode = "expanded";
      this.renderStatusOverlay();
    }
  }
  async loadThemeMode() {
    try {
      const stored = await chrome.storage.local.get(playerThemeStorageKey);
      this.themeMode = sanitizeReaderSyncThemeMode(stored[playerThemeStorageKey]);
    } catch {
      this.themeMode = "auto";
    }
    this.applyThemeMode();
  }
  applyThemeMode() {
    this.statusOverlay.dataset.theme = resolveReaderSyncThemeMode(this.themeMode, this.themeMediaQuery.matches);
    this.statusOverlay.dataset.themeMode = this.themeMode;
  }
  async setOverlayMode(nextMode) {
    if (this.overlayMode === nextMode) {
      return;
    }
    this.overlayMode = nextMode;
    this.renderStatusOverlay();
    try {
      await chrome.storage.local.set({
        [OVERLAY_MODE_STORAGE_KEY]: nextMode
      });
    } catch {
    }
  }
  syncActiveNode(scrollWhenNeeded = false) {
    if (this.activeParagraphIndex === null) {
      return;
    }
    const activeNode = document.querySelector(
      `[${MARKER_ATTRIBUTE}="${String(this.activeParagraphIndex)}"]`
    );
    if (!activeNode) {
      return;
    }
    activeNode.classList.add("reader-sync-active");
    this.activeElement = activeNode;
    if (scrollWhenNeeded && shouldAutoScrollIntoView(activeNode)) {
      activeNode.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    }
    this.syncParagraphAnalysis(activeNode);
  }
  syncParagraphAnalysis(activeNode) {
    if (this.activeParagraphIndex === null) {
      this.lastFollowedAnalysisParagraphIndex = null;
      return;
    }
    if (!isAnalysisFollowEnabled()) {
      this.lastFollowedAnalysisParagraphIndex = null;
      return;
    }
    const currentAnalysisParagraphIndex = resolveActiveAnalysisParagraphIndex();
    if (currentAnalysisParagraphIndex === this.activeParagraphIndex) {
      this.lastFollowedAnalysisParagraphIndex = this.activeParagraphIndex;
      return;
    }
    if (this.lastFollowedAnalysisParagraphIndex === this.activeParagraphIndex) {
      return;
    }
    const trigger = findParagraphAnalysisTrigger(activeNode, this.activeParagraphIndex);
    if (!trigger) {
      return;
    }
    this.lastFollowedAnalysisParagraphIndex = this.activeParagraphIndex;
    window.setTimeout(() => {
      trigger.click();
    }, 0);
  }
  renderStatusOverlay() {
    this.statusOverlay.dataset.playerState = this.playerState ?? "idle";
    this.statusOverlay.dataset.overlayMode = this.overlayMode;
    this.applyThemeMode();
    const stateLabel = playbackStateLabel(this.playerState);
    const activeParagraphLabel = this.activeParagraphIndex === null ? "-" : `#${this.activeParagraphIndex}`;
    const {
      dockedToggle,
      dockedParagraphTag,
      dockedStateText,
      expandedCard,
      expandedCollapseButton,
      expandedLabel,
      expandedStatePill,
      expandedTitle,
      expandedCurrentParagraphValue,
      expandedCurrentParagraphLabel,
      expandedParagraphCountValue,
      expandedParagraphCountLabel
    } = this.statusOverlayElements;
    dockedToggle.hidden = this.overlayMode !== "docked";
    expandedCard.hidden = this.overlayMode !== "expanded";
    dockedToggle.setAttribute("aria-expanded", this.overlayMode === "expanded" ? "true" : "false");
    dockedToggle.title = this.activeParagraphIndex === null ? "\u5C55\u5F00 Reader Sync \u540C\u6B65\u72B6\u6001" : `\u5C55\u5F00 Reader Sync \u540C\u6B65\u72B6\u6001\uFF08${activeParagraphLabel}\uFF09`;
    dockedParagraphTag.textContent = this.activeParagraphIndex === null ? "Sync" : activeParagraphLabel;
    dockedStateText.textContent = stateLabel;
    dockedStateText.parentElement?.setAttribute("data-state", this.activeParagraphIndex === null ? "idle" : "ready");
    expandedLabel.textContent = "Reader Sync";
    expandedStatePill.textContent = stateLabel;
    expandedCollapseButton.textContent = "\u8D34\u8FB9";
    expandedTitle.textContent = truncateText(this.currentTitle, 80);
    expandedCurrentParagraphValue.textContent = activeParagraphLabel;
    expandedCurrentParagraphLabel.textContent = "\u5F53\u524D\u6BB5\u843D";
    expandedParagraphCountValue.textContent = String(this.visibleParagraphCount);
    expandedParagraphCountLabel.textContent = "\u5DF2\u8BC6\u522B\u53EF\u89C1\u6BB5";
  }
};

// src/content/index.ts
var logger2 = createLogger("content");
setReaderSyncLogSink((entry) => {
  try {
    chrome.runtime.sendMessage({ type: "LOG_ENTRY", payload: entry });
  } catch {
  }
}, { flushExisting: false });
var controller = new AimReadDomController();
var globalWindow = window;
var handledKeyboardEvents = /* @__PURE__ */ new WeakSet();
var shortcutStorageKey = "reader-sync-shortcut-settings";
var defaultShortcutSettings = {
  togglePlayback: "Space",
  seekBackward: "ArrowLeft",
  seekForward: "ArrowRight",
  rateDown: "KeyZ",
  rateUp: "KeyX",
  seekSeconds: 5
};
var shortcutSettings = { ...defaultShortcutSettings };
var articleSnapshotInFlight = null;
var lastCollectedArticleUrl = null;
var lastArticleSnapshotAttemptAt = 0;
var lastPageContextParagraphIndexes = [];
var lastPageContextSignature = null;
var paragraphRevealInFlight = null;
var pendingRevealParagraphIndex = null;
var lastPlayerState = "idle";
var contentPort = null;
var contentPortReconnectTimer = null;
var contentPageUnloading = false;
var extensionContextInvalidated = false;
function isRuntimeContextInvalidatedError(error) {
  return error instanceof Error && error.message.includes("Extension context invalidated");
}
function clearContentPortReconnectTimer() {
  if (contentPortReconnectTimer !== null) {
    window.clearTimeout(contentPortReconnectTimer);
    contentPortReconnectTimer = null;
  }
}
function scheduleContentPortReconnect(delayMs = 280) {
  if (contentPortReconnectTimer !== null || contentPageUnloading || extensionContextInvalidated) {
    return;
  }
  contentPortReconnectTimer = window.setTimeout(() => {
    contentPortReconnectTimer = null;
    connectContentPort();
  }, delayMs);
}
function handleContentPortDisconnect(disconnectedPort) {
  if (contentPort !== disconnectedPort) {
    return;
  }
  contentPort = null;
  if (contentPageUnloading) {
    return;
  }
  logger2.debug("Content port disconnected, scheduling reconnect");
  scheduleContentPortReconnect();
}
function connectContentPort() {
  if (contentPort) {
    return contentPort;
  }
  if (extensionContextInvalidated) {
    throw new Error("Extension context invalidated");
  }
  clearContentPortReconnectTimer();
  let nextPort;
  try {
    nextPort = chrome.runtime.connect({ name: CONTENT_PORT_NAME });
  } catch (error) {
    if (isRuntimeContextInvalidatedError(error)) {
      extensionContextInvalidated = true;
      contentPageUnloading = true;
      logger2.warn("Extension context invalidated, stopping content reconnect until page reload");
    }
    throw error;
  }
  logger2.info("Content port connected");
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
function postRuntimeMessage(message, options) {
  const retry = options?.retry !== false;
  let targetPort;
  try {
    targetPort = connectContentPort();
  } catch (error) {
    if (!isRuntimeContextInvalidatedError(error)) {
      logger2.warn("Content port connect failed", { type: message.type, error });
    }
    return false;
  }
  try {
    targetPort.postMessage(message);
    return true;
  } catch (error) {
    logger2.warn("Content port postMessage failed", { type: message.type, error });
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
      logger2.warn("Content port retry postMessage failed", { type: message.type, error: retryError });
      scheduleContentPortReconnect(420);
      return false;
    }
  }
}
function isExtensionOwnedNode(node) {
  if (!node) {
    return false;
  }
  const element = node instanceof Element ? node : node.parentElement;
  if (!element) {
    return false;
  }
  if (element.id === "reader-sync-style" || element.id === "reader-sync-status-overlay") {
    return true;
  }
  return Boolean(element.closest("#reader-sync-status-overlay, #reader-sync-style, .reader-sync-debug"));
}
function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}
function normalizeKeyboardKey(value) {
  return value.trim().toLowerCase();
}
function matchesConfiguredShortcut(event, configuredValue) {
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
function sanitizeShortcutSettings(rawValue) {
  if (typeof rawValue !== "object" || rawValue === null) {
    return { ...defaultShortcutSettings };
  }
  const asRecord = rawValue;
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
async function loadShortcutSettings() {
  const stored = await chrome.storage.local.get(shortcutStorageKey);
  shortcutSettings = sanitizeShortcutSettings(stored[shortcutStorageKey]);
}
function wait2(delayMs) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}
function isParagraphIndexVisible(paragraphIndex) {
  return Boolean(
    document.querySelector(`[data-reader-sync-paragraph-index="${String(paragraphIndex)}"]`) ?? document.querySelector(`[data-paragraph-trigger="${String(paragraphIndex)}"]`)
  );
}
function resolveVisibleParagraphRange() {
  if (lastPageContextParagraphIndexes.length === 0) {
    return null;
  }
  return {
    minimum: lastPageContextParagraphIndexes[0],
    maximum: lastPageContextParagraphIndexes[lastPageContextParagraphIndexes.length - 1]
  };
}
function collectAndSendPageContext() {
  const pageContext = controller.collectPageContext();
  if (!pageContext) {
    logger2.debug("No aim-read article context detected on current page");
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
  lastPageContextParagraphIndexes = pageContext.paragraphs.map((paragraph) => paragraph.paragraphIndex).sort((left, right) => left - right);
  controller.bindParagraphClicks();
  if (contextSignature === lastPageContextSignature) {
    return;
  }
  lastPageContextSignature = contextSignature;
  postRuntimeMessage({
    type: "PAGE_CONTEXT_UPDATE",
    payload: pageContext
  });
  void ensureArticleSnapshotCollection(pageContext.articleUrl);
}
function scheduleCollect(delayMs = 350) {
  window.clearTimeout(globalWindow.__readerSyncCollectTimer);
  globalWindow.__readerSyncCollectTimer = window.setTimeout(() => {
    collectAndSendPageContext();
  }, delayMs);
}
async function collectAndSendArticleSnapshot(articleUrl) {
  logger2.info("Starting full article snapshot collection", { articleUrl });
  try {
    const articleSnapshot = await collectCompleteArticleSnapshot();
    lastCollectedArticleUrl = articleUrl;
    logger2.info("Collected full article snapshot", {
      articleUrl,
      articleId: articleSnapshot.articleId,
      paragraphCount: articleSnapshot.paragraphs.length,
      totalPages: articleSnapshot.pageInfo?.totalPages ?? null
    });
    postRuntimeMessage({
      type: "ARTICLE_SNAPSHOT_UPDATE",
      payload: articleSnapshot
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("\u5F53\u524D\u9875\u9762\u4E0D\u662F\u53EF\u8BC6\u522B\u7684 aim-read \u5267\u96C6\u6587\u7AE0\u9875")) {
      logger2.debug("Skipping article snapshot collection on non-reader page", { articleUrl });
      return;
    }
    logger2.warn(`Failed to collect full article snapshot: ${message}`);
    postRuntimeMessage({
      type: "ARTICLE_SNAPSHOT_ERROR",
      payload: { message }
    });
  }
}
function ensureArticleSnapshotCollection(articleUrl, options) {
  const force = options?.force === true;
  const now = Date.now();
  if (!force && lastCollectedArticleUrl === articleUrl) {
    logger2.debug("Skipping article snapshot collection because article was already collected", { articleUrl });
    return Promise.resolve();
  }
  if (articleSnapshotInFlight) {
    logger2.debug("Reusing in-flight article snapshot collection", { articleUrl, force });
    return articleSnapshotInFlight;
  }
  if (!force && now - lastArticleSnapshotAttemptAt < 1200) {
    logger2.debug("Skipping article snapshot collection because of throttle window", { articleUrl, force });
    return Promise.resolve();
  }
  lastArticleSnapshotAttemptAt = now;
  articleSnapshotInFlight = collectAndSendArticleSnapshot(articleUrl).catch((error) => {
    logger2.warn("Article snapshot collection failed", {
      message: error instanceof Error ? error.message : String(error)
    });
  }).finally(() => {
    articleSnapshotInFlight = null;
  });
  return articleSnapshotInFlight;
}
async function ensureParagraphVisible(paragraphIndex) {
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
    const direction = currentRange === null ? 0 : paragraphIndex > currentRange.maximum ? 1 : paragraphIndex < currentRange.minimum ? -1 : 0;
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
      const nextTop = direction > 0 ? window.scrollY + stepPx : Math.max(0, window.scrollY - stepPx);
      if (Math.abs(nextTop - window.scrollY) < 4) {
        break;
      }
      window.scrollTo({ top: nextTop, behavior: "auto" });
      await wait2(260);
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
  })().finally(() => {
    paragraphRevealInFlight = null;
    pendingRevealParagraphIndex = null;
  });
  return paragraphRevealInFlight;
}
controller.onParagraphClick((paragraphIndex) => {
  postRuntimeMessage({
    type: "PAGE_PARAGRAPH_CLICKED",
    payload: { paragraphIndex }
  });
});
function handleRuntimeMessage(message) {
  switch (message.type) {
    case "COLLECT_ARTICLE_SNAPSHOT": {
      const pageContext = controller.collectPageContext();
      if (!pageContext) {
        logger2.debug("Ignoring COLLECT_ARTICLE_SNAPSHOT because page context is unavailable");
        return;
      }
      logger2.info("Received COLLECT_ARTICLE_SNAPSHOT", {
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
      if (typeof message.payload.activeParagraphIndex === "number" && !isParagraphIndexVisible(message.payload.activeParagraphIndex)) {
        void ensureParagraphVisible(message.payload.activeParagraphIndex);
      }
      return;
    default:
      return;
  }
}
chrome.runtime.onMessage.addListener((message) => {
  handleRuntimeMessage(message);
});
var observer = new MutationObserver((mutations) => {
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
function handleReaderPageKeyboardShortcut(event) {
  if (handledKeyboardEvents.has(event)) {
    return;
  }
  const targetNode = event.target instanceof Node ? event.target : null;
  if (isExtensionOwnedNode(targetNode) || isEditableTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) {
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
    });
    return;
  }
  if (matchesConfiguredShortcut(event, shortcutSettings.seekBackward)) {
    handledKeyboardEvents.add(event);
    event.preventDefault();
    postRuntimeMessage({
      type: "PLAYER_CONTROL_COMMAND",
      payload: {
        command: "seek_by",
        deltaMs: -(shortcutSettings.seekSeconds * 1e3),
        source: "reader-page"
      }
    });
    return;
  }
  if (matchesConfiguredShortcut(event, shortcutSettings.seekForward)) {
    handledKeyboardEvents.add(event);
    event.preventDefault();
    postRuntimeMessage({
      type: "PLAYER_CONTROL_COMMAND",
      payload: {
        command: "seek_by",
        deltaMs: shortcutSettings.seekSeconds * 1e3,
        source: "reader-page"
      }
    });
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
    });
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
    });
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
try {
  connectContentPort();
} catch (error) {
  if (!isRuntimeContextInvalidatedError(error)) {
    logger2.warn("Initial content port connect failed", { error });
  }
}
collectAndSendPageContext();
//# sourceMappingURL=index.js.map
