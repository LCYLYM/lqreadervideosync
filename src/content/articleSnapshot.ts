import { createLogger } from "../shared/logger";
import type { AimReadArticleSnapshot, ArticleParagraph } from "../shared/protocol";

const logger = createLogger("article-snapshot");
const ARTICLE_API_REQUEST_TIMEOUT_MS = 8000;
const ARTICLE_API_PAGE_SIZE_STRATEGIES = [500, 200, 100] as const;

interface AimReadArticleApiParagraph {
  paragraphIndex: number;
  content?: string;
  text?: string;
  translation?: string;
  contentPage?: number;
}

interface AimReadArticleApiPageInfo {
  totalPages?: number;
  pageSize?: number;
  totalElements?: number;
  currentPage?: number;
  hasNext?: boolean;
}

interface AimReadArticleApiPayload {
  articleInfo?: {
    id?: number;
    titleEn?: string;
    title?: string;
  };
  pageInfo?: AimReadArticleApiPageInfo;
  paragraphCount?: number;
  paragraphs?: AimReadArticleApiParagraph[];
}

interface AimReadArticleApiEnvelope {
  code?: number;
  msg?: string | null;
  data?: unknown;
}

function parseNumericQueryParameter(name: string): number | null {
  const value = new URL(window.location.href).searchParams.get(name);
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function resolveArticleIdFromUrl(): number | null {
  const match = window.location.pathname.match(/\/daily-feed\/(\d+)/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function looksLikeArticlePayload(value: unknown): value is AimReadArticleApiPayload {
  if (!isObject(value)) {
    return false;
  }

  return Array.isArray(value.paragraphs) || isObject(value.pageInfo) || isObject(value.articleInfo);
}

function unwrapArticleApiPayload(rawValue: unknown): AimReadArticleApiPayload {
  if (!isObject(rawValue)) {
    throw new Error("文章接口返回结构无效。");
  }

  if (looksLikeArticlePayload(rawValue)) {
    return rawValue;
  }

  const envelope = rawValue as AimReadArticleApiEnvelope;
  if (typeof envelope.code === "number" && envelope.code !== 200) {
    throw new Error(asString(envelope.msg) ?? `文章接口请求失败 (code ${envelope.code})`);
  }

  if (looksLikeArticlePayload(envelope.data)) {
    return envelope.data;
  }

  throw new Error("文章接口返回结构无效。");
}

function normalizeParagraph(rawParagraph: unknown, currentPage: number | null): ArticleParagraph | null {
  if (!isObject(rawParagraph)) {
    return null;
  }

  const paragraphIndex = asNumber(rawParagraph.paragraphIndex);
  const text = asString(rawParagraph.content) ?? asString(rawParagraph.text);
  if (paragraphIndex === null || !text) {
    return null;
  }

  const translation = asString(rawParagraph.translation);
  const contentPage = asNumber(rawParagraph.contentPage) ?? currentPage ?? undefined;
  return {
    paragraphIndex,
    text,
    translation: translation ?? undefined,
    contentPage
  };
}

async function fetchArticlePage(articleId: number, page: number, pageSize: number): Promise<AimReadArticleApiPayload> {
  const endpoint = `/api/articles/${articleId}/content/page?page=${page}&pageSize=${pageSize}`;
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => {
    controller.abort();
  }, ARTICLE_API_REQUEST_TIMEOUT_MS);
  let response: Response;

  try {
    response = await fetch(endpoint, {
      credentials: "include",
      headers: {
        accept: "application/json"
      },
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`文章接口请求超时 (${ARTICLE_API_REQUEST_TIMEOUT_MS}ms)`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`文章接口请求失败 (${response.status})`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("文章接口返回了非 JSON 内容，登录态可能已失效。");
  }

  return unwrapArticleApiPayload((await response.json()) as unknown);
}

async function collectArticleSnapshotFromApiWithPageSize(
  articleId: number,
  categoryId: number | null,
  pageSize: number
): Promise<AimReadArticleSnapshot> {
  const paragraphsByIndex = new Map<number, ArticleParagraph>();
  let title: string | null = null;
  let totalPages: number | null = null;
  let totalElements: number | null = null;
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
    const normalizedParagraphs = Array.isArray(payload.paragraphs)
      ? payload.paragraphs
          .map((paragraph) => normalizeParagraph(paragraph, pageNumber))
          .filter((paragraph): paragraph is ArticleParagraph => paragraph !== null)
      : [];

    for (const paragraph of normalizedParagraphs) {
      paragraphsByIndex.set(paragraph.paragraphIndex, paragraph);
    }

    title =
      title ??
      (isObject(payload.articleInfo)
        ? asString(payload.articleInfo.titleEn) ?? asString(payload.articleInfo.title)
        : null) ??
      document.title;
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
      throw new Error("文章分页数量异常，已停止抓取。");
    }
  }

  const paragraphs = Array.from(paragraphsByIndex.values()).sort((left, right) => left.paragraphIndex - right.paragraphIndex);
  if (paragraphs.length === 0) {
    throw new Error("文章接口返回为空，无法构建完整段落快照。");
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
    capturedAt: new Date().toISOString(),
    paragraphCount: totalElements ?? paragraphs.length,
    paragraphs,
    pageInfo: {
      totalPages,
      pageSize,
      totalElements: totalElements ?? paragraphs.length
    }
  };
}

export async function collectArticleSnapshotFromApi(): Promise<AimReadArticleSnapshot> {
  const articleId = resolveArticleIdFromUrl();
  if (articleId === null) {
    throw new Error("当前页面不是可识别的 aim-read 剧集文章页。");
  }

  const categoryId = parseNumericQueryParameter("categoryId");
  const failures: string[] = [];

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

  throw new Error(`文章接口抓取失败：${failures.join(" | ")}`);
}

function findArticleRoot(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>("main article") ??
    document.querySelector<HTMLElement>("article")
  );
}

function extractVisibleText(root: Element): string {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const chunks: string[] = [];
  let currentNode = walker.nextNode();
  while (currentNode) {
    const parentElement = currentNode.parentElement;
    if (
      parentElement &&
      !parentElement.closest("button, script, style, [aria-hidden='true'], .reader-sync-debug")
    ) {
      const text = currentNode.textContent?.replace(/\s+/g, " ").trim();
      if (text) {
        chunks.push(text);
      }
    }
    currentNode = walker.nextNode();
  }
  return chunks.join(" ").replace(/\s+/g, " ").trim();
}

function findParagraphContainers(articleRoot: HTMLElement): HTMLElement[] {
  const containers: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const triggerButtons = Array.from(articleRoot.querySelectorAll<HTMLButtonElement>("[data-paragraph-trigger]"));

  for (const triggerButton of triggerButtons) {
    let current: HTMLElement | null = triggerButton.parentElement;
    let bestMatch: HTMLElement | null = null;
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

function collectVisibleParagraphsFromDom(): ArticleParagraph[] {
  const articleRoot = findArticleRoot();
  if (!articleRoot) {
    return [];
  }

  const collectedParagraphs: Array<ArticleParagraph | null> = findParagraphContainers(articleRoot)
    .map((container, index): ArticleParagraph | null => {
      const triggerButton = container.querySelector<HTMLButtonElement>("[data-paragraph-trigger]");
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
          const pageContainer = container.closest<HTMLElement>("[data-content-page]");
          const rawPage = pageContainer?.getAttribute("data-content-page");
          const parsed = rawPage ? Number.parseInt(rawPage, 10) : Number.NaN;
          return Number.isFinite(parsed) ? parsed : undefined;
        })()
      } satisfies ArticleParagraph;
    });

  return collectedParagraphs.filter((paragraph): paragraph is ArticleParagraph => paragraph !== null);
}

async function wait(delayMs: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, delayMs));
}

export async function collectArticleSnapshotByAutoScroll(): Promise<AimReadArticleSnapshot> {
  const articleId = resolveArticleIdFromUrl();
  if (articleId === null) {
    throw new Error("当前页面不是可识别的 aim-read 剧集文章页。");
  }

  const titleElement =
    document.querySelector<HTMLElement>("[data-article-title]") ??
    document.querySelector<HTMLElement>("main article h1") ??
    document.querySelector<HTMLElement>("article h1");
  const title = titleElement?.textContent?.trim() ?? document.title;
  const categoryId = parseNumericQueryParameter("categoryId");
  const mergedParagraphs = new Map<number, ArticleParagraph>();
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

      const sentinel = Array.from(document.querySelectorAll("body *"))
        .find((element) => (element.textContent ?? "").includes("滚动以加载更多内容"));
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
    throw new Error("懒加载补齐失败，没有抓到可用段落。");
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
    capturedAt: new Date().toISOString(),
    paragraphCount: paragraphs.length,
    paragraphs
  };
}

export async function collectCompleteArticleSnapshot(): Promise<AimReadArticleSnapshot> {
  try {
    return await collectArticleSnapshotFromApi();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`Article snapshot API collection failed, falling back to auto scroll: ${message}`);
    return collectArticleSnapshotByAutoScroll();
  }
}
