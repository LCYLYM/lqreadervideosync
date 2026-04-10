import type { AimReadPageContext, ArticleParagraph, PlaybackState } from "../shared/protocol";

const MARKER_ATTRIBUTE = "data-reader-sync-paragraph-index";
const STYLE_ELEMENT_ID = "reader-sync-style";
const STATUS_OVERLAY_ID = "reader-sync-status-overlay";
const ANALYSIS_TRIGGER_LABEL = "段落解析";
const ANALYSIS_EMPTY_HINT = "点击段落左侧 Sparkle 查看句子解析";

function parseNumericQueryParameter(name: string): number | null {
  const value = new URL(window.location.href).searchParams.get(name);
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
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

function buildDomPath(element: Element): string {
  const steps: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.body) {
    const parent: Element | null = current.parentElement;
    if (!parent) {
      break;
    }
    const siblings = Array.from(parent.children).filter(
      (child: Element) => child.tagName === current?.tagName
    );
    const siblingIndex = siblings.indexOf(current) + 1;
    steps.unshift(`${current.tagName.toLowerCase()}:nth-of-type(${siblingIndex})`);
    current = parent;
  }
  return steps.join(" > ");
}

function findArticleRoot(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>("main article") ??
    document.querySelector<HTMLElement>("article")
  );
}

function findParagraphContainers(articleRoot: HTMLElement): HTMLElement[] {
  const containers: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const triggerButtons = Array.from(
    articleRoot.querySelectorAll<HTMLButtonElement>("[data-paragraph-trigger]")
  );

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

function resolveParagraphIndex(container: HTMLElement, fallbackIndex: number): number {
  const triggerButton = container.querySelector<HTMLButtonElement>("[data-paragraph-trigger]");
  const rawValue = triggerButton?.getAttribute("data-paragraph-trigger");
  if (rawValue) {
    const parsed = Number.parseInt(rawValue, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallbackIndex + 1;
}

function resolveContentPage(container: HTMLElement): number | undefined {
  const pageContainer = container.closest<HTMLElement>("[data-content-page]");
  const rawValue = pageContainer?.getAttribute("data-content-page");
  if (!rawValue) {
    return undefined;
  }
  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function playbackStateLabel(state: PlaybackState | null): string {
  switch (state) {
    case "playing":
      return "播放中";
    case "paused":
      return "已暂停";
    case "loading":
      return "载入中";
    case "ended":
      return "已结束";
    case "error":
      return "异常";
    default:
      return "等待连接";
  }
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ELEMENT_ID)) {
    return;
  }

  const styleElement = document.createElement("style");
  styleElement.id = STYLE_ELEMENT_ID;
  styleElement.textContent = `
    [${MARKER_ATTRIBUTE}] {
      position: relative;
      transition: background-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
      scroll-margin-block: 10vh;
    }

    [${MARKER_ATTRIBUTE}].reader-sync-active {
      background: rgba(255, 226, 106, 0.28);
      box-shadow: inset 3px 0 0 rgba(196, 135, 0, 0.85);
      border-radius: 10px;
      transform: translateX(2px);
    }

    #${STATUS_OVERLAY_ID} {
      position: fixed;
      right: 16px;
      bottom: 18px;
      z-index: 2147483647;
      width: min(320px, calc(100vw - 32px));
      padding: 12px 14px;
      border-radius: 16px;
      background: rgba(28, 21, 12, 0.82);
      color: #f8f1e5;
      box-shadow: 0 16px 36px rgba(0, 0, 0, 0.2);
      backdrop-filter: blur(12px);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      pointer-events: none;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-status-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 8px;
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-state-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 9px;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.12);
    }

    #${STATUS_OVERLAY_ID} .reader-sync-state-pill::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: #7f8c8d;
      box-shadow: 0 0 0 4px rgba(127, 140, 141, 0.14);
    }

    #${STATUS_OVERLAY_ID}[data-player-state="playing"] .reader-sync-state-pill::before {
      background: #4fe089;
      box-shadow: 0 0 0 4px rgba(79, 224, 137, 0.18);
    }

    #${STATUS_OVERLAY_ID}[data-player-state="paused"] .reader-sync-state-pill::before,
    #${STATUS_OVERLAY_ID}[data-player-state="ended"] .reader-sync-state-pill::before {
      background: #ffc451;
      box-shadow: 0 0 0 4px rgba(255, 196, 81, 0.18);
    }

    #${STATUS_OVERLAY_ID}[data-player-state="error"] .reader-sync-state-pill::before {
      background: #ff7b7b;
      box-shadow: 0 0 0 4px rgba(255, 123, 123, 0.16);
    }

    #${STATUS_OVERLAY_ID} .reader-sync-status-title {
      font-size: 14px;
      font-weight: 600;
      line-height: 1.35;
      margin-bottom: 6px;
    }

    #${STATUS_OVERLAY_ID} .reader-sync-status-meta {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
      font-size: 12px;
      color: rgba(248, 241, 229, 0.8);
    }

    #${STATUS_OVERLAY_ID} .reader-sync-status-meta strong {
      display: block;
      margin-bottom: 2px;
      color: #fff8ec;
      font-size: 13px;
      font-weight: 600;
    }
  `;
  document.documentElement.append(styleElement);
}

function shouldAutoScrollIntoView(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight;
  const topThreshold = viewportHeight * 0.32;
  const bottomThreshold = viewportHeight * 0.68;
  return rect.top < topThreshold || rect.bottom > bottomThreshold;
}

function resolveActiveAnalysisPanel(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"][id*="analysis"]') ??
    document.querySelector<HTMLElement>('[role="tabpanel"][data-state="active"][aria-labelledby*="analysis"]')
  );
}

function normalizeElementText(element: Element | null): string {
  return element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

function resolveActiveAnalysisParagraphIndex(): number | null {
  const panel = resolveActiveAnalysisPanel();
  const text = normalizeElementText(panel);
  const match = text.match(/第\s*(\d+)\s*段/);
  if (!match) {
    return null;
  }
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isAnalysisFollowEnabled(): boolean {
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

function findParagraphAnalysisTrigger(activeNode: HTMLElement, paragraphIndex: number): HTMLButtonElement | null {
  return (
    activeNode.querySelector<HTMLButtonElement>(
      `button[data-paragraph-trigger="${String(paragraphIndex)}"][aria-label="${ANALYSIS_TRIGGER_LABEL}"]`
    ) ??
    activeNode.querySelector<HTMLButtonElement>(
      `button[data-paragraph-trigger="${String(paragraphIndex)}"]`
    ) ??
    activeNode.querySelector<HTMLButtonElement>(
      `button[aria-label="${ANALYSIS_TRIGGER_LABEL}"]`
    )
  );
}

export class AimReadDomController {
  private readonly clickHandlers = new Set<(paragraphIndex: number) => void>();
  private readonly statusOverlay: HTMLDivElement;
  private activeParagraphIndex: number | null = null;
  private activeElement: HTMLElement | null = null;
  private lastFollowedAnalysisParagraphIndex: number | null = null;
  private playerState: PlaybackState | null = null;
  private currentTitle = document.title;
  private visibleParagraphCount = 0;

  constructor() {
    ensureStyle();
    this.statusOverlay = this.ensureStatusOverlay();
    this.renderStatusOverlay();
  }

  collectPageContext(): AimReadPageContext | null {
    const articleRoot = findArticleRoot();
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

    const titleElement =
      document.querySelector<HTMLElement>("[data-article-title]") ??
      articleRoot.querySelector<HTMLElement>("h1");
    const title = titleElement?.textContent?.trim() ?? document.title;
    const containers = findParagraphContainers(articleRoot);

    const paragraphs: ArticleParagraph[] = containers.map((container, index) => {
      const paragraphIndex = resolveParagraphIndex(container, index);
      container.setAttribute(MARKER_ATTRIBUTE, String(paragraphIndex));
      return {
        paragraphIndex,
        text: extractVisibleText(container),
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
      categoryId: parseNumericQueryParameter("categoryId"),
      title,
      capturedAt: new Date().toISOString(),
      paragraphs
    };
  }

  bindParagraphClicks(): void {
    const nodes = document.querySelectorAll<HTMLElement>(`[${MARKER_ATTRIBUTE}]`);
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

  onParagraphClick(handler: (paragraphIndex: number) => void): void {
    this.clickHandlers.add(handler);
  }

  applyPlayerState(activeParagraphIndex: number | null, state: PlaybackState): void {
    this.playerState = state;
    this.highlightParagraph(activeParagraphIndex);
    this.renderStatusOverlay();
  }

  highlightParagraph(paragraphIndex: number | null): void {
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

  private ensureStatusOverlay(): HTMLDivElement {
    const existing = document.getElementById(STATUS_OVERLAY_ID);
    if (existing instanceof HTMLDivElement) {
      return existing;
    }

    const overlay = document.createElement("div");
    overlay.id = STATUS_OVERLAY_ID;
    overlay.setAttribute("aria-live", "polite");
    document.documentElement.append(overlay);
    return overlay;
  }

  private syncActiveNode(scrollWhenNeeded = false): void {
    if (this.activeParagraphIndex === null) {
      return;
    }

    const activeNode = document.querySelector<HTMLElement>(
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

  private syncParagraphAnalysis(activeNode: HTMLElement): void {
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

  private renderStatusOverlay(): void {
    this.statusOverlay.dataset.playerState = this.playerState ?? "idle";
    this.statusOverlay.replaceChildren();

    const topRow = document.createElement("div");
    topRow.className = "reader-sync-status-top";

    const label = document.createElement("span");
    label.textContent = "Reader Sync";

    const statePill = document.createElement("span");
    statePill.className = "reader-sync-state-pill";
    statePill.textContent = playbackStateLabel(this.playerState);
    topRow.append(label, statePill);

    const title = document.createElement("div");
    title.className = "reader-sync-status-title";
    title.textContent = truncateText(this.currentTitle, 80);

    const meta = document.createElement("div");
    meta.className = "reader-sync-status-meta";

    const currentParagraph = document.createElement("div");
    const currentParagraphLabel = document.createElement("span");
    currentParagraphLabel.textContent = "当前段落";
    const currentParagraphValue = document.createElement("strong");
    currentParagraphValue.textContent = this.activeParagraphIndex === null ? "-" : `#${this.activeParagraphIndex}`;
    currentParagraph.append(currentParagraphValue, currentParagraphLabel);

    const paragraphCount = document.createElement("div");
    const paragraphCountLabel = document.createElement("span");
    paragraphCountLabel.textContent = "已识别可见段";
    const paragraphCountValue = document.createElement("strong");
    paragraphCountValue.textContent = String(this.visibleParagraphCount);
    paragraphCount.append(paragraphCountValue, paragraphCountLabel);

    meta.append(currentParagraph, paragraphCount);
    this.statusOverlay.append(topRow, title, meta);
  }
}
