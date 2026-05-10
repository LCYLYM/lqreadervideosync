import { createLogger } from "../shared/logger";
import {
  type AimReadArticleSnapshot,
  type AimReadPageContext,
  type ArticleParagraph,
  clamp,
  type ConnectedAimReadTab,
  type EpisodeSyncManifest,
  normalizeEpisodeSlug,
  type PlaybackState,
  PLAYER_PORT_NAME,
  resolveActiveSyncEntry,
  type RuntimeMessage,
  type TranscriptSegment
} from "../shared/protocol";
import {
  buildRuntimeManifestFromSubtitleAsync,
  type RuntimeManifestBuildResult
} from "../shared/runtime-sync-builder";
import {
  parseSubtitleFile,
  type ParsedSubtitleDocument
} from "../shared/subtitle-parser";
import {
  BrowserFfmpegService,
  type BrowserFfmpegStatusEvent
} from "./browser-ffmpeg-service";
import {
  assessMediaCompatibility,
  buildMediaTranscodeStrategy,
  formatAudioCodecs,
  formatContainerFormats,
  formatVideoCodec,
  resolveContainerFormatsForDisplay,
  type MediaCompatibilityAssessment,
  type MediaProbeResult,
  type MediaTranscodeStrategy
} from "./media-compatibility";
import {
  playerThemeStorageKey,
  resolveReaderSyncThemeMode,
  sanitizeReaderSyncThemeMode,
  type ReaderSyncThemeMode
} from "../shared/theme";

interface SubtitleIndexEntry {
  id: string;
  season: number;
  episode: number;
  title: string;
  normalizedTitle: string;
  fileName: string;
  path: string;
}

interface SubtitleIndexPayload {
  subtitles: SubtitleIndexEntry[];
}

type WizardStep = "subtitle" | "video" | "player";
type SubtitleMode = "local" | "manual";
type VideoPlaybackVariant = "original" | "processed";

const logger = createLogger("player");
const supportedSubtitleExtensions = new Set(["ass", "ssa", "srt", "vtt"]);
const supportedVideoExtensions = new Set(["mp4", "mkv"]);
const transcriptFallbackText = "该段当前为平滑补段，没有直接命中的 transcript 片段。";
const themeModeOrder: ReaderSyncThemeMode[] = ["auto", "light", "dark"];

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

const elements = {
  themeToggle: requireElement<HTMLButtonElement>("#theme-toggle"),
  readerStatusPill: requireElement<HTMLElement>("#reader-status-pill"),
  readerStatusText: requireElement<HTMLElement>("#reader-status-text"),
  readerContextValue: requireElement<HTMLElement>("#reader-context-value"),
  subtitleView: requireElement<HTMLElement>("#subtitle-view"),
  videoView: requireElement<HTMLElement>("#video-view"),
  playerView: requireElement<HTMLElement>("#player-view"),
  steps: Array.from(document.querySelectorAll<HTMLElement>(".step")),
  localSubtitleChoice: requireElement<HTMLButtonElement>('[data-subtitle-choice="local"]'),
  onlineSubtitleChoice: requireElement<HTMLButtonElement>('[data-subtitle-choice="online"]'),
  subtitleDrop: requireElement<HTMLElement>("#subtitle-drop"),
  subtitleFile: requireElement<HTMLInputElement>("#subtitle-file"),
  localSubtitleState: requireElement<HTMLElement>("#local-subtitle-state"),
  subtitleFileState: requireElement<HTMLElement>("#subtitle-file-state"),
  subtitleResultTitle: requireElement<HTMLElement>("#subtitle-result-title"),
  subtitleResultDetail: requireElement<HTMLElement>("#subtitle-result-detail"),
  toVideo: requireElement<HTMLButtonElement>("#to-video"),
  backSubtitle: requireElement<HTMLButtonElement>("#back-subtitle"),
  videoSubtitleChip: requireElement<HTMLElement>("#video-subtitle-chip"),
  videoDrop: requireElement<HTMLElement>("#video-drop"),
  videoFile: requireElement<HTMLInputElement>("#video-file"),
  videoDropTitle: requireElement<HTMLElement>("#video-drop-title"),
  videoDropDesc: requireElement<HTMLElement>("#video-drop-desc"),
  videoName: requireElement<HTMLElement>("#video-name"),
  videoContainer: requireElement<HTMLElement>("#video-container"),
  videoCodec: requireElement<HTMLElement>("#video-codec"),
  audioCodec: requireElement<HTMLElement>("#audio-codec"),
  videoPlan: requireElement<HTMLElement>("#video-plan"),
  processingBox: requireElement<HTMLElement>("#processing-box"),
  processingProgress: requireElement<HTMLProgressElement>("#processing-progress"),
  processingText: requireElement<HTMLElement>("#processing-text"),
  riskPlay: requireElement<HTMLButtonElement>("#risk-play"),
  processPlay: requireElement<HTMLButtonElement>("#process-play"),
  playerWrap: requireElement<HTMLElement>("#player-wrap"),
  changeEpisode: requireElement<HTMLButtonElement>("#change-episode"),
  playerNote: requireElement<HTMLElement>("#player-note"),
  video: requireElement<HTMLVideoElement>("#video"),
  playToggle: requireElement<HTMLButtonElement>("#play-toggle"),
  timeReadout: requireElement<HTMLElement>("#time-readout"),
  playbackRateTrigger: requireElement<HTMLButtonElement>("#playback-rate-trigger"),
  playbackRateValue: requireElement<HTMLElement>("#playback-rate-value"),
  playbackRateOptions: requireElement<HTMLElement>("#playback-rate-options"),
  playbackRateOptionButtons: Array.from(document.querySelectorAll<HTMLButtonElement>(".rate-option")),
  expandToggle: requireElement<HTMLButtonElement>("#expand-toggle"),
  pipToggle: requireElement<HTMLButtonElement>("#pip-toggle"),
  playerStatus: requireElement<HTMLElement>("#player-status"),
  playerVideoPill: requireElement<HTMLElement>("#player-video-pill"),
  playerSubtitlePill: requireElement<HTMLElement>("#player-subtitle-pill"),
  playerReaderPill: requireElement<HTMLElement>("#player-reader-pill"),
  riskDialog: requireElement<HTMLDialogElement>("#risk-dialog"),
  cancelRisk: requireElement<HTMLButtonElement>("#cancel-risk"),
  confirmRisk: requireElement<HTMLButtonElement>("#confirm-risk")
};

const browserFfmpegService = new BrowserFfmpegService();
let playerPort: chrome.runtime.Port | null = null;
let playerPortReconnectTimer: number | null = null;
let playerPageUnloading = false;
let connectedTabs: ConnectedAimReadTab[] = [];
let activePageTabId: number | null = null;
let pageContext: AimReadPageContext | null = null;
let articleSnapshot: AimReadArticleSnapshot | null = null;
let articleSnapshotError: string | null = null;
let subtitleIndex: SubtitleIndexEntry[] = [];
let subtitleIndexLoaded = false;
let selectedSubtitleMode: SubtitleMode = "local";
let localSubtitleMatch: SubtitleIndexEntry | null = null;
let loadedSubtitleDocument: ParsedSubtitleDocument | null = null;
let currentRuntimeBuild: RuntimeManifestBuildResult | null = null;
let runtimeBuildInFlight = false;
let runtimeBuildFingerprint: string | null = null;
let runtimeBuildRequestedFingerprint: string | null = null;
let runtimeBuildFailedFingerprint: string | null = null;
let runtimeBuildToken = 0;
let articleSnapshotRequestIssuedAt: number | null = null;
let articleSnapshotLastRequestedAt = 0;
let manifest: EpisodeSyncManifest | null = null;
let transcriptSegmentsByIndex = new Map<number, TranscriptSegment>();
let articleParagraphsByIndex = new Map<number, ArticleParagraph>();
let sourceVideoFile: File | null = null;
let sourceVideoProbe: MediaProbeResult | null = null;
let sourceVideoAssessment: MediaCompatibilityAssessment | null = null;
let sourceVideoStrategy: MediaTranscodeStrategy | null = null;
let sourceVideoInspectionError: string | null = null;
let videoObjectUrl: string | null = null;
let processedVideoFile: File | null = null;
let processedVideoObjectUrl: string | null = null;
let currentVideoVariant: VideoPlaybackVariant | null = null;
let videoInspectionBusy = false;
let videoTranscodeBusy = false;
let videoInspectionToken = 0;
let lastBroadcastAt = 0;
let playerThemeMode: ReaderSyncThemeMode = "auto";
let themeMediaQuery: MediaQueryList | null = null;
let compactLayoutRaf: number | null = null;

function clearPlayerPortReconnectTimer(): void {
  if (playerPortReconnectTimer !== null) {
    window.clearTimeout(playerPortReconnectTimer);
    playerPortReconnectTimer = null;
  }
}

function schedulePlayerPortReconnect(delayMs = 280): void {
  if (playerPortReconnectTimer !== null) {
    return;
  }
  playerPortReconnectTimer = window.setTimeout(() => {
    playerPortReconnectTimer = null;
    connectPlayerPort();
  }, delayMs);
}

function connectPlayerPort(): chrome.runtime.Port {
  if (playerPort) {
    return playerPort;
  }

  clearPlayerPortReconnectTimer();
  const nextPort = chrome.runtime.connect({ name: PLAYER_PORT_NAME });
  playerPort = nextPort;
  nextPort.onMessage.addListener(handleRuntimeMessage);
  nextPort.onDisconnect.addListener(() => {
    if (playerPort === nextPort) {
      playerPort = null;
    }
    if (!playerPageUnloading) {
      schedulePlayerPortReconnect();
    }
  });
  return nextPort;
}

function resolvePlayerTheme(mode: ReaderSyncThemeMode): "light" | "dark" {
  const prefersDark = themeMediaQuery?.matches ?? window.matchMedia("(prefers-color-scheme: dark)").matches;
  return resolveReaderSyncThemeMode(mode, prefersDark);
}

function applyPlayerThemeMode(mode: ReaderSyncThemeMode): void {
  playerThemeMode = mode;
  const resolvedTheme = resolvePlayerTheme(mode);
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themeMode = mode;
  elements.themeToggle.textContent = mode === "auto" ? "自" : mode === "light" ? "日" : "夜";
  const label = mode === "auto" ? "当前跟随浏览器，点击切换到日间主题" : mode === "light" ? "当前日间主题，点击切换到夜间主题" : "当前夜间主题，点击切换到自动主题";
  elements.themeToggle.setAttribute("aria-label", label);
  elements.themeToggle.title = label;
}

async function loadPlayerTheme(): Promise<void> {
  themeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  themeMediaQuery.addEventListener("change", () => {
    if (playerThemeMode === "auto") {
      applyPlayerThemeMode("auto");
    }
  });
  const stored = await chrome.storage.local.get(playerThemeStorageKey);
  applyPlayerThemeMode(sanitizeReaderSyncThemeMode(stored[playerThemeStorageKey]));
}

async function cyclePlayerThemeMode(): Promise<void> {
  const currentIndex = themeModeOrder.indexOf(playerThemeMode);
  const nextThemeMode = themeModeOrder[(currentIndex + 1) % themeModeOrder.length] ?? "auto";
  applyPlayerThemeMode(nextThemeMode);
  await chrome.storage.local.set({ [playerThemeStorageKey]: nextThemeMode });
}

function postRuntimeMessage(message: RuntimeMessage): boolean {
  const port = connectPlayerPort();
  try {
    port.postMessage(message);
    return true;
  } catch (error) {
    logger.warn("Player port postMessage failed", { type: message.type, error });
    if (playerPort === port) {
      playerPort = null;
    }
    schedulePlayerPortReconnect();
    return false;
  }
}

function setView(stepName: WizardStep): void {
  const views: Record<WizardStep, HTMLElement> = {
    subtitle: elements.subtitleView,
    video: elements.videoView,
    player: elements.playerView
  };
  const order: WizardStep[] = ["subtitle", "video", "player"];
  const activeIndex = order.indexOf(stepName);

  for (const [name, element] of Object.entries(views)) {
    element.classList.toggle("is-active", name === stepName);
  }

  elements.steps.forEach((step, index) => {
    step.classList.toggle("is-active", index === activeIndex);
    step.classList.toggle("is-done", index < activeIndex);
    const numberElement = step.querySelector<HTMLElement>(".step-num");
    if (numberElement) {
      numberElement.textContent = index < activeIndex ? "✓" : String(index + 1);
    }
  });

  scheduleCompactLayoutCheck();
}

function formatPlaybackRate(rate: number): string {
  return `${Number.isInteger(rate) ? rate.toFixed(1) : String(rate)}x`;
}

function setPlaybackRate(rate: number): void {
  const normalizedRate = clamp(rate, 0.5, 2);
  elements.video.playbackRate = normalizedRate;
  elements.playbackRateValue.textContent = formatPlaybackRate(normalizedRate);
  for (const option of elements.playbackRateOptionButtons) {
    const optionRate = Number(option.dataset.rate);
    const active = Math.abs(optionRate - normalizedRate) < 0.001;
    option.classList.toggle("is-active", active);
    option.setAttribute("aria-selected", active ? "true" : "false");
  }
}

function setRateMenuOpen(open: boolean): void {
  elements.playbackRateOptions.classList.toggle("is-open", open);
  elements.playbackRateTrigger.setAttribute("aria-expanded", open ? "true" : "false");
}

function resolveViewportWidth(): number {
  return Math.min(window.innerWidth, window.visualViewport?.width ?? window.innerWidth);
}

function updateCompactLayoutMode(): void {
  compactLayoutRaf = null;
  const viewportWidth = resolveViewportWidth();
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const portraitLike = viewportWidth > 0 && viewportHeight > viewportWidth;
  const contentOverflow = document.documentElement.scrollWidth > Math.ceil(document.documentElement.clientWidth + 1);
  document.body.classList.toggle("layout-compact", viewportWidth <= 920 || portraitLike || contentOverflow);
}

function scheduleCompactLayoutCheck(): void {
  if (compactLayoutRaf !== null) {
    return;
  }
  compactLayoutRaf = window.requestAnimationFrame(updateCompactLayoutMode);
}

function fileExtension(fileName: string): string {
  const extension = fileName.split(".").pop()?.trim().toLowerCase() ?? "";
  return extension;
}

function normalizeTextToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\b(the|one|with|where|after|and|part|friends|episode|season)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function extractEpisodeToken(value: string): string | null {
  const seasonEpisodeMatch = value.match(/S(\d{1,2})E(\d{1,2})/i);
  if (seasonEpisodeMatch) {
    return `S${seasonEpisodeMatch[1].padStart(2, "0")}E${seasonEpisodeMatch[2].padStart(2, "0")}`;
  }
  const verboseMatch = value.match(/(?:season|第)\s*(\d{1,2}).{0,6}(?:episode|集|e)\s*(\d{1,2})/i);
  if (verboseMatch) {
    return `S${verboseMatch[1].padStart(2, "0")}E${verboseMatch[2].padStart(2, "0")}`;
  }
  return null;
}

function scoreTitleSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalizeTextToken(left).split(" ").filter(Boolean));
  const rightTokens = new Set(normalizeTextToken(right).split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

async function loadSubtitleIndex(): Promise<void> {
  if (subtitleIndexLoaded) {
    return;
  }
  const response = await fetch(chrome.runtime.getURL("resources/subtitles-index.json"));
  if (!response.ok) {
    throw new Error(`本地字幕索引加载失败 (${response.status})`);
  }
  const payload = (await response.json()) as SubtitleIndexPayload;
  subtitleIndex = Array.isArray(payload.subtitles) ? payload.subtitles : [];
  subtitleIndexLoaded = true;
}

function resolveLocalSubtitleMatch(): SubtitleIndexEntry | null {
  const sourceTexts = [
    pageContext?.title ?? "",
    articleSnapshot?.title ?? "",
    articleSnapshot?.paragraphs.slice(0, 12).map((paragraph) => paragraph.text).join(" ") ?? ""
  ].filter(Boolean);
  const combined = sourceTexts.join(" ");
  const episodeToken = extractEpisodeToken(combined);
  if (episodeToken) {
    const exactMatch = subtitleIndex.find((entry) => entry.id === episodeToken);
    if (exactMatch) {
      return exactMatch;
    }
  }

  let best: { entry: SubtitleIndexEntry; score: number } | null = null;
  for (const entry of subtitleIndex) {
    const score = Math.max(scoreTitleSimilarity(combined, entry.title), scoreTitleSimilarity(pageContext?.title ?? "", entry.title));
    if (!best || score > best.score) {
      best = { entry, score };
    }
  }
  return best && best.score >= 0.42 ? best.entry : null;
}

function currentReaderBlockReason(): string | null {
  if (connectedTabs.length === 0 && !pageContext) {
    return "请先打开一个 aim-read 阅读页。";
  }
  if (connectedTabs.length > 1) {
    return `检测到 ${connectedTabs.length} 个 reader 页面，请只保留一个。`;
  }
  if (articleSnapshotError) {
    return `全文获取失败：${articleSnapshotError}`;
  }
  return null;
}

function updateReaderUi(): void {
  const blockReason = currentReaderBlockReason();
  elements.readerStatusPill.classList.toggle("is-blocked", blockReason !== null);

  if (blockReason) {
    elements.readerStatusText.textContent = blockReason;
  } else if (pageContext) {
    elements.readerStatusText.textContent = `已检测到 reader 页面：${pageContext.title || pageContext.articleUrl}`;
  } else {
    elements.readerStatusText.textContent = "正在检测 reader 页面…";
  }

  const title = pageContext?.title ?? articleSnapshot?.title ?? "等待 reader 页面";
  const paragraphCount = articleSnapshot?.paragraphs.length ?? pageContext?.paragraphs.length ?? 0;
  elements.readerContextValue.textContent =
    paragraphCount > 0 ? `${title} · ${paragraphCount} 段正文` : title;
  elements.playerReaderPill.textContent = pageContext ? `reader：${pageContext.title || "已绑定"}` : "reader：等待绑定";
}

function updateSubtitleChoiceUi(): void {
  elements.localSubtitleChoice.classList.toggle("is-selected", selectedSubtitleMode === "local");
  elements.subtitleDrop.classList.toggle("is-selected", selectedSubtitleMode === "manual");
  elements.onlineSubtitleChoice.classList.remove("is-selected");

  if (selectedSubtitleMode === "local") {
    if (localSubtitleMatch) {
      elements.localSubtitleState.textContent = `已匹配：${localSubtitleMatch.fileName}`;
      elements.subtitleResultTitle.textContent = "已使用本地自动匹配";
      elements.subtitleResultDetail.textContent = `当前字幕：${localSubtitleMatch.fileName} · 英文主线 + 中文字幕保留`;
    } else {
      elements.localSubtitleState.textContent = subtitleIndexLoaded ? "未匹配到当前剧集" : "正在加载本地字幕索引";
      elements.subtitleResultTitle.textContent = "等待本地字幕匹配";
      elements.subtitleResultDetail.textContent = currentReaderBlockReason() ?? "正在根据 reader 页面识别剧集。";
    }
  } else if (loadedSubtitleDocument) {
    elements.subtitleResultTitle.textContent = "已使用手动字幕";
    elements.subtitleResultDetail.textContent = `当前字幕：${loadedSubtitleDocument.fileName} · ${loadedSubtitleDocument.metadata.segmentCount} 条字幕`;
  } else {
    elements.subtitleResultTitle.textContent = "等待手动字幕";
    elements.subtitleResultDetail.textContent = "请拖入 ASS、SSA、SRT 或 VTT 字幕文件。";
  }

  const buildResult = currentRuntimeBuild;
  const ready = loadedSubtitleDocument !== null && buildResult !== null && manifest !== null && currentReaderBlockReason() === null;
  elements.toVideo.disabled = !ready;
  if (ready && buildResult) {
    elements.subtitleResultTitle.textContent =
      selectedSubtitleMode === "local" ? "已使用本地自动匹配" : "已使用手动字幕";
    elements.subtitleResultDetail.textContent =
      `已生成运行时清单：覆盖 ${Math.round(buildResult.stats.coverageRatio * 100)}%，命中 ${buildResult.stats.matchedParagraphCount}/${buildResult.stats.articleParagraphCount} 段。`;
  } else if (loadedSubtitleDocument && !currentRuntimeBuild) {
    elements.subtitleResultTitle.textContent = "正在构建同步索引";
    elements.subtitleResultDetail.textContent = currentReaderBlockReason() ?? "字幕已载入，正在等待 reader 全文快照并生成运行时匹配。";
  }
  const subtitleName = loadedSubtitleDocument?.fileName ?? "等待字幕";
  elements.videoSubtitleChip.textContent = subtitleName;
  elements.playerSubtitlePill.textContent = `字幕：${subtitleName}`;
}

function updateAllUi(): void {
  updateReaderUi();
  updateSubtitleChoiceUi();
}

function setSubtitleStatus(message: string): void {
  elements.subtitleResultDetail.textContent = message;
}

function resetRuntimeSubtitleBuild(): void {
  currentRuntimeBuild = null;
  runtimeBuildInFlight = false;
  runtimeBuildRequestedFingerprint = null;
  runtimeBuildFailedFingerprint = null;
  articleSnapshotRequestIssuedAt = null;
  articleSnapshotLastRequestedAt = 0;
}

function resolveRuntimeBuildFingerprint(): string | null {
  if (!loadedSubtitleDocument || !articleSnapshot) {
    return null;
  }
  return [
    loadedSubtitleDocument.fileName,
    loadedSubtitleDocument.metadata.segmentCount,
    articleSnapshot.articleUrl,
    articleSnapshot.paragraphs.length
  ].join("::");
}

function requestArticleSnapshot(): void {
  const now = Date.now();
  if (articleSnapshotRequestIssuedAt === null) {
    articleSnapshotRequestIssuedAt = now;
  }
  if (now - articleSnapshotLastRequestedAt < 4000) {
    return;
  }
  articleSnapshotLastRequestedAt = now;
  postRuntimeMessage({ type: "REQUEST_ACTIVE_ARTICLE_SNAPSHOT" });
}

function rebuildManifestLookups(manifestValue: EpisodeSyncManifest): void {
  transcriptSegmentsByIndex = new Map(
    manifestValue.transcript.segments.map((segment) => [segment.index, segment])
  );
  articleParagraphsByIndex = new Map(
    (manifestValue.article?.paragraphs ?? []).map((paragraph) => [paragraph.paragraphIndex, paragraph])
  );
}

function installManifest(manifestValue: EpisodeSyncManifest): void {
  manifest = manifestValue;
  rebuildManifestLookups(manifestValue);
  elements.playerStatus.textContent = `同步已就绪：${manifestValue.sync.length} 条映射。`;
}

function maybeRebuildRuntimeSubtitleManifest(): void {
  if (!loadedSubtitleDocument) {
    return;
  }
  if (articleSnapshotError) {
    setSubtitleStatus(`字幕已载入，等待全文文章快照：${articleSnapshotError}`);
    return;
  }
  if (!articleSnapshot) {
    setSubtitleStatus("字幕已载入，正在获取全文文章快照。");
    requestArticleSnapshot();
    return;
  }

  const fingerprint = resolveRuntimeBuildFingerprint();
  if (!fingerprint) {
    return;
  }
  if (fingerprint === runtimeBuildFingerprint && currentRuntimeBuild) {
    updateSubtitleChoiceUi();
    return;
  }
  if (fingerprint === runtimeBuildFailedFingerprint || (runtimeBuildInFlight && fingerprint === runtimeBuildRequestedFingerprint)) {
    return;
  }

  const activeBuildToken = ++runtimeBuildToken;
  const activeSubtitleDocument = loadedSubtitleDocument;
  const activeArticleSnapshot = articleSnapshot;
  runtimeBuildInFlight = true;
  runtimeBuildRequestedFingerprint = fingerprint;
  currentRuntimeBuild = null;
  setSubtitleStatus("字幕已载入，正在执行运行时匹配... 0%");

  void buildRuntimeManifestFromSubtitleAsync(activeSubtitleDocument, activeArticleSnapshot, (progress) => {
    if (activeBuildToken !== runtimeBuildToken) {
      return;
    }
    setSubtitleStatus(`字幕已载入，正在执行运行时匹配... ${Math.round(progress.percent * 100)}% · ${progress.message}`);
  })
    .then((buildResult) => {
      if (activeBuildToken !== runtimeBuildToken) {
        return;
      }
      runtimeBuildInFlight = false;
      runtimeBuildFingerprint = fingerprint;
      runtimeBuildRequestedFingerprint = null;
      runtimeBuildFailedFingerprint = null;
      currentRuntimeBuild = buildResult;
      installManifest(buildResult.manifest);
      elements.subtitleResultTitle.textContent =
        selectedSubtitleMode === "local" ? "已使用本地自动匹配" : "已使用手动字幕";
      elements.subtitleResultDetail.textContent =
        `已生成运行时清单：覆盖 ${Math.round(buildResult.stats.coverageRatio * 100)}%，命中 ${buildResult.stats.matchedParagraphCount}/${buildResult.stats.articleParagraphCount} 段。`;
      updateSubtitleChoiceUi();
      logger.info("Runtime subtitle manifest built", {
        subtitleFile: activeSubtitleDocument.fileName,
        articleId: activeArticleSnapshot.articleId,
        matchedParagraphCount: buildResult.stats.matchedParagraphCount
      });
    })
    .catch((error) => {
      if (activeBuildToken !== runtimeBuildToken) {
        return;
      }
      resetRuntimeSubtitleBuild();
      runtimeBuildFailedFingerprint = fingerprint;
      const message = error instanceof Error ? error.message : String(error);
      setSubtitleStatus(`字幕匹配失败：${message}`);
      updateSubtitleChoiceUi();
      logger.warn("Runtime subtitle manifest failed", { message });
    });
}

async function installSubtitleFile(file: File, mode: SubtitleMode): Promise<void> {
  selectedSubtitleMode = mode;
  elements.subtitleFileState.textContent = file.name;
  const parsed = await parseSubtitleFile(file);
  loadedSubtitleDocument = parsed;
  resetRuntimeSubtitleBuild();
  elements.playerSubtitlePill.textContent = `字幕：${parsed.fileName}`;
  updateSubtitleChoiceUi();
  maybeRebuildRuntimeSubtitleManifest();
}

async function loadLocalSubtitle(match: SubtitleIndexEntry): Promise<void> {
  const response = await fetch(chrome.runtime.getURL(match.path));
  if (!response.ok) {
    throw new Error(`本地字幕加载失败 (${response.status})`);
  }
  const blob = await response.blob();
  const file = new File([blob], match.fileName, { type: "text/plain" });
  await installSubtitleFile(file, "local");
}

async function refreshLocalSubtitleMatch(): Promise<void> {
  await loadSubtitleIndex();
  localSubtitleMatch = resolveLocalSubtitleMatch();
  updateSubtitleChoiceUi();
  if (selectedSubtitleMode !== "local" || !localSubtitleMatch || currentReaderBlockReason() !== null) {
    return;
  }
  if (loadedSubtitleDocument?.fileName === localSubtitleMatch.fileName) {
    maybeRebuildRuntimeSubtitleManifest();
    return;
  }
  try {
    await loadLocalSubtitle(localSubtitleMatch);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.localSubtitleState.textContent = message;
    elements.subtitleResultTitle.textContent = "本地字幕加载失败";
    elements.subtitleResultDetail.textContent = "请改用手动拖入字幕。";
  }
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00.000";
  }
  const minutes = Math.floor(seconds / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  const milliseconds = Math.floor((seconds % 1) * 1000);
  return `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function syncPlayerReadout(): void {
  const duration = Number.isFinite(elements.video.duration) ? elements.video.duration : 0;
  elements.timeReadout.textContent = `${formatTime(elements.video.currentTime)} / ${formatTime(duration)}`;
  elements.playToggle.textContent = elements.video.paused ? "播放" : "暂停";
}

function describeVideoProbe(fileName: string, probe: MediaProbeResult): {
  container: string;
  video: string;
  audio: string;
  detail: string;
} {
  const videoStream = probe.streams.find((stream) => stream.codecType === "video");
  const audioStreams = probe.streams.filter((stream) => stream.codecType === "audio");
  const container = formatContainerFormats(resolveContainerFormatsForDisplay(fileName, probe.containerFormats));
  const video = videoStream
    ? `${formatVideoCodec(videoStream.codecName)}${videoStream.width && videoStream.height ? ` ${videoStream.width}x${videoStream.height}` : ""}`
    : "none";
  const audio = formatAudioCodecs(audioStreams.map((stream) => stream.codecName));
  return {
    container,
    video,
    audio,
    detail: `封装 ${container}，视频 ${video}，音频 ${audio}`
  };
}

function describeTranscodePlan(strategy: MediaTranscodeStrategy): string {
  const containerStep = strategy.containerAction === "copy" ? "封装无需重做" : "重封装到 MP4";
  const videoStep = strategy.videoAction === "copy" ? `视频复用 ${formatVideoCodec(strategy.videoCodec)}` : "视频转 HEVC(HVC1)";
  const audioStep =
    strategy.audioAction === "copy"
      ? `音频复用 ${formatAudioCodecs(strategy.audioCodecs)}`
      : `音频转 AAC（当前 ${formatAudioCodecs(strategy.audioCodecs)}）`;
  return `${containerStep}；${videoStep}；${audioStep}`;
}

function setProcessingProgress(message: string, percent?: number): void {
  elements.processingBox.classList.add("is-active");
  if (typeof percent === "number" && Number.isFinite(percent)) {
    elements.processingProgress.value = Math.min(100, Math.max(0, Math.round(percent * 100)));
  }
  elements.processingText.textContent = message;
}

function setVideoTranscodeProgress(message: string, progress: number): void {
  if (!Number.isFinite(progress)) {
    return;
  }
  const clampedProgress = clamp(progress, 0, 1);
  const visibleProgress = clampedProgress >= 1 ? 0.99 : clampedProgress;
  setProcessingProgress(`${message} · ${Math.round(visibleProgress * 100)}%`, visibleProgress);
}

function updateVideoDecisionControls(): void {
  const hasSourceVideo = sourceVideoFile !== null;
  const canDirectPlay = hasSourceVideo && !videoInspectionBusy && !videoTranscodeBusy;
  const canPreprocess =
    hasSourceVideo &&
    sourceVideoProbe !== null &&
    sourceVideoAssessment !== null &&
    !sourceVideoAssessment.isRecommendedProfile &&
    !videoInspectionBusy &&
    !videoTranscodeBusy;
  elements.riskPlay.disabled = !canDirectPlay;
  elements.processPlay.disabled = !(canPreprocess || (sourceVideoAssessment?.isRecommendedProfile && canDirectPlay));
  elements.processPlay.textContent = sourceVideoAssessment?.isRecommendedProfile ? "直接进入播放" : "一键处理并播放";
}

function revokeProcessedVideoArtifact(): void {
  if (processedVideoObjectUrl) {
    URL.revokeObjectURL(processedVideoObjectUrl);
    processedVideoObjectUrl = null;
  }
  processedVideoFile = null;
}

function resetVideoDecisionState(fileName?: string): void {
  elements.video.pause();
  const currentVideoObjectUrl = videoObjectUrl;
  const currentProcessedVideoObjectUrl = processedVideoObjectUrl;
  videoObjectUrl = null;
  processedVideoObjectUrl = null;
  elements.video.removeAttribute("src");
  elements.video.src = "";
  elements.video.currentTime = 0;
  if (currentVideoObjectUrl) {
    URL.revokeObjectURL(currentVideoObjectUrl);
  }
  if (currentProcessedVideoObjectUrl) {
    URL.revokeObjectURL(currentProcessedVideoObjectUrl);
  }
  elements.video.load();
  processedVideoFile = null;
  sourceVideoProbe = null;
  sourceVideoAssessment = null;
  sourceVideoStrategy = null;
  sourceVideoInspectionError = null;
  currentVideoVariant = null;
  elements.videoName.textContent = fileName ?? "未导入";
  elements.videoContainer.textContent = "等待检测";
  elements.videoCodec.textContent = "等待检测";
  elements.audioCodec.textContent = "等待检测";
  elements.videoPlan.textContent = "导入后判断";
  elements.processingBox.classList.remove("is-active");
  elements.processingProgress.value = 0;
  elements.processingText.textContent = "正在准备";
  elements.processPlay.textContent = "一键处理并播放";
  updateVideoDecisionControls();
}

function buildBrowserFfmpegStatusMessage(event: BrowserFfmpegStatusEvent): string {
  if (event.detail?.message) {
    return event.detail.message;
  }
  switch (event.phase) {
    case "loading-core":
      return "正在装载内置 FFmpeg Core";
    case "ready":
      return "内置 FFmpeg Core 已就绪";
    case "writing-input":
      return "正在写入输入文件";
    case "probing":
      return "正在检测真实音视频流";
    case "transcoding":
      return "正在本地预处理";
    case "finalizing-output":
      return "正在封口 MP4 输出";
    case "reading-output":
      return "正在读取预处理结果";
    case "completed":
      return "预处理完成";
    default:
      return "正在处理";
  }
}

async function loadVideoFile(file: File): Promise<void> {
  const extension = fileExtension(file.name);
  if (!supportedVideoExtensions.has(extension)) {
    elements.videoDropTitle.textContent = "只接受 MP4 或 MKV";
    elements.videoDropDesc.textContent = "请重新拖入正确格式的视频文件。";
    throw new Error("只支持 MP4 或 MKV 视频文件。");
  }

  sourceVideoFile = file;
  resetVideoDecisionState(file.name);
  elements.videoDropTitle.textContent = "视频已导入";
  elements.videoDropDesc.textContent = file.name;
  elements.playerVideoPill.textContent = `视频：${file.name}`;
  videoObjectUrl = URL.createObjectURL(file);
  elements.video.src = videoObjectUrl;
  elements.video.load();

  const token = ++videoInspectionToken;
  videoInspectionBusy = true;
  updateVideoDecisionControls();
  setProcessingProgress("正在检测真实音视频流...", 0);

  try {
    const probe = await browserFfmpegService.inspectFile(file, {
      onStatusChange: (event) => setProcessingProgress(buildBrowserFfmpegStatusMessage(event)),
      onProgress: ({ progress }) => setProcessingProgress("正在检测真实音视频流...", progress)
    });
    if (token !== videoInspectionToken) {
      return;
    }
    const assessment = assessMediaCompatibility(file.name, probe);
    const strategy = buildMediaTranscodeStrategy(file.name, probe);
    const probeDescription = describeVideoProbe(file.name, probe);
    sourceVideoProbe = probe;
    sourceVideoAssessment = assessment;
    sourceVideoStrategy = strategy;
    elements.videoContainer.textContent = probeDescription.container;
    elements.videoCodec.textContent = probeDescription.video;
    elements.audioCodec.textContent = probeDescription.audio;
    elements.videoPlan.textContent = assessment.isRecommendedProfile ? "可直接播放" : describeTranscodePlan(strategy);
    elements.processingText.textContent = assessment.summary;
    elements.processingProgress.value = assessment.isRecommendedProfile ? 100 : 0;
    if (assessment.isRecommendedProfile) {
      videoInspectionBusy = false;
      updateVideoDecisionControls();
      await playOriginalVideoFile({ enterPlayer: true });
    }
  } catch (error) {
    if (token !== videoInspectionToken) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sourceVideoInspectionError = message;
    elements.videoPlan.textContent = "检测失败";
    elements.processingText.textContent = message;
    throw error;
  } finally {
    if (token === videoInspectionToken) {
      videoInspectionBusy = false;
      updateVideoDecisionControls();
    }
  }
}

async function playOriginalVideoFile(options?: { enterPlayer?: boolean }): Promise<void> {
  if (!sourceVideoFile || !videoObjectUrl) {
    throw new Error("请先拖入视频文件。");
  }
  currentVideoVariant = "original";
  elements.video.src = videoObjectUrl;
  elements.video.load();
  await waitForVideoMetadata();
  elements.playerVideoPill.textContent = `视频：${sourceVideoFile.name}`;
  elements.playerNote.textContent = sourceVideoAssessment?.isRecommendedProfile
    ? "已命中推荐播放基线，开始同步 reader 页面。"
    : "正在试播原始文件，若失败请返回一键处理。";
  elements.playerStatus.textContent = sourceVideoAssessment?.isRecommendedProfile
    ? "视频可直接播放。"
    : "正在试播原始文件；如无声或黑屏，请切换下一集后重新一键处理。";
  if (options?.enterPlayer) {
    setView("player");
  }
}

async function playProcessedVideoFile(): Promise<void> {
  if (!processedVideoFile || !processedVideoObjectUrl) {
    throw new Error("当前还没有预处理结果。");
  }
  currentVideoVariant = "processed";
  elements.video.src = processedVideoObjectUrl;
  elements.video.load();
  await waitForVideoMetadata();
  elements.playerVideoPill.textContent = `视频：${processedVideoFile.name}`;
  elements.playerNote.textContent = "已完成兼容处理，开始同步 reader 页面。";
  elements.playerStatus.textContent = "兼容判断完成，可以播放、调速、沉浸或切换画中画。";
  setView("player");
}

function waitForVideoMetadata(timeoutMs = 12000): Promise<void> {
  if (elements.video.readyState >= HTMLMediaElement.HAVE_METADATA && Number.isFinite(elements.video.duration)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("视频文件已生成，但浏览器未能读取 metadata，请返回使用原文件试播或重新处理。"));
    }, timeoutMs);

    const cleanup = (): void => {
      window.clearTimeout(timeout);
      elements.video.removeEventListener("loadedmetadata", handleLoadedMetadata);
      elements.video.removeEventListener("error", handleError);
    };

    const handleLoadedMetadata = (): void => {
      if (!Number.isFinite(elements.video.duration)) {
        return;
      }
      cleanup();
      resolve();
    };

    const handleError = (): void => {
      cleanup();
      const message = elements.video.error?.message || `浏览器无法读取处理后视频，错误码 ${elements.video.error?.code ?? "unknown"}。`;
      reject(new Error(message));
    };

    elements.video.addEventListener("loadedmetadata", handleLoadedMetadata);
    elements.video.addEventListener("error", handleError);
  });
}

async function preprocessVideoFile(): Promise<void> {
  if (!sourceVideoFile || !sourceVideoProbe || !sourceVideoStrategy) {
    throw new Error("请先拖入并完成检测。");
  }
  if (sourceVideoAssessment?.isRecommendedProfile) {
    await playOriginalVideoFile({ enterPlayer: true });
    return;
  }
  if (videoInspectionBusy || videoTranscodeBusy) {
    throw new Error("当前已有视频任务在执行。");
  }

  const sourceFile = sourceVideoFile;
  const sourceProbe = sourceVideoProbe;
  const strategy = sourceVideoStrategy;
  videoTranscodeBusy = true;
  updateVideoDecisionControls();
  setProcessingProgress("准备写入视频并启动预处理...", 0);

  try {
    revokeProcessedVideoArtifact();
    const result = await browserFfmpegService.transcodeFile(sourceFile, sourceProbe, {
      onStatusChange: (event) => {
        const message = buildBrowserFfmpegStatusMessage(event);
        if (event.phase === "finalizing-output" || event.phase === "reading-output") {
          setProcessingProgress(message, 0.99);
          return;
        }
        if (event.phase === "completed") {
          setProcessingProgress(message, 1);
          return;
        }
        setProcessingProgress(message);
      },
      onProgress: ({ progress }) => {
        setVideoTranscodeProgress(describeTranscodePlan(strategy), progress);
      }
    });
    processedVideoFile = result.file;
    processedVideoObjectUrl = URL.createObjectURL(result.blob);
    elements.videoName.textContent = result.file.name;
    elements.videoPlan.textContent = "已生成兼容版本";
    setProcessingProgress(`已生成 ${result.file.name}，正在进入播放。`, 1);
    await playProcessedVideoFile();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.processingText.textContent = message;
    elements.playerStatus.textContent = message;
    throw error;
  } finally {
    videoTranscodeBusy = false;
    updateVideoDecisionControls();
  }
}

function resolveActiveParagraphIndex(currentTimeMs: number): number | null {
  return resolveActiveSyncEntry(manifest, currentTimeMs)?.paragraphIndex ?? null;
}

function broadcastPlayerState(force = false): void {
  const now = Date.now();
  if (!force && now - lastBroadcastAt < 250) {
    return;
  }
  lastBroadcastAt = now;
  const state: PlaybackState = elements.video.error
    ? "error"
    : elements.video.ended
      ? "ended"
      : elements.video.paused
        ? "paused"
        : "playing";
  const currentTimeMs = Math.round(elements.video.currentTime * 1000);
  postRuntimeMessage({
    type: "PLAYER_STATE_UPDATE",
    payload: {
      currentTimeMs,
      state,
      activeParagraphIndex: resolveActiveParagraphIndex(currentTimeMs),
      manifestSlug: manifest?.source.slug ?? null,
      playbackRate: elements.video.playbackRate
    }
  });
}

function broadcastIdlePlayerState(): void {
  postRuntimeMessage({
    type: "PLAYER_STATE_UPDATE",
    payload: {
      currentTimeMs: 0,
      state: "idle",
      activeParagraphIndex: null,
      manifestSlug: manifest?.source.slug ?? null,
      playbackRate: elements.video.playbackRate
    }
  });
}

function seekToParagraph(paragraphIndex: number): void {
  const entry = manifest?.sync.find((item) => item.paragraphIndex === paragraphIndex);
  if (!entry) {
    return;
  }
  elements.video.currentTime = Math.max(0, entry.startMs / 1000);
  broadcastPlayerState(true);
}

function applyPlayerControl(command: RuntimeMessage): void {
  if (command.type === "PLAYER_SEEK_COMMAND") {
    seekToParagraph(command.payload.paragraphIndex);
    return;
  }
  if (command.type !== "PLAYER_CONTROL_COMMAND") {
    return;
  }
  const payload = command.payload;
  if (payload.command === "toggle_playback") {
    void (elements.video.paused ? elements.video.play() : Promise.resolve(elements.video.pause()));
  } else if (payload.command === "seek_by") {
    elements.video.currentTime = Math.max(0, elements.video.currentTime + ((payload.deltaMs ?? 0) / 1000));
  } else if (payload.command === "step_playback_rate") {
    const nextRate = clamp(elements.video.playbackRate + ((payload.step ?? 0) * 0.25), 0.5, 2);
    setPlaybackRate(nextRate);
  }
  broadcastPlayerState(true);
}

function handleRuntimeMessage(message: RuntimeMessage): void {
  switch (message.type) {
    case "CONNECTED_TABS_RESPONSE":
      connectedTabs = message.payload.tabs;
      activePageTabId = message.payload.preferredTabId;
      if (connectedTabs.length === 1) {
        const onlyTab = connectedTabs[0];
        if (onlyTab && message.payload.preferredTabId !== onlyTab.tabId) {
          postRuntimeMessage({ type: "SET_PREFERRED_TAB", payload: { tabId: onlyTab.tabId } });
        }
      }
      updateAllUi();
      void refreshLocalSubtitleMatch();
      return;
    case "ACTIVE_PAGE_CONTEXT_RESPONSE":
      activePageTabId = message.payload.tabId;
      pageContext = message.payload.pageContext;
      updateAllUi();
      void refreshLocalSubtitleMatch();
      return;
    case "ACTIVE_ARTICLE_SNAPSHOT_RESPONSE":
      articleSnapshot = message.payload.articleSnapshot;
      articleSnapshotError = message.payload.error;
      if (articleSnapshot || articleSnapshotError) {
        articleSnapshotRequestIssuedAt = null;
        articleSnapshotLastRequestedAt = 0;
      }
      updateAllUi();
      void refreshLocalSubtitleMatch();
      maybeRebuildRuntimeSubtitleManifest();
      return;
    case "PLAYER_SEEK_COMMAND":
    case "PLAYER_CONTROL_COMMAND":
      applyPlayerControl(message);
      return;
    default:
      return;
  }
}

function bindDropZone(zone: HTMLElement, callback: (file: File) => void): void {
  for (const eventName of ["dragenter", "dragover"]) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove("is-dragging");
    });
  }
  zone.addEventListener("drop", (event) => {
    const dragEvent = event as DragEvent;
    const file = dragEvent.dataTransfer?.files[0];
    if (file) {
      callback(file);
    }
  });
}

function resetEpisode(): void {
  ++runtimeBuildToken;
  loadedSubtitleDocument = null;
  currentRuntimeBuild = null;
  runtimeBuildFingerprint = null;
  runtimeBuildFailedFingerprint = null;
  manifest = null;
  selectedSubtitleMode = "local";
  sourceVideoFile = null;
  resetVideoDecisionState();
  broadcastIdlePlayerState();
  elements.subtitleFile.value = "";
  elements.videoFile.value = "";
  elements.subtitleFileState.textContent = "未选择文件";
  elements.videoDropTitle.textContent = "把视频文件拖到这里";
  elements.videoDropDesc.textContent = "导入后会用内置 FFmpeg 读取真实容器、视频流和音频流。";
  elements.playerWrap.classList.remove("is-expanded");
  document.body.classList.remove("immersive-active");
  setView("subtitle");
  void refreshLocalSubtitleMatch();
}

function attachEvents(): void {
  elements.themeToggle.addEventListener("click", () => {
    void cyclePlayerThemeMode().catch((error) => {
      logger.warn("Failed to persist player theme", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });
  elements.localSubtitleChoice.addEventListener("click", () => {
    selectedSubtitleMode = "local";
    void refreshLocalSubtitleMatch();
  });
  elements.onlineSubtitleChoice.addEventListener("click", () => {
    elements.subtitleResultTitle.textContent = "在线匹配暂未开放";
    elements.subtitleResultDetail.textContent = "后续从 GitHub 字幕仓库动态更新。";
  });
  elements.subtitleFile.addEventListener("change", () => {
    const file = elements.subtitleFile.files?.[0];
    if (!file) {
      return;
    }
    const extension = fileExtension(file.name);
    if (!supportedSubtitleExtensions.has(extension)) {
      elements.subtitleFileState.textContent = "只支持 ASS/SSA/SRT/VTT";
      return;
    }
    void installSubtitleFile(file, "manual").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      elements.subtitleResultTitle.textContent = "字幕加载失败";
      elements.subtitleResultDetail.textContent = message;
    });
  });
  bindDropZone(elements.subtitleDrop, (file) => {
    void installSubtitleFile(file, "manual").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      elements.subtitleResultTitle.textContent = "字幕加载失败";
      elements.subtitleResultDetail.textContent = message;
    });
  });
  elements.toVideo.addEventListener("click", () => setView("video"));
  elements.backSubtitle.addEventListener("click", () => setView("subtitle"));
  elements.videoFile.addEventListener("change", () => {
    const file = elements.videoFile.files?.[0];
    if (file) {
      void loadVideoFile(file).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        elements.videoDropTitle.textContent = "视频加载失败";
        elements.videoDropDesc.textContent = message;
      });
    }
  });
  bindDropZone(elements.videoDrop, (file) => {
    void loadVideoFile(file).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      elements.videoDropTitle.textContent = "视频加载失败";
      elements.videoDropDesc.textContent = message;
    });
  });
  elements.processPlay.addEventListener("click", () => {
    void preprocessVideoFile().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      elements.processingText.textContent = message;
    });
  });
  elements.riskPlay.addEventListener("click", () => {
    elements.riskDialog.showModal();
  });
  elements.cancelRisk.addEventListener("click", () => elements.riskDialog.close());
  elements.confirmRisk.addEventListener("click", () => {
    elements.riskDialog.close();
    void playOriginalVideoFile({ enterPlayer: true });
  });
  elements.changeEpisode.addEventListener("click", resetEpisode);
  elements.playToggle.addEventListener("click", () => {
    void (elements.video.paused ? elements.video.play() : Promise.resolve(elements.video.pause()))
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        elements.playerStatus.textContent = message;
      });
  });
  elements.playbackRateTrigger.addEventListener("click", () => {
    setRateMenuOpen(!elements.playbackRateOptions.classList.contains("is-open"));
  });
  for (const option of elements.playbackRateOptionButtons) {
    option.addEventListener("click", () => {
      const rate = Number(option.dataset.rate);
      if (!Number.isFinite(rate)) {
        return;
      }
      setPlaybackRate(rate);
      setRateMenuOpen(false);
      elements.playerStatus.textContent = `倍速已切换为 ${formatPlaybackRate(rate)}。`;
      broadcastPlayerState(true);
    });
  }
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Node) || elements.playbackRateTrigger.contains(target) || elements.playbackRateOptions.contains(target)) {
      return;
    }
    setRateMenuOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setRateMenuOpen(false);
    }
  });
  elements.expandToggle.addEventListener("click", () => {
    elements.playerWrap.classList.toggle("is-expanded");
    const expanded = elements.playerWrap.classList.contains("is-expanded");
    document.body.classList.toggle("immersive-active", expanded);
    elements.expandToggle.textContent = expanded ? "退出沉浸" : "沉浸";
    elements.playerStatus.textContent = expanded ? "已进入沉浸播放。" : "已退出沉浸播放。";
  });
  elements.pipToggle.addEventListener("click", () => {
    void togglePictureInPicture();
  });
  for (const eventName of ["loadedmetadata", "timeupdate", "play", "pause", "ratechange", "ended"]) {
    elements.video.addEventListener(eventName, () => {
      syncPlayerReadout();
      broadcastPlayerState(eventName !== "timeupdate");
    });
  }
  window.addEventListener("resize", scheduleCompactLayoutCheck);
  window.visualViewport?.addEventListener("resize", scheduleCompactLayoutCheck);
  window.visualViewport?.addEventListener("scroll", scheduleCompactLayoutCheck);
}

async function togglePictureInPicture(): Promise<void> {
  if (!document.pictureInPictureEnabled || typeof elements.video.requestPictureInPicture !== "function") {
    elements.playerStatus.textContent = "当前浏览器不支持画中画。";
    return;
  }
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      elements.playerStatus.textContent = "已退出画中画。";
    } else {
      await elements.video.requestPictureInPicture();
      elements.playerStatus.textContent = "已进入画中画。";
    }
  } catch (error) {
    elements.playerStatus.textContent = error instanceof Error ? error.message : "画中画启动失败。";
  }
}

async function bootstrap(): Promise<void> {
  elements.video.controls = true;
  await loadPlayerTheme();
  attachEvents();
  connectPlayerPort();
  postRuntimeMessage({ type: "REFRESH_READER_TABS" });
  await loadSubtitleIndex();
  updateAllUi();
  void refreshLocalSubtitleMatch();
  scheduleCompactLayoutCheck();
}

window.addEventListener("beforeunload", () => {
  playerPageUnloading = true;
});

void bootstrap().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  elements.readerStatusText.textContent = message;
  elements.readerStatusPill.classList.add("is-blocked");
});
