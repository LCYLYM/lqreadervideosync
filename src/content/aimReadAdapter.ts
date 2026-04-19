import type { AimReadPageContext, ArticleParagraph, PlaybackState } from "../shared/protocol";

const MARKER_ATTRIBUTE = "data-reader-sync-paragraph-index";
const STYLE_ELEMENT_ID = "reader-sync-style";
const STATUS_OVERLAY_ID = "reader-sync-status-overlay";
const OVERLAY_MODE_STORAGE_KEY = "reader-sync-reader-overlay-mode";
const ANALYSIS_TRIGGER_LABEL = "段落解析";
const ANALYSIS_EMPTY_HINT = "点击段落左侧 Sparkle 查看句子解析";

type OverlayMode = "expanded" | "docked";

interface StatusOverlayElements {
  dockedToggle: HTMLButtonElement;
  dockedParagraphTag: HTMLElement;
  dockedStateText: HTMLElement;
  expandedCard: HTMLDivElement;
  expandedCollapseButton: HTMLButtonElement;
  expandedLabel: HTMLElement;
  expandedStatePill: HTMLElement;
  expandedTitle: HTMLDivElement;
  expandedCurrentParagraphValue: HTMLElement;
  expandedCurrentParagraphLabel: HTMLElement;
  expandedParagraphCountValue: HTMLElement;
  expandedParagraphCountLabel: HTMLElement;
}

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

function sanitizeOverlayMode(rawValue: unknown): OverlayMode {
  return rawValue === "docked" ? "docked" : "expanded";
}

function ensureStyle(): void {
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

    @media (prefers-color-scheme: dark) {
      #${STATUS_OVERLAY_ID} {
        --rs-surface: rgba(30, 28, 24, 0.94);
        --rs-ink: #f0e9dc;
        --rs-ink-muted: rgba(240, 233, 220, 0.72);
        --rs-line: rgba(255, 248, 236, 0.12);
        --rs-shadow: 0 16px 40px rgba(0, 0, 0, 0.48);
        --rs-dot-idle: #7a746a;
        --rs-dot-idle-halo: rgba(122, 116, 106, 0.24);
      }
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
  private readonly statusOverlayElements: StatusOverlayElements;
  private activeParagraphIndex: number | null = null;
  private activeElement: HTMLElement | null = null;
  private lastFollowedAnalysisParagraphIndex: number | null = null;
  private playerState: PlaybackState | null = null;
  private currentTitle = document.title;
  private visibleParagraphCount = 0;
  private overlayMode: OverlayMode = "expanded";

  constructor() {
    ensureStyle();
    this.statusOverlay = this.ensureStatusOverlay();
    this.statusOverlayElements = this.ensureStatusOverlayElements();
    void this.loadOverlayMode();
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !(OVERLAY_MODE_STORAGE_KEY in changes)) {
        return;
      }
      this.overlayMode = sanitizeOverlayMode(changes[OVERLAY_MODE_STORAGE_KEY]?.newValue);
      this.renderStatusOverlay();
    });
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
    overlay.dataset.overlayMode = this.overlayMode;
    document.documentElement.append(overlay);
    return overlay;
  }

  private ensureStatusOverlayElements(): StatusOverlayElements {
    const dockedToggle = document.createElement("button");
    dockedToggle.type = "button";
    dockedToggle.className = "reader-sync-overlay-toggle reader-sync-overlay-toggle-docked";
    dockedToggle.setAttribute("aria-expanded", "false");
    dockedToggle.setAttribute("aria-label", "展开 Reader Sync 同步状态");
    dockedToggle.title = "展开同步状态";
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
    collapseButton.textContent = "贴边";
    collapseButton.setAttribute("aria-expanded", "true");
    collapseButton.setAttribute("aria-label", "贴边收起 Reader Sync 同步状态");
    collapseButton.title = "贴边收起";
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

  private async loadOverlayMode(): Promise<void> {
    try {
      const stored = await chrome.storage.local.get(OVERLAY_MODE_STORAGE_KEY);
      this.overlayMode = sanitizeOverlayMode(stored[OVERLAY_MODE_STORAGE_KEY]);
      this.renderStatusOverlay();
    } catch {
      this.overlayMode = "expanded";
      this.renderStatusOverlay();
    }
  }

  private async setOverlayMode(nextMode: OverlayMode): Promise<void> {
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
      // Ignore storage errors and keep the in-memory preference for this page.
    }
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
    this.statusOverlay.dataset.overlayMode = this.overlayMode;
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
    dockedToggle.title = this.activeParagraphIndex === null ? "展开 Reader Sync 同步状态" : `展开 Reader Sync 同步状态（${activeParagraphLabel}）`;
    dockedParagraphTag.textContent = this.activeParagraphIndex === null ? "Sync" : activeParagraphLabel;
    dockedStateText.textContent = stateLabel;
    dockedStateText.parentElement?.setAttribute("data-state", this.activeParagraphIndex === null ? "idle" : "ready");

    expandedLabel.textContent = "Reader Sync";
    expandedStatePill.textContent = stateLabel;
    expandedCollapseButton.textContent = "贴边";
    expandedTitle.textContent = truncateText(this.currentTitle, 80);
    expandedCurrentParagraphValue.textContent = activeParagraphLabel;
    expandedCurrentParagraphLabel.textContent = "当前段落";
    expandedParagraphCountValue.textContent = String(this.visibleParagraphCount);
    expandedParagraphCountLabel.textContent = "已识别可见段";
  }
}
