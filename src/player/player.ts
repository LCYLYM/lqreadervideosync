import { createLogger } from "../shared/logger";
import {
  type AimReadArticleSnapshot,
  type AimReadPageContext,
  type ArticleParagraph,
  clamp,
  type ConnectedAimReadTab,
  type EpisodeSyncManifest,
  isObject,
  normalizeEpisodeSlug,
  type PlaybackState,
  PLAYER_PORT_NAME,
  resolveActiveSyncEntry,
  type RuntimeMessage,
  type SyncEntry,
  type TranscriptSegment
} from "../shared/protocol";
import {
  buildRuntimeManifestFromSubtitleAsync,
  type RuntimeManifestBuildProgress,
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
  resolveContainerFormatsForDisplay,
  type MediaCompatibilityAssessment,
  type MediaProbeResult,
  type MediaTranscodeStrategy
} from "./media-compatibility";

interface RemoteManifestCandidate {
  slug: string;
  title: string;
  url: string;
  description: string;
  articleId: number | null;
  categoryId: number | null;
  tags: string[];
}

interface RemoteIndexResponse {
  candidates: RemoteManifestCandidate[];
  sourceUrl: string;
}

const logger = createLogger("player");

const storageKey = "reader-sync-manifest-base-url";
const searchParameters = new URLSearchParams(window.location.search);
const transcriptFallbackText = "该段当前为平滑补段，没有直接命中的 transcript 片段。";
const articleFallbackText = "当前时间对应的文章段落暂未进入本地快照视野。";
const supportedSubtitleExtensions = new Set(["ass", "ssa", "srt", "vtt"]);
const supportedVideoExtensions = new Set(["mp4", "m4v", "mkv", "mov", "webm", "avi"]);
const supportedManifestExtensions = new Set<string>();

type ManifestOriginKind = "none" | "file" | "remote" | "runtime-subtitle";
type VideoPlaybackVariant = "original" | "processed";

interface ShortcutSettings {
  togglePlayback: string;
  seekBackward: string;
  seekForward: string;
  rateDown: string;
  rateUp: string;
  seekSeconds: number;
}

type PlayerThemePreference = "system" | "light" | "dark";

interface TutorialStep {
  title: string;
  description: string;
  targetSelector: string;
  spotlightPadding?: number;
}

interface TutorialStateRecord {
  completedVersion: string | null;
  dismissedVersion: string | null;
}

const shortcutStorageKey = "reader-sync-shortcut-settings";
const themeStorageKey = "reader-sync-player-theme";
const tutorialStorageKey = "reader-sync-player-tutorial";
const tutorialVersion = "2026-04-player-onboarding-v1";
const themePreferenceOrder: PlayerThemePreference[] = ["system", "dark", "light"];
const defaultShortcutSettings: ShortcutSettings = {
  togglePlayback: "Space",
  seekBackward: "ArrowLeft",
  seekForward: "ArrowRight",
  rateDown: "KeyZ",
  rateUp: "KeyX",
  seekSeconds: 5
};
const defaultTutorialState: TutorialStateRecord = {
  completedVersion: null,
  dismissedVersion: null
};
const tutorialSteps: TutorialStep[] = [
  {
    title: "欢迎来到播放器页",
    description: "这个播放器页会把本地视频、字幕和 aim-read 阅读页串起来。以后想再看一遍教程，点右上角“新手引导”就能重新打开。",
    targetSelector: "#tutorial-hero",
    spotlightPadding: 14
  },
  {
    title: "先绑定阅读页",
    description: "第一步先打开一个 aim-read 剧集文章页，然后在这里选择目标页面。列表不完整时，可以点“刷新页面列表”重新扫描并刷新文章页。",
    targetSelector: "#binding-field",
    spotlightPadding: 12
  },
  {
    title: "也可以直接拖入",
    description: "如果你更习惯拖拽，可以把视频和字幕直接拖到这个区域。视频会自动装载，字幕会立即进入运行时匹配流程。",
    targetSelector: "#drop-zone",
    spotlightPadding: 14
  },
  {
    title: "手动导入本地视频",
    description: "除了拖拽，也可以从这里选择本地视频文件。视频导入后，下面的兼容与预处理区域会先检查真实音视频流。",
    targetSelector: "#video-file-field",
    spotlightPadding: 12
  },
  {
    title: "再导入字幕文件",
    description: "字幕支持 ass、ssa、srt 和 vtt。导入后，扩展会自动抓全文文章并生成运行时同步清单。",
    targetSelector: "#subtitle-file-field",
    spotlightPadding: 12
  },
  {
    title: "先看兼容与预处理",
    description: "这里会判断当前文件能否直接播。如果浏览器对视频或音轨兼容性不好，可以先预处理，再切回播放器。",
    targetSelector: "#preprocess-panel",
    spotlightPadding: 14
  },
  {
    title: "最后就在这里播放",
    description: "播放器区可以直接调进度、改倍速和切画中画。完成前面几步后，阅读页和视频就会开始双向同步。",
    targetSelector: "#player-panel",
    spotlightPadding: 14
  }
];

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function queryOptionalElement<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector);
}

function isEventFromVideoElement(event: KeyboardEvent): boolean {
  if (event.target === elements.video || document.activeElement === elements.video) {
    return true;
  }

  return event.composedPath().includes(elements.video);
}

const elements = {
  video: requireElement<HTMLVideoElement>("#video"),
  videoFile: requireElement<HTMLInputElement>("#video-file"),
  subtitleFile: requireElement<HTMLInputElement>("#subtitle-file"),
  videoFileStatus: requireElement<HTMLElement>("#video-file-status"),
  subtitleFileStatus: requireElement<HTMLElement>("#subtitle-file-status"),
  manifestFile: queryOptionalElement<HTMLInputElement>("#manifest-file"),
  manifestBaseUrl: queryOptionalElement<HTMLInputElement>("#manifest-base-url"),
  remoteSlug: queryOptionalElement<HTMLInputElement>("#remote-slug"),
  fetchRemoteManifestButton: queryOptionalElement<HTMLButtonElement>("#fetch-remote-manifest"),
  refreshRemoteIndexButton: queryOptionalElement<HTMLButtonElement>("#refresh-remote-index"),
  remoteManifestCandidate: queryOptionalElement<HTMLSelectElement>("#remote-manifest-candidate"),
  loadRemoteCandidateButton: queryOptionalElement<HTMLButtonElement>("#load-remote-candidate"),
  remoteIndexStatus: queryOptionalElement<HTMLElement>("#remote-index-status"),
  requestPageContextButton: requireElement<HTMLButtonElement>("#request-page-context"),
  refreshConnectedTabsButton: requireElement<HTMLButtonElement>("#refresh-connected-tabs"),
  pageTabSelect: requireElement<HTMLSelectElement>("#page-tab-select"),
  bindSelectedPageButton: requireElement<HTMLButtonElement>("#bind-selected-page"),
  connectedTabsStatus: requireElement<HTMLElement>("#connected-tabs-status"),
  exportPageContextButton: requireElement<HTMLButtonElement>("#export-page-context"),
  openTutorialButton: requireElement<HTMLButtonElement>("#open-tutorial"),
  themeToggleButton: requireElement<HTMLButtonElement>("#theme-toggle"),
  maximizePlayerToggle: requireElement<HTMLButtonElement>("#maximize-player-toggle"),
  pipToggle: requireElement<HTMLButtonElement>("#pip-toggle"),
  pipTogglePlayer: requireElement<HTMLButtonElement>("#pip-toggle-player"),
  playToggle: requireElement<HTMLButtonElement>("#play-toggle"),
  seekRange: requireElement<HTMLInputElement>("#seek-range"),
  playbackRate: requireElement<HTMLSelectElement>("#playback-rate"),
  shortcutTogglePlay: requireElement<HTMLInputElement>("#shortcut-toggle-play"),
  shortcutSeekBackward: requireElement<HTMLInputElement>("#shortcut-seek-backward"),
  shortcutSeekForward: requireElement<HTMLInputElement>("#shortcut-seek-forward"),
  shortcutRateDown: requireElement<HTMLInputElement>("#shortcut-rate-down"),
  shortcutRateUp: requireElement<HTMLInputElement>("#shortcut-rate-up"),
  shortcutSeekSeconds: requireElement<HTMLInputElement>("#shortcut-seek-seconds"),
  saveShortcuts: requireElement<HTMLButtonElement>("#save-shortcuts"),
  currentTime: requireElement<HTMLElement>("#current-time"),
  durationTime: requireElement<HTMLElement>("#duration-time"),
  videoName: requireElement<HTMLElement>("#video-name"),
  subtitleName: requireElement<HTMLElement>("#subtitle-name"),
  videoCompatibilityStatus: requireElement<HTMLElement>("#video-compatibility-status"),
  videoCompatibilitySummary: requireElement<HTMLElement>("#video-compatibility-summary"),
  videoProbeDetail: requireElement<HTMLElement>("#video-probe-detail"),
  videoTranscodePlan: requireElement<HTMLElement>("#video-transcode-plan"),
  videoProcessingStatus: requireElement<HTMLElement>("#video-processing-status"),
  videoProcessingProgressBar: requireElement<HTMLProgressElement>("#video-processing-progress-bar"),
  videoProcessingProgress: requireElement<HTMLElement>("#video-processing-progress"),
  videoProcessingNote: requireElement<HTMLElement>("#video-processing-note"),
  playOriginalVideo: requireElement<HTMLButtonElement>("#play-original-video"),
  preprocessVideo: requireElement<HTMLButtonElement>("#preprocess-video"),
  playProcessedVideo: requireElement<HTMLButtonElement>("#play-processed-video"),
  downloadProcessedVideo: requireElement<HTMLButtonElement>("#download-processed-video"),
  subtitleStatus: requireElement<HTMLElement>("#subtitle-status"),
  matchingProgressBar: requireElement<HTMLProgressElement>("#matching-progress-bar"),
  matchingProgress: requireElement<HTMLElement>("#matching-progress"),
  manifestName: requireElement<HTMLElement>("#manifest-name"),
  playbackState: requireElement<HTMLElement>("#playback-state"),
  syncCoverage: requireElement<HTMLElement>("#sync-coverage"),
  manifestSource: requireElement<HTMLElement>("#manifest-source"),
  activeParagraph: requireElement<HTMLElement>("#active-paragraph"),
  bindingStatus: requireElement<HTMLElement>("#binding-status"),
  pageMatchStatus: requireElement<HTMLElement>("#page-match-status"),
  pageTitle: requireElement<HTMLElement>("#page-title"),
  pageUrlDisplay: requireElement<HTMLElement>("#page-url-display"),
  pageParagraphCount: requireElement<HTMLElement>("#page-paragraph-count"),
  currentTranscriptPreview: requireElement<HTMLElement>("#current-transcript-preview"),
  currentArticlePreview: requireElement<HTMLElement>("#current-article-preview"),
  currentSyncRange: requireElement<HTMLElement>("#current-sync-range"),
  currentSyncScore: requireElement<HTMLElement>("#current-sync-score"),
  currentSyncSegments: requireElement<HTMLElement>("#current-sync-segments"),
  currentSyncNote: requireElement<HTMLElement>("#current-sync-note"),
  syncNearbyList: requireElement<HTMLElement>("#sync-nearby-list"),
  dropZone: requireElement<HTMLElement>("#drop-zone"),
  statusText: requireElement<HTMLElement>("#status-text"),
  logOutput: requireElement<HTMLElement>("#log-output"),
  tutorialOverlay: requireElement<HTMLElement>("#tutorial-overlay"),
  tutorialSpotlight: requireElement<HTMLElement>("#tutorial-spotlight"),
  tutorialCard: requireElement<HTMLElement>("#tutorial-card"),
  tutorialStepCounter: requireElement<HTMLElement>("#tutorial-step-counter"),
  tutorialTitle: requireElement<HTMLElement>("#tutorial-title"),
  tutorialDescription: requireElement<HTMLElement>("#tutorial-description"),
  tutorialClose: requireElement<HTMLButtonElement>("#tutorial-close"),
  tutorialNext: requireElement<HTMLButtonElement>("#tutorial-next")
};

elements.video.controls = true;

const browserFfmpegService = new BrowserFfmpegService();

let manifest: EpisodeSyncManifest | null = null;
let pageContext: AimReadPageContext | null = null;
let articleSnapshot: AimReadArticleSnapshot | null = null;
let articleSnapshotError: string | null = null;
let activePageTabId: number | null = null;
let boundPageTabId: number | null = null;
let connectedTabs: ConnectedAimReadTab[] = [];
let remoteManifestCandidates: RemoteManifestCandidate[] = [];
let manifestObjectUrl: string | null = null;
let videoObjectUrl: string | null = null;
let sourceVideoFile: File | null = null;
let sourceVideoProbe: MediaProbeResult | null = null;
let sourceVideoAssessment: MediaCompatibilityAssessment | null = null;
let sourceVideoStrategy: MediaTranscodeStrategy | null = null;
let sourceVideoInspectionError: string | null = null;
let processedVideoFile: File | null = null;
let processedVideoObjectUrl: string | null = null;
let currentVideoVariant: VideoPlaybackVariant | null = null;
let videoInspectionBusy = false;
let videoTranscodeBusy = false;
let videoInspectionToken = 0;
let remoteIndexSourceUrl: string | null = null;
let lastBroadcastAt = 0;
let transcriptSegmentsByIndex = new Map<number, TranscriptSegment>();
let articleParagraphsByIndex = new Map<number, ArticleParagraph>();
const playbackRateSteps = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
let loadedSubtitleDocument: ParsedSubtitleDocument | null = null;
let currentRuntimeBuild: RuntimeManifestBuildResult | null = null;
let manifestOriginKind: ManifestOriginKind = "none";
let subtitleAutoBuildEnabled = false;
let shortcutSettings: ShortcutSettings = { ...defaultShortcutSettings };
let runtimeBuildInFlight = false;
let runtimeBuildFingerprint: string | null = null;
let runtimeBuildRequestedFingerprint: string | null = null;
let runtimeBuildFailedFingerprint: string | null = null;
let runtimeBuildToken = 0;
let articleSnapshotRequestIssuedAt: number | null = null;
let articleSnapshotLastRequestedAt = 0;
let playerPort: chrome.runtime.Port | null = null;
let playerPortReconnectTimer: number | null = null;
let playerPageUnloading = false;
let pageContextTabResolutionInFlight: Promise<void> | null = null;
let pageContextTabResolutionKey: string | null = null;
let tutorialState: TutorialStateRecord = { ...defaultTutorialState };
let tutorialActive = false;
let tutorialStepIndex = 0;
let tutorialActiveTarget: HTMLElement | null = null;
let tutorialPositionTimer: number | null = null;
let themePreference: PlayerThemePreference = "system";
const systemDarkModeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
let tutorialPreviouslyFocusedElement: HTMLElement | null = null;
let playerExpanded = false;

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

function handlePlayerPortDisconnect(disconnectedPort: chrome.runtime.Port): void {
  if (playerPort !== disconnectedPort) {
    return;
  }
  playerPort = null;
  if (playerPageUnloading) {
    return;
  }
  appendLog("播放器后台连接已断开，准备自动重连");
  schedulePlayerPortReconnect();
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
    handlePlayerPortDisconnect(nextPort);
  });
  return nextPort;
}

function postRuntimeMessage(message: RuntimeMessage, options?: { retry?: boolean }): boolean {
  const retry = options?.retry !== false;
  const targetPort = connectPlayerPort();

  try {
    targetPort.postMessage(message);
    return true;
  } catch (error) {
    logger.warn("Player port postMessage failed", { type: message.type, error });
    if (playerPort === targetPort) {
      playerPort = null;
    }
    schedulePlayerPortReconnect();

    if (!retry) {
      return false;
    }

    try {
      const retriedPort = connectPlayerPort();
      retriedPort.postMessage(message);
      return true;
    } catch (retryError) {
      logger.warn("Player port retry postMessage failed", { type: message.type, error: retryError });
      if (playerPort === targetPort) {
        playerPort = null;
      }
      schedulePlayerPortReconnect(420);
      return false;
    }
  }
}

function setStatus(message: string): void {
  elements.statusText.textContent = message;
}

function updatePlayerExpandButton(): void {
  elements.maximizePlayerToggle.textContent = playerExpanded ? "还原" : "放大";
  elements.maximizePlayerToggle.setAttribute("aria-pressed", playerExpanded ? "true" : "false");
  elements.maximizePlayerToggle.setAttribute(
    "aria-label",
    playerExpanded ? "还原播放器布局" : "放大播放器到页面主区域"
  );
  elements.maximizePlayerToggle.title = playerExpanded ? "还原播放器布局" : "放大播放器布局";
}

function applyPlayerExpandedState(): void {
  document.body.classList.toggle("player-expanded", playerExpanded);
  updatePlayerExpandButton();
}

function setPlayerExpanded(nextExpanded: boolean): void {
  if (playerExpanded === nextExpanded) {
    return;
  }

  playerExpanded = nextExpanded;
  applyPlayerExpandedState();
  setStatus(nextExpanded ? "播放器已放大到页面主区域。" : "播放器布局已还原。");
  appendLog("播放器布局模式已更新", { expanded: nextExpanded });
}

function togglePlayerExpanded(): void {
  setPlayerExpanded(!playerExpanded);
}

function setMatchingProgress(message: string, percent?: number): void {
  if (typeof percent === "number" && Number.isFinite(percent)) {
    elements.matchingProgressBar.value = Math.min(100, Math.max(0, Math.round(percent * 100)));
  }
  elements.matchingProgress.textContent = message;
}

function appendLog(message: string, metadata?: unknown): void {
  logger.info(message, metadata);
  const renderedMetadata = metadata === undefined ? "" : ` ${JSON.stringify(metadata, null, 2)}`;
  const timestamp = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  elements.logOutput.textContent = `[${timestamp}] ${message}${renderedMetadata}\n${elements.logOutput.textContent}`;
}

function setVideoProcessingProgress(message: string, percent?: number): void {
  if (typeof percent === "number" && Number.isFinite(percent)) {
    const normalized = Math.min(100, Math.max(0, Math.round(percent * 100)));
    elements.videoProcessingProgressBar.value = normalized;
    elements.videoProcessingProgress.textContent = `${normalized}%`;
  } else {
    elements.videoProcessingProgressBar.value = 0;
    elements.videoProcessingProgress.textContent = "0%";
  }
  elements.videoProcessingNote.textContent = message;
}

function updateVideoFileSelectionStatus(message?: string): void {
  elements.videoFileStatus.textContent = message ?? (sourceVideoFile ? `已载入：${sourceVideoFile.name}` : "未选择任何文件");
}

function updateSubtitleFileSelectionStatus(message?: string): void {
  elements.subtitleFileStatus.textContent =
    message ?? (loadedSubtitleDocument ? `已载入：${loadedSubtitleDocument.fileName}` : "未选择任何文件");
}

function updateVideoDecisionControls(): void {
  const hasSourceVideo = sourceVideoFile !== null;
  const hasProcessedVideo = processedVideoFile !== null;
  const canDirectPlay = hasSourceVideo && !videoInspectionBusy && !videoTranscodeBusy;
  const canPreprocess =
    hasSourceVideo &&
    sourceVideoProbe !== null &&
    sourceVideoAssessment !== null &&
    !sourceVideoAssessment.isRecommendedProfile &&
    !videoInspectionBusy &&
    !videoTranscodeBusy;

  elements.playOriginalVideo.disabled = !canDirectPlay;
  elements.preprocessVideo.disabled = !canPreprocess;
  elements.playProcessedVideo.disabled = !hasProcessedVideo || videoInspectionBusy || videoTranscodeBusy;
  elements.downloadProcessedVideo.disabled = !hasProcessedVideo || videoInspectionBusy || videoTranscodeBusy;
}

function setVideoTranscodeProgress(message: string, progress: number): void {
  if (!Number.isFinite(progress)) {
    return;
  }
  const clampedProgress = clamp(progress, 0, 1);
  const visibleProgress = clampedProgress >= 1 ? 0.99 : clampedProgress;
  setVideoProcessingProgress(message, visibleProgress);
}

function describeVideoProbe(fileName: string, probe: MediaProbeResult): string {
  const videoStream = probe.streams.find((stream) => stream.codecType === "video");
  const audioStreams = probe.streams.filter((stream) => stream.codecType === "audio");
  const videoDescription = videoStream
    ? `${videoStream.codecName}${videoStream.width && videoStream.height ? ` ${videoStream.width}x${videoStream.height}` : ""}`
    : "none";
  return `封装 ${formatContainerFormats(resolveContainerFormatsForDisplay(fileName, probe.containerFormats))}，视频 ${videoDescription}，音频 ${formatAudioCodecs(
    audioStreams.map((stream) => stream.codecName)
  )}`;
}

function describeTranscodePlan(strategy: MediaTranscodeStrategy): string {
  const containerStep = strategy.containerAction === "copy" ? "封装无需重做" : "重封装到 MP4";
  const videoStep = strategy.videoAction === "copy" ? `视频复用 ${strategy.videoCodec}` : "视频转 HEVC(HVC1)";
  const audioStep =
    strategy.audioAction === "copy"
      ? `音频复用 ${formatAudioCodecs(strategy.audioCodecs)}`
      : `音频转 AAC（当前 ${formatAudioCodecs(strategy.audioCodecs)}）`;
  return `${containerStep}；${videoStep}；${audioStep}`;
}

function revokeProcessedVideoArtifact(): void {
  if (processedVideoObjectUrl) {
    URL.revokeObjectURL(processedVideoObjectUrl);
    processedVideoObjectUrl = null;
  }
  processedVideoFile = null;
}

function resetVideoDecisionState(fileName?: string): void {
  if (videoObjectUrl) {
    URL.revokeObjectURL(videoObjectUrl);
    videoObjectUrl = null;
  }
  elements.video.pause();
  elements.video.removeAttribute("src");
  elements.video.load();
  updateTransportTime();
  updatePlayToggle();
  updatePictureInPictureButton();
  broadcastPlayerState(true);
  sourceVideoProbe = null;
  sourceVideoAssessment = null;
  sourceVideoStrategy = null;
  sourceVideoInspectionError = null;
  currentVideoVariant = null;
  revokeProcessedVideoArtifact();
  elements.videoName.textContent = fileName ?? "未加载";
  updateVideoFileSelectionStatus(fileName ? `已载入：${fileName}` : undefined);
  elements.videoCompatibilityStatus.textContent = fileName ? "正在检测真实流信息" : "等待视频输入";
  elements.videoCompatibilitySummary.textContent = fileName
    ? "正在装载内置 FFmpeg Core 并探测容器、视频流和音频流。"
    : "检测基于真实容器、视频流和音频流，不依赖文件名或扩展名猜测。";
  elements.videoProbeDetail.textContent = "-";
  elements.videoTranscodePlan.textContent = "尚未生成预处理计划。";
  elements.videoProcessingStatus.textContent = "待命";
  setVideoProcessingProgress("如果文件偏离推荐的 HVC1 + AAC 基线，可以直接试播，也可以一键预处理后播放。");
  updateVideoDecisionControls();
}

function applyProbeOutcome(
  file: File,
  probe: MediaProbeResult,
  assessment: MediaCompatibilityAssessment,
  strategy: MediaTranscodeStrategy
): void {
  sourceVideoFile = file;
  sourceVideoProbe = probe;
  sourceVideoAssessment = assessment;
  sourceVideoStrategy = strategy;
  sourceVideoInspectionError = null;
  updateVideoFileSelectionStatus(`已载入：${file.name}`);
  elements.videoCompatibilityStatus.textContent = assessment.isRecommendedProfile ? "推荐基线命中" : "检测到兼容风险";
  elements.videoCompatibilitySummary.textContent = assessment.summary;
  elements.videoProbeDetail.textContent = describeVideoProbe(file.name, probe);
  elements.videoTranscodePlan.textContent = describeTranscodePlan(strategy);
  elements.videoProcessingStatus.textContent = assessment.isRecommendedProfile ? "无需预处理" : "可直接试播或一键预处理";
  setVideoProcessingProgress(
    assessment.isRecommendedProfile
      ? "当前文件已落在推荐播放基线，将直接进入原生播放器。"
      : "当前文件偏离推荐播放基线。可以无视风险直接播放，也可以一键预处理后再播放。"
  );
  updateVideoDecisionControls();
}

function applyProbeFailure(file: File, message: string): void {
  sourceVideoFile = file;
  sourceVideoProbe = null;
  sourceVideoAssessment = null;
  sourceVideoStrategy = null;
  sourceVideoInspectionError = message;
  elements.videoCompatibilityStatus.textContent = "检测失败";
  elements.videoCompatibilitySummary.textContent = "真实流探测失败，但你仍然可以无视风险直接播放原文件。";
  elements.videoProbeDetail.textContent = "-";
  elements.videoTranscodePlan.textContent = "因为未拿到真实流信息，暂时无法给出预处理计划。";
  elements.videoProcessingStatus.textContent = "可尝试直接播放";
  setVideoProcessingProgress(message);
  updateVideoFileSelectionStatus(`已载入：${file.name}（探测失败，可直接试播）`);
  updateVideoDecisionControls();
}

function formatMs(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const remainingMs = milliseconds % 1000;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(remainingMs).padStart(3, "0")}`;
}

function formatAlignmentScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

function formatRatio(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function playbackStateLabel(state: PlaybackState): string {
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
      return "待机";
  }
}

function createExcerpt(text: string, maxLength = 140): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function fileExtension(fileName: string): string {
  return fileName.split(".").pop()?.trim().toLowerCase() ?? "";
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const editable = target.closest<HTMLElement>("textarea, input, [contenteditable='true']");
  if (!editable) {
    return false;
  }
  if (editable instanceof HTMLTextAreaElement) {
    return !editable.readOnly && !editable.disabled;
  }
  if (editable instanceof HTMLInputElement) {
    const editableInputTypes = new Set([
      "text",
      "search",
      "url",
      "tel",
      "email",
      "password",
      "number"
    ]);
    return !editable.readOnly && !editable.disabled && editableInputTypes.has((editable.type || "text").toLowerCase());
  }
  return editable.isContentEditable;
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
  if (!isObject(rawValue)) {
    return { ...defaultShortcutSettings };
  }

  const seekSeconds = Number.parseInt(String(rawValue.seekSeconds ?? defaultShortcutSettings.seekSeconds), 10);
  return {
    togglePlayback: String(rawValue.togglePlayback ?? defaultShortcutSettings.togglePlayback).trim() || defaultShortcutSettings.togglePlayback,
    seekBackward: String(rawValue.seekBackward ?? defaultShortcutSettings.seekBackward).trim() || defaultShortcutSettings.seekBackward,
    seekForward: String(rawValue.seekForward ?? defaultShortcutSettings.seekForward).trim() || defaultShortcutSettings.seekForward,
    rateDown: String(rawValue.rateDown ?? defaultShortcutSettings.rateDown).trim() || defaultShortcutSettings.rateDown,
    rateUp: String(rawValue.rateUp ?? defaultShortcutSettings.rateUp).trim() || defaultShortcutSettings.rateUp,
    seekSeconds: Number.isFinite(seekSeconds) ? clamp(seekSeconds, 1, 60) : defaultShortcutSettings.seekSeconds
  };
}

function applyShortcutSettingsToInputs(settings: ShortcutSettings): void {
  elements.shortcutTogglePlay.value = settings.togglePlayback;
  elements.shortcutSeekBackward.value = settings.seekBackward;
  elements.shortcutSeekForward.value = settings.seekForward;
  elements.shortcutRateDown.value = settings.rateDown;
  elements.shortcutRateUp.value = settings.rateUp;
  elements.shortcutSeekSeconds.value = String(settings.seekSeconds);
}

function readShortcutSettingsFromInputs(): ShortcutSettings {
  return sanitizeShortcutSettings({
    togglePlayback: elements.shortcutTogglePlay.value,
    seekBackward: elements.shortcutSeekBackward.value,
    seekForward: elements.shortcutSeekForward.value,
    rateDown: elements.shortcutRateDown.value,
    rateUp: elements.shortcutRateUp.value,
    seekSeconds: elements.shortcutSeekSeconds.value
  });
}

async function persistShortcutSettings(settings: ShortcutSettings): Promise<void> {
  shortcutSettings = settings;
  applyShortcutSettingsToInputs(settings);
  await chrome.storage.local.set({
    [shortcutStorageKey]: settings
  });
}

async function loadShortcutSettings(): Promise<void> {
  const stored = await chrome.storage.local.get(shortcutStorageKey);
  shortcutSettings = sanitizeShortcutSettings(stored[shortcutStorageKey]);
  applyShortcutSettingsToInputs(shortcutSettings);
}

function sanitizeThemePreference(rawValue: unknown): PlayerThemePreference {
  if (rawValue === "light" || rawValue === "dark" || rawValue === "system") {
    return rawValue;
  }

  return "system";
}

function resolveAppliedTheme(preference: PlayerThemePreference): "light" | "dark" {
  if (preference === "dark") {
    return "dark";
  }

  if (preference === "light") {
    return "light";
  }

  return systemDarkModeMediaQuery.matches ? "dark" : "light";
}

function describeThemePreference(preference: PlayerThemePreference): string {
  switch (preference) {
    case "dark":
      return "深色";
    case "light":
      return "浅色";
    default:
      return "跟随系统";
  }
}

function applyThemePreference(): void {
  const appliedTheme = resolveAppliedTheme(themePreference);
  document.documentElement.dataset.theme = appliedTheme;
  document.documentElement.dataset.themePreference = themePreference;
  elements.themeToggleButton.textContent = `主题：${describeThemePreference(themePreference)}`;
  elements.themeToggleButton.setAttribute(
    "aria-label",
    `当前为${describeThemePreference(themePreference)}，点击切换主题模式`
  );
}

async function loadThemePreference(): Promise<void> {
  const stored = await chrome.storage.local.get(themeStorageKey);
  themePreference = sanitizeThemePreference(stored[themeStorageKey]);
  applyThemePreference();
}

async function persistThemePreference(nextPreference: PlayerThemePreference): Promise<void> {
  themePreference = nextPreference;
  applyThemePreference();
  await chrome.storage.local.set({
    [themeStorageKey]: nextPreference
  });
}

function cycleThemePreference(): PlayerThemePreference {
  const currentIndex = themePreferenceOrder.indexOf(themePreference);
  const nextIndex = (currentIndex + 1) % themePreferenceOrder.length;
  return themePreferenceOrder[nextIndex] ?? "system";
}

function sanitizeTutorialState(rawValue: unknown): TutorialStateRecord {
  if (!isObject(rawValue)) {
    return { ...defaultTutorialState };
  }

  return {
    completedVersion: typeof rawValue.completedVersion === "string" ? rawValue.completedVersion : null,
    dismissedVersion: typeof rawValue.dismissedVersion === "string" ? rawValue.dismissedVersion : null
  };
}

async function loadTutorialState(): Promise<void> {
  const stored = await chrome.storage.local.get(tutorialStorageKey);
  tutorialState = sanitizeTutorialState(stored[tutorialStorageKey]);
}

async function persistTutorialState(nextState: TutorialStateRecord): Promise<void> {
  tutorialState = nextState;
  await chrome.storage.local.set({
    [tutorialStorageKey]: tutorialState
  });
}

function shouldAutoOpenTutorial(): boolean {
  return tutorialState.completedVersion !== tutorialVersion && tutorialState.dismissedVersion !== tutorialVersion;
}

function clearTutorialPositionTimer(): void {
  if (tutorialPositionTimer !== null) {
    window.clearTimeout(tutorialPositionTimer);
    tutorialPositionTimer = null;
  }
}

function clearTutorialTargetHighlight(): void {
  if (!tutorialActiveTarget) {
    return;
  }
  tutorialActiveTarget.removeAttribute("data-tutorial-active");
  tutorialActiveTarget = null;
}

function resolveTutorialTarget(step: TutorialStep): HTMLElement | null {
  return document.querySelector<HTMLElement>(step.targetSelector);
}

function highlightTutorialTarget(target: HTMLElement | null): void {
  if (tutorialActiveTarget === target) {
    return;
  }

  clearTutorialTargetHighlight();
  if (!target) {
    return;
  }

  target.setAttribute("data-tutorial-active", "true");
  tutorialActiveTarget = target;
}

function queueTutorialPositionUpdate(delayMs = 0): void {
  clearTutorialPositionTimer();
  tutorialPositionTimer = window.setTimeout(() => {
    tutorialPositionTimer = null;
    positionTutorialOverlay();
  }, delayMs);
}

function positionTutorialOverlay(): void {
  if (!tutorialActive) {
    return;
  }

  const step = tutorialSteps[tutorialStepIndex];
  const target = resolveTutorialTarget(step);
  if (!target) {
    return;
  }

  const rect = target.getBoundingClientRect();
  const spotlightPadding = step.spotlightPadding ?? 12;
  const spotlightLeft = clamp(rect.left - spotlightPadding, 8, Math.max(8, window.innerWidth - 24));
  const spotlightTop = clamp(rect.top - spotlightPadding, 8, Math.max(8, window.innerHeight - 24));
  const spotlightWidth = Math.min(rect.width + spotlightPadding * 2, window.innerWidth - spotlightLeft - 8);
  const spotlightHeight = Math.min(rect.height + spotlightPadding * 2, window.innerHeight - spotlightTop - 8);

  Object.assign(elements.tutorialSpotlight.style, {
    left: `${spotlightLeft}px`,
    top: `${spotlightTop}px`,
    width: `${Math.max(spotlightWidth, 120)}px`,
    height: `${Math.max(spotlightHeight, 76)}px`
  });

  const cardRect = elements.tutorialCard.getBoundingClientRect();
  const viewportPadding = 16;
  const cardWidth = cardRect.width || Math.min(360, window.innerWidth - viewportPadding * 2);
  const cardHeight = cardRect.height || 220;
  const spaceBelow = window.innerHeight - rect.bottom;
  const cardTop =
    spaceBelow >= cardHeight + 28
      ? rect.bottom + 18
      : Math.max(viewportPadding, rect.top - cardHeight - 18);
  const cardLeft = clamp(rect.left, viewportPadding, Math.max(viewportPadding, window.innerWidth - cardWidth - viewportPadding));

  Object.assign(elements.tutorialCard.style, {
    left: `${cardLeft}px`,
    top: `${cardTop}px`
  });
}

function renderTutorialStep(options?: { scroll?: boolean }): void {
  if (!tutorialActive) {
    return;
  }

  const step = tutorialSteps[tutorialStepIndex];
  const target = resolveTutorialTarget(step);
  highlightTutorialTarget(target);

  elements.tutorialStepCounter.textContent = `${tutorialStepIndex + 1} / ${tutorialSteps.length}`;
  elements.tutorialTitle.textContent = step.title;
  elements.tutorialDescription.textContent = step.description;
  elements.tutorialNext.textContent = tutorialStepIndex === tutorialSteps.length - 1 ? "完成" : "下一步";

  if (target && options?.scroll !== false) {
    target.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest"
    });
  }

  positionTutorialOverlay();
  if (target && options?.scroll !== false) {
    queueTutorialPositionUpdate(260);
  }
}

function hideTutorialOverlay(): void {
  tutorialActive = false;
  clearTutorialPositionTimer();
  clearTutorialTargetHighlight();
  if (elements.tutorialOverlay.contains(document.activeElement)) {
    if (elements.openTutorialButton instanceof HTMLElement) {
      elements.openTutorialButton.focus({ preventScroll: true });
    } else {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
  }
  elements.tutorialOverlay.setAttribute("inert", "");
  elements.tutorialOverlay.hidden = true;
  elements.tutorialOverlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("tutorial-open");
  tutorialPreviouslyFocusedElement?.focus?.({ preventScroll: true });
  tutorialPreviouslyFocusedElement = null;
}

async function dismissTutorial(): Promise<void> {
  const nextState =
    tutorialState.completedVersion === tutorialVersion
      ? tutorialState
      : {
          ...tutorialState,
          dismissedVersion: tutorialVersion
        };
  await persistTutorialState(nextState);
  hideTutorialOverlay();
}

async function completeTutorial(): Promise<void> {
  await persistTutorialState({
    completedVersion: tutorialVersion,
    dismissedVersion: null
  });
  hideTutorialOverlay();
}

function openTutorial(options?: { startIndex?: number; scroll?: boolean }): void {
  tutorialStepIndex = clamp(options?.startIndex ?? 0, 0, tutorialSteps.length - 1);
  tutorialActive = true;
  tutorialPreviouslyFocusedElement =
    document.activeElement instanceof HTMLElement && !elements.tutorialOverlay.contains(document.activeElement)
      ? document.activeElement
      : null;
  elements.tutorialOverlay.hidden = false;
  elements.tutorialOverlay.removeAttribute("inert");
  elements.tutorialOverlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("tutorial-open");
  renderTutorialStep({ scroll: options?.scroll !== false });
  window.setTimeout(() => {
    elements.tutorialClose.focus({ preventScroll: true });
  }, 0);
}

function advanceTutorial(): void {
  if (tutorialStepIndex >= tutorialSteps.length - 1) {
    void completeTutorial();
    return;
  }

  tutorialStepIndex += 1;
  renderTutorialStep({ scroll: true });
}

function currentPlaybackState(): PlaybackState {
  if (elements.video.error) {
    return "error";
  }
  if (!elements.video.currentSrc) {
    return "idle";
  }
  if (elements.video.ended) {
    return "ended";
  }
  if (elements.video.seeking) {
    return "loading";
  }
  if (!elements.video.paused && elements.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
    return "loading";
  }
  return elements.video.paused ? "paused" : "playing";
}

function currentPlaybackTimeMs(): number {
  return Math.round((elements.video.currentTime ?? 0) * 1000);
}

function updateTransportTime(): void {
  const currentMs = currentPlaybackTimeMs();
  const durationMs = Number.isFinite(elements.video.duration) ? Math.round(elements.video.duration * 1000) : 0;
  elements.currentTime.textContent = formatMs(currentMs);
  elements.durationTime.textContent = formatMs(durationMs);
  elements.seekRange.value = durationMs > 0 ? String(Math.round((currentMs / durationMs) * 1000)) : "0";
}

function updatePlayToggle(): void {
  elements.playToggle.textContent = elements.video.paused ? "播放" : "暂停";
}

function updatePictureInPictureButton(): void {
  const pictureInPictureButtons = [elements.pipToggle, elements.pipTogglePlayer];
  if (!document.pictureInPictureEnabled) {
    for (const button of pictureInPictureButtons) {
      button.disabled = true;
      button.textContent = "画中画不可用";
    }
    return;
  }
  const activePiP = document.pictureInPictureElement === elements.video;
  for (const button of pictureInPictureButtons) {
    button.disabled = false;
    button.textContent = activePiP ? "退出画中画" : "画中画";
  }
}

function setPlaybackRate(rate: number, source: "player" | "reader-page"): void {
  const supportedRate = playbackRateSteps.find((candidate) => candidate === rate) ?? 1;
  elements.video.playbackRate = supportedRate;
  elements.playbackRate.value = String(supportedRate);
  appendLog("播放倍速已更新", { supportedRate, source });
  broadcastPlayerState(true);
}

function stepPlaybackRate(step: number, source: "player" | "reader-page"): void {
  const currentRate = Number.parseFloat(elements.playbackRate.value || String(elements.video.playbackRate || 1));
  const matchedIndex = playbackRateSteps.findIndex((candidate) => candidate >= currentRate - 0.001);
  const currentIndex = matchedIndex === -1 ? playbackRateSteps.length - 1 : matchedIndex;
  const nextIndex = clamp(currentIndex + step, 0, playbackRateSteps.length - 1);
  setPlaybackRate(playbackRateSteps[nextIndex], source);
}

function setRemoteIndexStatus(message: string): void {
  if (elements.remoteIndexStatus) {
    elements.remoteIndexStatus.textContent = message;
  }
}

function setConnectedTabsStatus(message: string): void {
  elements.connectedTabsStatus.textContent = message;
}

function updateRemoteCandidateControlState(): void {
  if (!elements.remoteManifestCandidate || !elements.loadRemoteCandidateButton) {
    return;
  }
  const hasSelection = Boolean(elements.remoteManifestCandidate.value);
  elements.loadRemoteCandidateButton.disabled = !hasSelection;
}

function updateConnectedTabsControlState(): void {
  const selectedTabId = Number.parseInt(elements.pageTabSelect.value, 10);
  const hasSelection = Number.isFinite(selectedTabId) && selectedTabId > 0;
  elements.bindSelectedPageButton.disabled = !hasSelection;
}

function createSyntheticConnectedTab(pageContextValue: AimReadPageContext, tabId: number | null): ConnectedAimReadTab {
  return {
    tabId: tabId ?? -1,
    windowId: -1,
    active: true,
    title: pageContextValue.title,
    url: pageContextValue.articleUrl,
    articleId: pageContextValue.articleId,
    categoryId: pageContextValue.categoryId,
    paragraphCount: pageContextValue.paragraphs.length,
    preferred: true,
    capturedAt: pageContextValue.capturedAt
  };
}

function createRecoveredConnectedTab(pageContextValue: AimReadPageContext, tab: chrome.tabs.Tab): ConnectedAimReadTab | null {
  if (typeof tab.id !== "number") {
    return null;
  }
  return {
    tabId: tab.id,
    windowId: tab.windowId ?? -1,
    active: Boolean(tab.active),
    title: pageContextValue.title,
    url: pageContextValue.articleUrl,
    articleId: pageContextValue.articleId,
    categoryId: pageContextValue.categoryId,
    paragraphCount: pageContextValue.paragraphs.length,
    preferred: boundPageTabId === tab.id || activePageTabId === tab.id,
    capturedAt: pageContextValue.capturedAt
  };
}

function resolveArticleIdFromUrlString(urlValue: string): number | null {
  try {
    const match = new URL(urlValue).pathname.match(/\/daily-feed\/(\d+)/);
    if (!match) {
      return null;
    }
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveCategoryIdFromUrlString(urlValue: string): number | null {
  try {
    const rawValue = new URL(urlValue).searchParams.get("categoryId");
    if (!rawValue) {
      return null;
    }
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function buildPageContextResolutionKey(pageContextValue: AimReadPageContext): string {
  return [
    pageContextValue.articleUrl,
    pageContextValue.articleId ?? "-",
    pageContextValue.categoryId ?? "-"
  ].join("|");
}

function scoreTabAgainstPageContext(tab: chrome.tabs.Tab, pageContextValue: AimReadPageContext): number {
  const tabUrl = tab.url ?? "";
  if (!tabUrl.startsWith("https://aim-read.top/")) {
    return -1;
  }

  let score = 0;
  if (tabUrl === pageContextValue.articleUrl) {
    score += 100;
  }

  const tabArticleId = resolveArticleIdFromUrlString(tabUrl);
  const tabCategoryId = resolveCategoryIdFromUrlString(tabUrl);
  if (pageContextValue.articleId !== null && tabArticleId === pageContextValue.articleId) {
    score += 60;
  }
  if (pageContextValue.categoryId !== null && tabCategoryId === pageContextValue.categoryId) {
    score += 25;
  }
  if (tab.active) {
    score += 8;
  }
  return score;
}

async function resolvePageContextTabIdFromBrowser(pageContextValue: AimReadPageContext): Promise<void> {
  const resolutionKey = buildPageContextResolutionKey(pageContextValue);
  if (pageContextTabResolutionInFlight && pageContextTabResolutionKey === resolutionKey) {
    return pageContextTabResolutionInFlight;
  }

  pageContextTabResolutionKey = resolutionKey;
  pageContextTabResolutionInFlight = (async () => {
    try {
      const tabs = await chrome.tabs.query({ url: ["https://aim-read.top/*"] });
      const resolvedTab =
        tabs
          .map((tab) => ({ tab, score: scoreTabAgainstPageContext(tab, pageContextValue) }))
          .filter((entry) => entry.score > 0 && typeof entry.tab.id === "number")
          .sort((left, right) => right.score - left.score)[0]?.tab ?? null;

      if (!resolvedTab || typeof resolvedTab.id !== "number") {
        return;
      }

      const resolvedTabId = resolvedTab.id;
      const tabAlreadyKnown = connectedTabs.some((tab) => tab.tabId === resolvedTabId);
      let shouldRender = false;

      if (activePageTabId !== resolvedTabId) {
        activePageTabId = resolvedTabId;
        shouldRender = true;
      }
      if (boundPageTabId === null || boundPageTabId === activePageTabId) {
        if (boundPageTabId !== resolvedTabId) {
          boundPageTabId = resolvedTabId;
          shouldRender = true;
        }
      }

      if (!tabAlreadyKnown) {
        const recoveredTab = createRecoveredConnectedTab(pageContextValue, resolvedTab);
        if (recoveredTab) {
          connectedTabs = sortConnectedTabs([...connectedTabs, recoveredTab]);
          shouldRender = true;
        }
      }

      if (shouldRender) {
        renderConnectedTabs();
        renderCurrentSyncDetails(currentPlaybackTimeMs());
      }

      requestConnectedTabs();
    } catch (error) {
      appendLog("根据页面快照反查真实阅读页失败", {
        message: error instanceof Error ? error.message : String(error),
        articleUrl: pageContextValue.articleUrl
      });
    } finally {
      pageContextTabResolutionInFlight = null;
      if (pageContextTabResolutionKey === resolutionKey) {
        pageContextTabResolutionKey = null;
      }
    }
  })();

  return pageContextTabResolutionInFlight;
}

function sortConnectedTabs(tabs: ConnectedAimReadTab[]): ConnectedAimReadTab[] {
  return [...tabs].sort((left, right) => {
    if (left.preferred !== right.preferred) {
      return left.preferred ? -1 : 1;
    }
    if (left.active !== right.active) {
      return left.active ? -1 : 1;
    }
    return left.tabId - right.tabId;
  });
}

function deriveEffectiveConnectedTabs(): ConnectedAimReadTab[] {
  const tabsById = new Map<number, ConnectedAimReadTab>();
  for (const tab of connectedTabs) {
    tabsById.set(tab.tabId, tab);
  }

  if (pageContext) {
    const syntheticTab = createSyntheticConnectedTab(pageContext, activePageTabId ?? boundPageTabId);
    if (syntheticTab.tabId > 0 && tabsById.has(syntheticTab.tabId)) {
      const current = tabsById.get(syntheticTab.tabId);
      if (current) {
        tabsById.set(syntheticTab.tabId, {
          ...current,
          title: syntheticTab.title,
          url: syntheticTab.url,
          articleId: syntheticTab.articleId,
          categoryId: syntheticTab.categoryId,
          paragraphCount: syntheticTab.paragraphCount,
          capturedAt: syntheticTab.capturedAt
        });
      }
    } else {
      tabsById.set(syntheticTab.tabId, syntheticTab);
    }
  }

  return sortConnectedTabs(Array.from(tabsById.values()));
}

function resolveSelectedConnectedTab(tabs: ConnectedAimReadTab[]): ConnectedAimReadTab | null {
  if (tabs.length === 0) {
    return null;
  }
  if (boundPageTabId !== null) {
    const boundTab = tabs.find((tab) => tab.tabId === boundPageTabId);
    if (boundTab) {
      return boundTab;
    }
  }
  if (activePageTabId !== null) {
    const activeTab = tabs.find((tab) => tab.tabId === activePageTabId);
    if (activeTab) {
      return activeTab;
    }
  }
  return tabs.find((tab) => tab.preferred) ?? tabs[0] ?? null;
}

function isConnectedTabBackedByLivePort(tab: ConnectedAimReadTab | null): boolean {
  return Boolean(tab && tab.tabId > 0 && connectedTabs.some((candidate) => candidate.tabId === tab.tabId));
}

function resolveSelectedConnectedTabLabel(tab: ConnectedAimReadTab | null): string {
  if (!tab) {
    return "当前页面";
  }
  return tab.tabId > 0 ? `tab#${tab.tabId}` : "当前页面快照";
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function formatRemoteCandidateLabel(candidate: RemoteManifestCandidate): string {
  const metaParts = [
    candidate.articleId !== null ? `article#${candidate.articleId}` : null,
    candidate.categoryId !== null ? `category#${candidate.categoryId}` : null,
    candidate.tags.length > 0 ? `标签 ${candidate.tags.slice(0, 2).join("/")}` : null
  ].filter((value): value is string => Boolean(value));
  const description = metaParts.length > 0 ? ` · ${metaParts.join(" · ")}` : "";
  return createExcerpt(`${candidate.title} (${candidate.slug})${description}`, 110);
}

function formatRemoteCandidateSummary(candidate: RemoteManifestCandidate): string {
  const parts = [
    `${candidate.title} (${candidate.slug})`,
    candidate.articleId !== null ? `article#${candidate.articleId}` : null,
    candidate.categoryId !== null ? `category#${candidate.categoryId}` : null,
    candidate.description || null
  ].filter((value): value is string => Boolean(value));
  return createExcerpt(parts.join(" · "), 180);
}

function syncRemoteCandidateStatus(selectedUrl?: string | null): void {
  if (remoteManifestCandidates.length === 0) {
    setRemoteIndexStatus("还没有可用候选。");
    return;
  }

  const selectedCandidate =
    remoteManifestCandidates.find((candidate) => candidate.url === (selectedUrl ?? elements.remoteManifestCandidate?.value)) ??
    remoteManifestCandidates[0] ??
    null;
  if (!selectedCandidate) {
    setRemoteIndexStatus("还没有可用候选。");
    return;
  }

  const sourceLabel = remoteIndexSourceUrl ? `已从 ${remoteIndexSourceUrl} 载入` : "已载入";
  setRemoteIndexStatus(`${sourceLabel} ${remoteManifestCandidates.length} 个候选，当前优先：${formatRemoteCandidateSummary(selectedCandidate)}`);
}

function resolvePageBindingUiState(): {
  effectiveTabs: ConnectedAimReadTab[];
  selectedTab: ConnectedAimReadTab | null;
  connectedTabsStatus: string;
  bindingStatus: string;
  pageMatchStatus: string;
} {
  const effectiveTabs = deriveEffectiveConnectedTabs();
  const selectedTab = resolveSelectedConnectedTab(effectiveTabs);
  const selectedTabLabel = resolveSelectedConnectedTabLabel(selectedTab);
  const hasRealTabs = effectiveTabs.some((tab) => tab.tabId > 0);
  const selectedTabBackedByLivePort = isConnectedTabBackedByLivePort(selectedTab);
  const isSnapshotFallback = Boolean(pageContext && !selectedTabBackedByLivePort);

  let connectedTabsStatus = "当前还没有可绑定的页面。";
  if (effectiveTabs.length > 0) {
    if (isSnapshotFallback && !hasRealTabs) {
      connectedTabsStatus = "已连接当前页面快照，等待页面列表同步。";
    } else if (isSnapshotFallback) {
      connectedTabsStatus = `已发现 ${effectiveTabs.length} 个页面，当前先跟随 ${selectedTabLabel} 的快照，等待页面列表同步。`;
    } else if (selectedTab) {
      connectedTabsStatus = `已发现 ${effectiveTabs.length} 个页面，当前绑定 ${selectedTabLabel}。`;
    } else {
      connectedTabsStatus = `已发现 ${effectiveTabs.length} 个页面，请选择要绑定的目标。`;
    }
  }

  if (!pageContext) {
    return {
      effectiveTabs,
      selectedTab,
      connectedTabsStatus,
      bindingStatus: subtitleAutoBuildEnabled ? "等待目标阅读页连接" : "等待页面连接",
      pageMatchStatus: effectiveTabs.length > 0 ? "已发现页面，但当前尚未拿到快照" : "未获取 aim-read 页面快照"
    };
  }

  if (!manifest) {
    const waitingFullArticleLabel =
      articleSnapshotRequestIssuedAt !== null
        ? `正在获取全文（已等待 ${Math.max(1, Math.round((Date.now() - articleSnapshotRequestIssuedAt) / 1000))} 秒）并自动匹配`
        : "等待全文抓取并自动匹配";
    const waitingLabel = subtitleAutoBuildEnabled
      ? isSnapshotFallback
        ? `已连接阅读页快照 (${selectedTabLabel})，${waitingFullArticleLabel}`
        : `已连接阅读页 (${selectedTabLabel})，${waitingFullArticleLabel}`
      : isSnapshotFallback
        ? `已连接阅读页快照 (${selectedTabLabel})，等待页面列表同步并加载清单`
        : `已连接阅读页 (${selectedTabLabel})，等待清单`;
    return {
      effectiveTabs,
      selectedTab,
      connectedTabsStatus,
      bindingStatus: waitingLabel,
      pageMatchStatus: `当前页面 articleId ${pageContext.articleId ?? "-"} · categoryId ${pageContext.categoryId ?? "-"}`
    };
  }

  const sourceArticleId = manifest.source.articleId ?? null;
  const sourceCategoryId = manifest.source.categoryId ?? null;
  const sameArticle = sourceArticleId !== null && pageContext.articleId === sourceArticleId;
  const sameCategory = sourceCategoryId === null || pageContext.categoryId === sourceCategoryId;

  if (sameArticle && sameCategory) {
    return {
      effectiveTabs,
      selectedTab,
      connectedTabsStatus,
      bindingStatus: isSnapshotFallback
        ? `已按页面快照绑定 (${selectedTabLabel})，等待页面列表同步`
        : `已绑定当前阅读页 (${selectedTabLabel})`,
      pageMatchStatus: `articleId ${pageContext.articleId ?? "-"} · categoryId ${pageContext.categoryId ?? "-"}`
    };
  }

  if (sourceArticleId === null && manifest.source.articleUrl && manifest.source.articleUrl === pageContext.articleUrl) {
    return {
      effectiveTabs,
      selectedTab,
      connectedTabsStatus,
      bindingStatus: isSnapshotFallback
        ? `已按页面快照 URL 绑定 (${selectedTabLabel})，等待页面列表同步`
        : `已按 URL 绑定当前页面 (${selectedTabLabel})`,
      pageMatchStatus: "清单未声明 articleId，已按 articleUrl 精确匹配"
    };
  }

  return {
    effectiveTabs,
    selectedTab,
    connectedTabsStatus,
    bindingStatus: isSnapshotFallback
      ? `当前页面快照与清单不一致 (${selectedTabLabel})，等待页面列表同步`
      : `当前页面与清单不一致 (${selectedTabLabel})`,
    pageMatchStatus: `清单 articleId ${sourceArticleId ?? "-"} / categoryId ${sourceCategoryId ?? "-"}，当前为 ${pageContext.articleId ?? "-"} / ${pageContext.categoryId ?? "-"}`
  };
}

function applyPageBindingUiState(): void {
  const uiState = resolvePageBindingUiState();
  setConnectedTabsStatus(uiState.connectedTabsStatus);
  elements.bindingStatus.textContent = uiState.bindingStatus;
  elements.pageMatchStatus.textContent = uiState.pageMatchStatus;
}

function resolveManifestSourceLabel(manifestValue: EpisodeSyncManifest | null): string {
  if (!manifestValue) {
    return "-";
  }
  if (manifestOriginKind === "runtime-subtitle") {
    const parts = ["字幕运行时匹配"];
    if (typeof manifestValue.source.articleId === "number") {
      parts.push(`article#${manifestValue.source.articleId}`);
    }
    return parts.join(" · ");
  }
  const parts = [manifestValue.source.slug];
  if (typeof manifestValue.source.articleId === "number") {
    parts.push(`article#${manifestValue.source.articleId}`);
  }
  if (typeof manifestValue.source.categoryId === "number") {
    parts.push(`category#${manifestValue.source.categoryId}`);
  }
  return parts.join(" · ");
}

function resolveCoverageLabel(manifestValue: EpisodeSyncManifest | null): string {
  if (!manifestValue) {
    return "-";
  }
  const mappedCount = manifestValue.sync.filter((entry) => entry.transcriptSegmentIndexes.length > 0).length;
  const smoothedCount = manifestValue.sync.length - mappedCount;
  const articleParagraphCount = manifestValue.article?.paragraphs.length ?? manifestValue.sync.length;
  return `${mappedCount}/${articleParagraphCount} 命中，${smoothedCount} 平滑`;
}

function updatePageContext(pageContextValue: AimReadPageContext | null, tabId: number | null): void {
  if (
    pageContextValue &&
    articleSnapshot &&
    ((articleSnapshot.articleId !== null && pageContextValue.articleId !== articleSnapshot.articleId) ||
      articleSnapshot.articleUrl !== pageContextValue.articleUrl)
  ) {
    articleSnapshot = null;
    articleSnapshotError = null;
  }

  pageContext = pageContextValue;
  if (typeof tabId === "number") {
    activePageTabId = tabId;
    if (boundPageTabId === null) {
      boundPageTabId = tabId;
    }
  } else if (pageContextValue) {
    void resolvePageContextTabIdFromBrowser(pageContextValue);
  } else if (!pageContextValue) {
    activePageTabId = null;
  }
  elements.exportPageContextButton.disabled = !pageContextValue;
  elements.pageTitle.textContent = pageContextValue?.title ?? "未检测";
  elements.pageUrlDisplay.textContent = pageContextValue?.articleUrl ?? "-";
  elements.pageParagraphCount.textContent = String(pageContextValue?.paragraphs.length ?? 0);
  if (pageContextValue) {
    appendLog("已更新当前页面快照", {
      tabId: activePageTabId,
      articleUrl: pageContextValue.articleUrl,
      paragraphCount: pageContextValue.paragraphs.length
    });
  }
  renderConnectedTabs();
  renderCurrentSyncDetails(currentPlaybackTimeMs());
  if (subtitleAutoBuildEnabled && pageContextValue) {
    maybeRebuildRuntimeSubtitleManifest();
  }
}

function setSubtitleStatus(message: string): void {
  elements.subtitleStatus.textContent = message;
}

function updateArticleSnapshot(snapshot: AimReadArticleSnapshot | null, error: string | null, tabId: number | null): void {
  articleSnapshot = snapshot;
  articleSnapshotError = error;
  if (snapshot || error) {
    articleSnapshotRequestIssuedAt = null;
    articleSnapshotLastRequestedAt = 0;
  }
  if (typeof tabId === "number") {
    activePageTabId = tabId;
    if (boundPageTabId === null) {
      boundPageTabId = tabId;
    }
  } else if (snapshot && pageContext) {
    void resolvePageContextTabIdFromBrowser(pageContext);
  } else if (!snapshot && !pageContext) {
    activePageTabId = null;
  }

  if (snapshot) {
    appendLog("已更新全文文章快照", {
      tabId: activePageTabId,
      articleId: snapshot.articleId,
      paragraphCount: snapshot.paragraphs.length,
      totalPages: snapshot.pageInfo?.totalPages ?? null
    });
  } else if (error) {
    appendLog("全文文章快照获取失败", {
      tabId: activePageTabId,
      message: error
    });
  }

  if (subtitleAutoBuildEnabled) {
    maybeRebuildRuntimeSubtitleManifest();
  }
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
  postRuntimeMessage({ type: "REQUEST_ACTIVE_ARTICLE_SNAPSHOT" } satisfies RuntimeMessage);
}

function rebuildManifestLookups(manifestValue: EpisodeSyncManifest): void {
  transcriptSegmentsByIndex = new Map(
    manifestValue.transcript.segments.map((segment) => [segment.index, segment] satisfies [number, TranscriptSegment])
  );
  articleParagraphsByIndex = new Map(
    (manifestValue.article?.paragraphs ?? []).map((paragraph) => [
      paragraph.paragraphIndex,
      paragraph
    ] satisfies [number, ArticleParagraph])
  );
}

function resolveArticleParagraph(paragraphIndex: number): ArticleParagraph | null {
  return (
    articleParagraphsByIndex.get(paragraphIndex) ??
    pageContext?.paragraphs.find((paragraph) => paragraph.paragraphIndex === paragraphIndex) ??
    null
  );
}

function resolveTranscriptText(syncEntry: SyncEntry): string {
  return syncEntry.transcriptSegmentIndexes
    .map((segmentIndex) => transcriptSegmentsByIndex.get(segmentIndex)?.text ?? "")
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveSyncNote(syncEntry: SyncEntry, articleParagraph: ArticleParagraph | null): string {
  if (syncEntry.transcriptSegmentIndexes.length === 0) {
    return "这一段是基于上下文做的平滑补段，没有直接 transcript 命中。";
  }
  if (articleParagraph?.translation) {
    return `译文：${articleParagraph.translation}`;
  }
  return `命中 ${syncEntry.transcriptSegmentIndexes.length} 个 transcript 片段。`;
}

function syncQualityClass(score: number): string {
  if (score >= 0.85) {
    return "sync-quality-good";
  }
  if (score >= 0.5) {
    return "sync-quality-mid";
  }
  return "sync-quality-low";
}

function updateOverviewFields(): void {
  elements.playbackState.textContent = playbackStateLabel(currentPlaybackState());
  elements.syncCoverage.textContent = resolveCoverageLabel(manifest);
  elements.manifestSource.textContent = resolveManifestSourceLabel(manifest);
  applyPageBindingUiState();
}

function renderRemoteManifestCandidates(selectedUrl?: string | null): void {
  if (!elements.remoteManifestCandidate) {
    return;
  }
  elements.remoteManifestCandidate.replaceChildren();
  if (remoteManifestCandidates.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "没有可用候选";
    elements.remoteManifestCandidate.append(option);
    updateRemoteCandidateControlState();
    return;
  }

  for (const candidate of remoteManifestCandidates) {
    const option = document.createElement("option");
    option.value = candidate.url;
    option.textContent = formatRemoteCandidateLabel(candidate);
    option.title = `${formatRemoteCandidateSummary(candidate)}\n${candidate.url}`;
    if (selectedUrl && candidate.url === selectedUrl) {
      option.selected = true;
    }
    elements.remoteManifestCandidate.append(option);
  }

  if (!elements.remoteManifestCandidate.value) {
    elements.remoteManifestCandidate.value = selectedUrl ?? remoteManifestCandidates[0]?.url ?? "";
  }
  syncRemoteCandidateStatus(elements.remoteManifestCandidate.value);
  updateRemoteCandidateControlState();
}

function renderConnectedTabs(): void {
  const uiState = resolvePageBindingUiState();
  const { effectiveTabs, selectedTab } = uiState;
  elements.pageTabSelect.replaceChildren();
  if (effectiveTabs.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "等待页面连接";
    elements.pageTabSelect.append(option);
    applyPageBindingUiState();
    updateConnectedTabsControlState();
    return;
  }

  for (const tab of effectiveTabs) {
    const option = document.createElement("option");
    option.value = tab.tabId > 0 ? String(tab.tabId) : "";
    const tag = tab.preferred ? "已绑定" : tab.active ? "当前窗口活动页" : "候选";
    option.textContent = `${tab.title} · article ${tab.articleId ?? "-"} · ${tag}`;
    option.selected = Boolean(selectedTab && selectedTab.tabId === tab.tabId);
    elements.pageTabSelect.append(option);
  }

  if (!elements.pageTabSelect.value) {
    const fallbackTabId =
      selectedTab?.tabId ??
      activePageTabId ??
      effectiveTabs[0]?.tabId;
    elements.pageTabSelect.value = fallbackTabId && fallbackTabId > 0 ? String(fallbackTabId) : "";
  }

  applyPageBindingUiState();
  updateConnectedTabsControlState();
}

function updateConnectedTabs(payload: { preferredTabId: number | null; tabs: ConnectedAimReadTab[] }): void {
  connectedTabs = payload.tabs;
  const nextPreferredTabId = payload.preferredTabId ?? payload.tabs[0]?.tabId ?? null;
  const availableTabIds = new Set(payload.tabs.map((tab) => tab.tabId));
  if (typeof nextPreferredTabId === "number") {
    boundPageTabId = nextPreferredTabId;
  } else if (!pageContext) {
    boundPageTabId = null;
  }

  if (activePageTabId === null) {
    activePageTabId = nextPreferredTabId;
  } else if (!availableTabIds.has(activePageTabId) && !pageContext) {
    activePageTabId = nextPreferredTabId;
  }

  if (boundPageTabId !== null && !availableTabIds.has(boundPageTabId) && !pageContext) {
    boundPageTabId = nextPreferredTabId;
  }
  renderConnectedTabs();
  renderCurrentSyncDetails(currentPlaybackTimeMs());
}

function resolveNearbyCenterIndex(currentTimeMs: number): number {
  if (!manifest || manifest.sync.length === 0) {
    return -1;
  }
  const activeEntry = resolveActiveSyncEntry(manifest, currentTimeMs);
  if (activeEntry) {
    return manifest.sync.findIndex((entry) => entry.paragraphIndex === activeEntry.paragraphIndex);
  }

  let low = 0;
  let high = manifest.sync.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const entry = manifest.sync[middle];
    if (currentTimeMs < entry.startMs) {
      high = middle - 1;
      continue;
    }
    low = middle + 1;
  }
  return clamp(low, 0, manifest.sync.length - 1);
}

function renderNearbySyncEntries(currentTimeMs: number, activeEntry: SyncEntry | null): void {
  elements.syncNearbyList.replaceChildren();
  if (!manifest || manifest.sync.length === 0) {
    const empty = document.createElement("p");
    empty.className = "sync-nearby-excerpt";
    empty.textContent = "加载同步清单后，这里会出现当前附近的可跳转段落。";
    elements.syncNearbyList.append(empty);
    return;
  }

  const centerIndex = resolveNearbyCenterIndex(currentTimeMs);
  const startIndex = Math.max(0, centerIndex - 3);
  const endIndex = Math.min(manifest.sync.length, centerIndex + 4);
  const fragment = document.createDocumentFragment();

  for (const entry of manifest.sync.slice(startIndex, endIndex)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sync-nearby-item";
    if (activeEntry && activeEntry.paragraphIndex === entry.paragraphIndex) {
      button.classList.add("is-active");
    }
    button.dataset.startMs = String(entry.startMs);
    button.dataset.paragraphIndex = String(entry.paragraphIndex);

    const header = document.createElement("div");
    header.className = "sync-nearby-head";

    const title = document.createElement("span");
    title.className = "sync-nearby-title";
    title.textContent = `段落 #${entry.paragraphIndex}`;

    const range = document.createElement("span");
    range.className = "sync-nearby-meta";
    range.textContent = `${formatMs(entry.startMs)} - ${formatMs(entry.endMs)}`;
    header.append(title, range);

    const meta = document.createElement("div");
    meta.className = "sync-nearby-meta";
    meta.textContent =
      entry.transcriptSegmentIndexes.length > 0
        ? `Transcript #${entry.transcriptSegmentIndexes.join(", ")}`
        : "平滑补段";

    const quality = document.createElement("span");
    quality.className = `sync-nearby-meta ${syncQualityClass(entry.alignmentScore)}`;
    quality.textContent = `对齐 ${formatAlignmentScore(entry.alignmentScore)}`;
    meta.append(" · ", quality);

    const excerpt = document.createElement("p");
    excerpt.className = "sync-nearby-excerpt";
    excerpt.textContent = createExcerpt(
      resolveArticleParagraph(entry.paragraphIndex)?.text || resolveTranscriptText(entry) || "暂无文本预览",
      160
    );

    button.append(header, meta, excerpt);
    fragment.append(button);
  }

  elements.syncNearbyList.append(fragment);
}

function renderCurrentSyncDetails(currentTimeMs: number): void {
  updateOverviewFields();
  if (!manifest) {
    elements.activeParagraph.textContent = "-";
    elements.currentTranscriptPreview.textContent = "等待同步清单和视频。";
    elements.currentArticlePreview.textContent = "等待当前页面快照。";
    elements.currentSyncRange.textContent = "-";
    elements.currentSyncScore.textContent = "-";
    elements.currentSyncSegments.textContent = "-";
    elements.currentSyncNote.textContent = "当前无可展示映射。加载视频与同步清单后会自动更新。";
    renderNearbySyncEntries(currentTimeMs, null);
    return;
  }

  const syncEntry = resolveActiveSyncEntry(manifest, currentTimeMs);
  elements.activeParagraph.textContent = syncEntry ? String(syncEntry.paragraphIndex) : "-";

  if (!syncEntry) {
    elements.currentTranscriptPreview.textContent = "当前时间尚未落在任何映射区间内。";
    elements.currentArticlePreview.textContent = articleFallbackText;
    elements.currentSyncRange.textContent = "-";
    elements.currentSyncScore.textContent = "-";
    elements.currentSyncSegments.textContent = "-";
    elements.currentSyncNote.textContent = "你可以点击下方附近段落，或拖动时间轴进入已映射区域。";
    renderNearbySyncEntries(currentTimeMs, null);
    return;
  }

  const articleParagraph = resolveArticleParagraph(syncEntry.paragraphIndex);
  const transcriptText = resolveTranscriptText(syncEntry);
  elements.currentTranscriptPreview.textContent = transcriptText || transcriptFallbackText;
  elements.currentArticlePreview.textContent =
    articleParagraph?.translation
      ? `${articleParagraph.text}\n\n${articleParagraph.translation}`
      : articleParagraph?.text ?? articleFallbackText;
  elements.currentSyncRange.textContent = `#${syncEntry.paragraphIndex} · ${formatMs(syncEntry.startMs)} - ${formatMs(syncEntry.endMs)}`;
  elements.currentSyncScore.textContent = formatAlignmentScore(syncEntry.alignmentScore);
  elements.currentSyncSegments.textContent =
    syncEntry.transcriptSegmentIndexes.length > 0
      ? `Transcript #${syncEntry.transcriptSegmentIndexes.join(", ")}`
      : "无直接 transcript 命中";
  elements.currentSyncNote.textContent = resolveSyncNote(syncEntry, articleParagraph);
  renderNearbySyncEntries(currentTimeMs, syncEntry);
}

function broadcastPlayerState(force = false): void {
  const now = Date.now();
  if (!force && now - lastBroadcastAt < 120) {
    renderCurrentSyncDetails(currentPlaybackTimeMs());
    return;
  }
  lastBroadcastAt = now;

  const currentTimeMs = currentPlaybackTimeMs();
  const syncEntry = resolveActiveSyncEntry(manifest, currentTimeMs);
  postRuntimeMessage({
    type: "PLAYER_STATE_UPDATE",
    payload: {
      currentTimeMs,
      state: currentPlaybackState(),
      activeParagraphIndex: syncEntry?.paragraphIndex ?? null,
      manifestSlug: manifest?.source.slug ?? null,
      playbackRate: elements.video.playbackRate
    }
  } satisfies RuntimeMessage, { retry: false });
  renderCurrentSyncDetails(currentTimeMs);
}

function validateSegment(segment: unknown): segment is TranscriptSegment {
  return (
    isObject(segment) &&
    typeof segment.index === "number" &&
    typeof segment.startMs === "number" &&
    typeof segment.endMs === "number" &&
    typeof segment.text === "string"
  );
}

function validateSyncEntry(entry: unknown): entry is SyncEntry {
  return (
    isObject(entry) &&
    typeof entry.paragraphIndex === "number" &&
    typeof entry.startMs === "number" &&
    typeof entry.endMs === "number" &&
    Array.isArray(entry.transcriptSegmentIndexes)
  );
}

function parseManifest(rawValue: unknown): EpisodeSyncManifest {
  if (!isObject(rawValue)) {
    throw new Error("Sync manifest must be an object.");
  }
  if (rawValue.version !== "1.0.0") {
    throw new Error("Unsupported sync manifest version.");
  }
  if (!isObject(rawValue.source) || typeof rawValue.source.slug !== "string") {
    throw new Error("Sync manifest is missing source.slug.");
  }
  if (
    !isObject(rawValue.transcript) ||
    typeof rawValue.transcript.mode !== "string" ||
    typeof rawValue.transcript.text !== "string" ||
    !Array.isArray(rawValue.transcript.segments) ||
    !rawValue.transcript.segments.every(validateSegment)
  ) {
    throw new Error("Sync manifest has an invalid transcript payload.");
  }
  if (!Array.isArray(rawValue.sync) || !rawValue.sync.every(validateSyncEntry)) {
    throw new Error("Sync manifest has an invalid sync array.");
  }
  return rawValue as unknown as EpisodeSyncManifest;
}

function installManifest(manifestValue: EpisodeSyncManifest, displayName: string, originKind: ManifestOriginKind): void {
  manifest = manifestValue;
  manifestOriginKind = originKind;
  rebuildManifestLookups(manifestValue);
  elements.manifestName.textContent =
    originKind === "runtime-subtitle"
      ? `${displayName} (${manifestValue.sync.length} 段运行时映射)`
      : `${displayName} (${manifestValue.sync.length} 条映射)`;
  if (elements.remoteSlug && !elements.remoteSlug.value) {
    elements.remoteSlug.value = manifestValue.source.slug;
  }
  setStatus(`已加载同步清单：${displayName}`);
  appendLog("同步清单已加载", {
    slug: manifestValue.source.slug,
    syncCount: manifestValue.sync.length
  });
  renderCurrentSyncDetails(currentPlaybackTimeMs());
  broadcastPlayerState(true);
}

async function readJsonFile(file: File): Promise<unknown> {
  return JSON.parse(await file.text());
}

function guessMimeTypeFromFileName(fileName: string): string | null {
  const extension = fileExtension(fileName);
  switch (extension) {
    case "mp4":
      return "video/mp4";
    case "m4v":
      return "video/mp4";
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "mov":
      return "video/quicktime";
    default:
      return null;
  }
}

async function applyVideoFileToPlayer(
  file: File,
  variant: VideoPlaybackVariant,
  displayName: string,
  statusMessage: string
): Promise<void> {
  if (videoObjectUrl) {
    URL.revokeObjectURL(videoObjectUrl);
  }
  videoObjectUrl = URL.createObjectURL(file);
  elements.video.pause();
  elements.video.currentTime = 0;
  elements.video.removeAttribute("src");
  elements.video.load();
  currentVideoVariant = variant;
  elements.videoName.textContent = displayName;
  const detectedMimeType = file.type || guessMimeTypeFromFileName(file.name) || "未知";
  const canPlay = detectedMimeType === "未知" ? "maybe" : elements.video.canPlayType(detectedMimeType);
  elements.video.src = videoObjectUrl;
  elements.video.load();
  if (canPlay === "") {
    setStatus(`当前浏览器内核很可能不支持直接解码 ${file.name} (${detectedMimeType})。`);
    appendLog("浏览器报告当前文件格式可能无法直接解码", {
      fileName: file.name,
      detectedMimeType
    });
  } else {
    setStatus(statusMessage);
  }
  appendLog("本地视频已加载", {
    fileName: file.name,
    displayName,
    detectedMimeType,
    canPlay,
    variant
  });
  updatePictureInPictureButton();
}

async function playOriginalVideoFile(): Promise<void> {
  if (!sourceVideoFile) {
    throw new Error("请先拖入视频文件。");
  }

  const directPlaySuffix = sourceVideoAssessment?.isRecommendedProfile
    ? "推荐基线命中，已直接播放原文件。"
    : "已无视风险直接播放原文件。";
  await applyVideoFileToPlayer(sourceVideoFile, "original", sourceVideoFile.name, directPlaySuffix);
}

async function playProcessedVideoFile(): Promise<void> {
  if (!processedVideoFile) {
    throw new Error("当前还没有可播放的预处理结果。");
  }

  await applyVideoFileToPlayer(
    processedVideoFile,
    "processed",
    `${processedVideoFile.name}（转码版）`,
    `已加载预处理结果：${processedVideoFile.name}`
  );
}

function buildBrowserFfmpegStatusMessage(event: BrowserFfmpegStatusEvent): string {
  switch (event.phase) {
    case "loading-core":
      return "正在装载扩展内置 FFmpeg Core";
    case "ready":
      return "内置 FFmpeg Core 已就绪";
    case "writing-input":
      return event.detail?.message ?? "正在写入输入文件";
    case "probing":
      return event.detail?.message ?? "正在分析媒体流";
    case "transcoding":
      return event.detail?.message ?? "正在预处理媒体流";
    case "finalizing-output":
      return event.detail?.message ?? "正在封口输出文件";
    case "reading-output":
      return event.detail?.message ?? "正在读取输出文件";
    case "completed":
      return event.detail?.message ?? "处理完成";
    default:
      return "处理中";
  }
}

async function loadVideoFile(file: File): Promise<void> {
  if (videoTranscodeBusy) {
    throw new Error("当前仍在预处理上一个视频，请等待完成后再切换。");
  }

  const currentToken = ++videoInspectionToken;
  sourceVideoFile = file;
  videoInspectionBusy = true;
  resetVideoDecisionState(file.name);
  updateVideoFileSelectionStatus(`已载入：${file.name}（正在检测）`);
  setStatus(`正在检测本地视频：${file.name}`);
  appendLog("开始检测本地视频", { fileName: file.name, size: file.size, type: file.type || "unknown" });

  try {
    const probe = await browserFfmpegService.inspectFile(file, {
      onStatusChange: (event) => {
        if (currentToken !== videoInspectionToken) {
          return;
        }
        const message = buildBrowserFfmpegStatusMessage(event);
        elements.videoProcessingStatus.textContent = message;
        setVideoProcessingProgress(message);
      },
      onLog: (message) => {
        if (currentToken !== videoInspectionToken) {
          return;
        }
        if (message.includes("Input #0") || message.includes("Video:") || message.includes("Audio:")) {
          appendLog("FFmpeg 探测日志", { message });
        }
      }
    });

    if (currentToken !== videoInspectionToken) {
      return;
    }

    const assessment = assessMediaCompatibility(file.name, probe);
    const strategy = buildMediaTranscodeStrategy(file.name, probe);
    applyProbeOutcome(file, probe, assessment, strategy);
    appendLog("视频真实流检测完成", {
      fileName: file.name,
      probe,
      assessment,
      strategy
    });

    if (assessment.isRecommendedProfile) {
      await playOriginalVideoFile();
    } else {
      setStatus("已检测到当前文件偏离推荐播放基线，请选择直接播放或一键预处理。");
    }
  } catch (error) {
    if (currentToken !== videoInspectionToken) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    applyProbeFailure(file, message);
    setStatus(`视频探测失败：${message}`);
    appendLog("视频真实流检测失败", { fileName: file.name, message });
  } finally {
    if (currentToken === videoInspectionToken) {
      videoInspectionBusy = false;
      updateVideoDecisionControls();
    }
  }
}

async function preprocessVideoFile(): Promise<void> {
  if (!sourceVideoFile) {
    throw new Error("请先拖入视频文件。");
  }
  if (!sourceVideoProbe || !sourceVideoStrategy) {
    throw new Error("当前没有可用的真实流检测结果，暂时不能预处理。");
  }
  if (videoInspectionBusy || videoTranscodeBusy) {
    throw new Error("当前已有视频任务在执行，请稍后再试。");
  }

  const sourceFile = sourceVideoFile;
  const sourceProbe = sourceVideoProbe;
  const strategy = sourceVideoStrategy;
  videoTranscodeBusy = true;
  updateVideoDecisionControls();
  elements.videoProcessingStatus.textContent = "正在本地预处理";
  setVideoProcessingProgress("准备写入视频并启动预处理...");
  setStatus(`正在本地预处理：${sourceFile.name}`);
  appendLog("开始本地预处理视频", {
    fileName: sourceFile.name,
    strategy
  });

  try {
    revokeProcessedVideoArtifact();
    const result = await browserFfmpegService.transcodeFile(sourceFile, sourceProbe, {
      onStatusChange: (event) => {
        const message = buildBrowserFfmpegStatusMessage(event);
        elements.videoProcessingStatus.textContent = message;
        if (event.phase === "finalizing-output") {
          setVideoProcessingProgress(message, 0.99);
          appendLog("FFmpeg 编码阶段完成，开始封口输出", {
            fileName: sourceFile.name
          });
          return;
        }
        if (event.phase === "reading-output") {
          setVideoProcessingProgress(message, 0.99);
          appendLog("开始读取本地预处理产物", {
            fileName: sourceFile.name
          });
          return;
        }
        if (event.phase === "completed") {
          setVideoProcessingProgress(message, 1);
          return;
        }
        setVideoProcessingProgress(message);
      },
      onProgress: ({ progress }) => {
        setVideoTranscodeProgress(describeTranscodePlan(strategy), progress);
      }
    });

    processedVideoFile = result.file;
    processedVideoObjectUrl = URL.createObjectURL(result.blob);
    elements.videoCompatibilityStatus.textContent = "已生成兼容版本";
    elements.videoCompatibilitySummary.textContent = "预处理完成，已经生成可下载、可立即播放的 HVC1 + AAC MP4。";
    elements.videoTranscodePlan.textContent = describeTranscodePlan(result.strategy);
    elements.videoProcessingStatus.textContent = "预处理完成";
    setVideoProcessingProgress(`已生成 ${result.file.name}，可以直接播放或下载。`, 1);
    appendLog("本地预处理完成", {
      sourceFileName: sourceFile.name,
      outputFileName: result.file.name,
      strategy: result.strategy,
      outputSize: result.file.size
    });
    await playProcessedVideoFile();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    elements.videoProcessingStatus.textContent = "预处理失败";
    setVideoProcessingProgress(message);
    setStatus(`视频预处理失败：${message}`);
    appendLog("视频预处理失败", { fileName: sourceFile.name, message });
    throw error;
  } finally {
    videoTranscodeBusy = false;
    updateVideoDecisionControls();
  }
}

function downloadProcessedVideo(): void {
  if (!processedVideoFile || !processedVideoObjectUrl) {
    throw new Error("当前还没有可下载的转码结果。");
  }
  const link = document.createElement("a");
  link.href = processedVideoObjectUrl;
  link.download = processedVideoFile.name;
  link.click();
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

function describeBuildProgress(progress: RuntimeManifestBuildProgress): string {
  return `${Math.round(progress.percent * 100)}% · ${progress.message}`;
}

function applyRuntimeSubtitleStatus(buildResult: RuntimeManifestBuildResult | null): void {
  if (!loadedSubtitleDocument) {
    setSubtitleStatus("未加载字幕。");
    setMatchingProgress("待命", 0);
    return;
  }

  if (!buildResult) {
    if (runtimeBuildInFlight) {
      setSubtitleStatus("字幕已载入，正在执行运行时匹配...");
      return;
    }
    if (articleSnapshotError) {
      setSubtitleStatus(`字幕已载入，等待全文文章快照：${articleSnapshotError}`);
      return;
    }
    if (!articleSnapshot) {
      if (articleSnapshotRequestIssuedAt !== null) {
        const elapsedSeconds = Math.max(1, Math.round((Date.now() - articleSnapshotRequestIssuedAt) / 1000));
        setSubtitleStatus(
          `字幕已载入，正在获取全文文章快照（已等待 ${elapsedSeconds} 秒）。如果长时间不动，通常是站点全文接口较慢，扩展会自动重试并在必要时回退。`
        );
        return;
      }
      setSubtitleStatus("字幕已载入，准备从 reader 页面拉取全文文章后自动匹配。");
      return;
    }
    setSubtitleStatus("字幕已载入，等待运行时匹配完成。");
    return;
  }

  const { stats } = buildResult;
  setMatchingProgress(`完成 · 覆盖 ${formatRatio(stats.coverageRatio)}`, 1);
  setSubtitleStatus(
    `已生成运行时清单：覆盖 ${formatRatio(stats.coverageRatio)}，命中 ${stats.matchedParagraphCount}/${stats.articleParagraphCount} 段，平滑 ${stats.smoothedParagraphCount} 段。`
  );
}

function maybeRebuildRuntimeSubtitleManifest(): void {
  if (!subtitleAutoBuildEnabled || !loadedSubtitleDocument) {
    return;
  }

  if (articleSnapshotError) {
    applyRuntimeSubtitleStatus(null);
    return;
  }

  if (!articleSnapshot) {
    applyRuntimeSubtitleStatus(null);
    requestArticleSnapshot();
    return;
  }

  const fingerprint = resolveRuntimeBuildFingerprint();
  if (!fingerprint) {
    return;
  }
  if (fingerprint === runtimeBuildFingerprint && currentRuntimeBuild) {
    applyRuntimeSubtitleStatus(currentRuntimeBuild);
    return;
  }
  if (fingerprint === runtimeBuildFailedFingerprint) {
    applyRuntimeSubtitleStatus(null);
    return;
  }
  if (runtimeBuildInFlight && fingerprint === runtimeBuildRequestedFingerprint) {
    applyRuntimeSubtitleStatus(null);
    return;
  }

  const activeBuildToken = ++runtimeBuildToken;
  const activeSubtitleDocument = loadedSubtitleDocument;
  const activeArticleSnapshot = articleSnapshot;
  runtimeBuildInFlight = true;
  runtimeBuildRequestedFingerprint = fingerprint;
  currentRuntimeBuild = null;
  setMatchingProgress("0% · 正在准备匹配...", 0);
  setSubtitleStatus("字幕已载入，正在执行运行时匹配...");

  void buildRuntimeManifestFromSubtitleAsync(activeSubtitleDocument, activeArticleSnapshot, (progress) => {
    if (activeBuildToken !== runtimeBuildToken) {
      return;
    }
    const progressText = describeBuildProgress(progress);
    setMatchingProgress(progressText, progress.percent);
    setSubtitleStatus(`字幕已载入，正在执行运行时匹配... ${progressText}`);
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
      installManifest(
        buildResult.manifest,
        `${activeSubtitleDocument.fileName} · 运行时匹配`,
        "runtime-subtitle"
      );
      applyRuntimeSubtitleStatus(buildResult);
      appendLog("已用字幕和全文文章快照生成运行时清单", {
        subtitleFile: activeSubtitleDocument.fileName,
        articleId: activeArticleSnapshot.articleId,
        coverageRatio: buildResult.stats.coverageRatio,
        matchedParagraphCount: buildResult.stats.matchedParagraphCount,
        smoothedParagraphCount: buildResult.stats.smoothedParagraphCount
      });
    })
    .catch((error) => {
      if (activeBuildToken !== runtimeBuildToken) {
        return;
      }
      resetRuntimeSubtitleBuild();
      runtimeBuildFailedFingerprint = fingerprint;
      const message = error instanceof Error ? error.message : String(error);
      setMatchingProgress(`失败 · ${message}`, 0);
      setSubtitleStatus(`字幕匹配失败：${message}`);
      setStatus(message);
      appendLog("字幕运行时匹配失败", { message, fileName: activeSubtitleDocument.fileName });
    });
}

async function loadSubtitleFile(file: File): Promise<void> {
  updateSubtitleFileSelectionStatus(`已载入：${file.name}（正在解析）`);
  const parsed = await parseSubtitleFile(file);
  loadedSubtitleDocument = parsed;
  subtitleAutoBuildEnabled = true;
  resetRuntimeSubtitleBuild();
  elements.subtitleName.textContent = `${parsed.fileName} (${parsed.metadata.segmentCount} 条字幕)`;
  updateSubtitleFileSelectionStatus(`已载入：${parsed.fileName}`);
  setStatus(`已加载字幕：${parsed.fileName}`);
  setSubtitleStatus("字幕已解析，正在请求全文文章并自动匹配...");
  appendLog("字幕文件已加载", {
    fileName: parsed.fileName,
    format: parsed.format,
    segmentCount: parsed.metadata.segmentCount,
    translationCount: parsed.metadata.translationCount
  });
  maybeRebuildRuntimeSubtitleManifest();
}

async function loadManifestFile(file: File): Promise<void> {
  subtitleAutoBuildEnabled = false;
  resetRuntimeSubtitleBuild();
  installManifest(parseManifest(await readJsonFile(file)), file.name, "file");
  applyRuntimeSubtitleStatus(currentRuntimeBuild);
}

async function processDroppedFiles(files: File[]): Promise<void> {
  const unsupportedFiles: string[] = [];
  const loadedKinds: string[] = [];

  for (const file of files) {
    const extension = fileExtension(file.name);
    if (file.type.startsWith("video/") || supportedVideoExtensions.has(extension)) {
      await loadVideoFile(file);
      loadedKinds.push(`视频 ${file.name}`);
      continue;
    }
    if (supportedSubtitleExtensions.has(extension)) {
      await loadSubtitleFile(file);
      loadedKinds.push(`字幕 ${file.name}`);
      continue;
    }
    if (supportedManifestExtensions.has(extension)) {
      await loadManifestFile(file);
      loadedKinds.push(`清单 ${file.name}`);
      continue;
    }
    unsupportedFiles.push(file.name);
  }

  if (unsupportedFiles.length > 0) {
    const message = `这些文件当前未识别：${unsupportedFiles.join(", ")}`;
    setStatus(message);
    appendLog("收到未识别的拖入文件", { files: unsupportedFiles });
    return;
  }

  if (loadedKinds.length > 0) {
    setStatus(`拖拽已载入：${loadedKinds.join("；")}`);
  }
}

function downloadJson(fileName: string, payload: unknown): void {
  if (manifestObjectUrl) {
    URL.revokeObjectURL(manifestObjectUrl);
  }
  manifestObjectUrl = URL.createObjectURL(
    new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
  );
  const link = document.createElement("a");
  link.href = manifestObjectUrl;
  link.download = fileName;
  link.click();
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function guessRemoteManifestUrls(baseUrl: string, slug: string): string[] {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  return [`${normalizedBaseUrl}${slug}.json`, `${normalizedBaseUrl}sync-data/${slug}.json`];
}

function guessRemoteIndexUrls(baseUrl: string): string[] {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  return [`${normalizedBaseUrl}index.json`, `${normalizedBaseUrl}sync-data/index.json`];
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function extractString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function extractNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function extractCollection(rawValue: unknown): unknown[] {
  return extractCollectionWithDepth(rawValue, 0);
}

function extractCollectionWithDepth(rawValue: unknown, depth: number): unknown[] {
  if (depth > 4) {
    return [];
  }
  if (Array.isArray(rawValue)) {
    return rawValue;
  }
  if (!isObject(rawValue)) {
    return [];
  }

  const collectionKeys = ["manifests", "items", "files", "entries", "results", "data", "episodes", "records", "list", "catalog", "catalogue", "index"];
  for (const key of collectionKeys) {
    const nestedCollection = extractCollectionWithDepth(rawValue[key], depth + 1);
    if (nestedCollection.length > 0) {
      return nestedCollection;
    }
  }

  const objectEntries = Object.entries(rawValue);
  const mappedObjectValues: Record<string, unknown>[] = objectEntries.flatMap(([key, value]) => {
    if (typeof value === "string") {
      return [{ key, path: value }];
    }
    if (isObject(value)) {
      return [{ key, ...value } satisfies Record<string, unknown>];
    }
    return [];
  });

  if (
    mappedObjectValues.some(
      (value) =>
        isObject(value) &&
        [
          value.slug,
          value.id,
          value.key,
          value.episodeSlug,
          value.url,
          value.manifestUrl,
          value.downloadUrl,
          value.path,
          value.fileName,
          value.file,
          value.filePath
        ].some((candidate) => typeof candidate === "string")
    )
  ) {
    return mappedObjectValues;
  }

  return objectEntries.flatMap(([, value]) => extractCollectionWithDepth(value, depth + 1));
}

function collectCandidateMetadataObjects(entry: Record<string, unknown>): Record<string, unknown>[] {
  const metadataKeys = ["source", "meta", "metadata", "manifest", "episode", "record", "item", "attributes", "context", "file"];
  const objects = [entry];
  for (const key of metadataKeys) {
    const candidate = entry[key];
    if (isObject(candidate)) {
      objects.push(candidate);
    }
  }
  return objects;
}

function extractStringFromObjects(
  objects: Record<string, unknown>[],
  extractor: (objectValue: Record<string, unknown>) => unknown
): string | null {
  for (const objectValue of objects) {
    const extracted = extractString(extractor(objectValue));
    if (extracted) {
      return extracted;
    }
  }
  return null;
}

function extractNumberFromObjects(
  objects: Record<string, unknown>[],
  extractor: (objectValue: Record<string, unknown>) => unknown
): number | null {
  for (const objectValue of objects) {
    const extracted = extractNumber(extractor(objectValue));
    if (extracted !== null) {
      return extracted;
    }
  }
  return null;
}

function extractStringArraysFromObjects(
  objects: Record<string, unknown>[],
  extractor: (objectValue: Record<string, unknown>) => unknown
): string[] {
  return dedupeStrings(objects.flatMap((objectValue) => asStringArray(extractor(objectValue))));
}

function resolveCandidateUrl(baseUrl: string, rawUrl: string): string {
  return new URL(rawUrl, normalizeBaseUrl(baseUrl)).toString();
}

function parseRemoteIndexCandidates(rawValue: unknown, baseUrl: string): RemoteManifestCandidate[] {
  const collection = extractCollection(rawValue);

  const candidates = collection.flatMap((entry): RemoteManifestCandidate[] => {
    if (typeof entry === "string") {
      const inferredSlug = normalizeEpisodeSlug(entry.split("/").pop() ?? entry);
      return [{
        slug: inferredSlug,
        title: inferredSlug,
        url: resolveCandidateUrl(baseUrl, entry),
        description: entry,
        articleId: null,
        categoryId: null,
        tags: []
      }];
    }

    if (!isObject(entry)) {
      return [];
    }

    const candidateObjects = collectCandidateMetadataObjects(entry);
    const slug =
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.slug) ??
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.id) ??
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.key) ??
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.episodeSlug) ??
      (extractString(entry.fileName) ? normalizeEpisodeSlug(extractString(entry.fileName) ?? "") : null) ??
      (extractString(entry.filePath) ? normalizeEpisodeSlug((extractString(entry.filePath) ?? "").split("/").pop() ?? extractString(entry.filePath) ?? "") : null) ??
      (extractString(entry.path) ? normalizeEpisodeSlug((extractString(entry.path) ?? "").split("/").pop() ?? extractString(entry.path) ?? "") : null) ??
      null;
    const rawUrl =
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.url) ??
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.manifestUrl) ??
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.downloadUrl) ??
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.path) ??
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.fileName) ??
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.file) ??
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.filePath) ??
      null;
    if (!slug || !rawUrl) {
      return [];
    }

    const title =
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.title) ??
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.name) ??
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.label) ??
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.displayName) ??
      slug;
    const articleId = extractNumberFromObjects(candidateObjects, (objectValue) => objectValue.articleId);
    const categoryId = extractNumberFromObjects(candidateObjects, (objectValue) => objectValue.categoryId);
    const tags = dedupeStrings([
      ...extractStringArraysFromObjects(candidateObjects, (objectValue) => objectValue.tags),
      ...extractStringArraysFromObjects(candidateObjects, (objectValue) => objectValue.keywords),
      ...extractStringArraysFromObjects(candidateObjects, (objectValue) => objectValue.aliases)
    ]);
    const parts = [
      articleId !== null ? `article#${articleId}` : null,
      categoryId !== null ? `category#${categoryId}` : null,
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.series),
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.seasonEpisode),
      extractStringFromObjects(candidateObjects, (objectValue) => objectValue.description),
      ...tags
    ].filter((value): value is string => Boolean(value));

    return [{
      slug,
      title,
      url: resolveCandidateUrl(baseUrl, rawUrl),
      description: parts.join(" · "),
      articleId,
      categoryId,
      tags
    }];
  });

  return Array.from(new Map(candidates.map((candidate) => [candidate.url, candidate])).values());
}

async function fetchManifestFromUrl(url: string): Promise<EpisodeSyncManifest> {
  const response = await fetch(url, { credentials: "omit" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return parseManifest(await response.json());
}

function rankRemoteCandidates(slug: string, candidates: RemoteManifestCandidate[]): RemoteManifestCandidate[] {
  const normalizedSlug = slug.trim().toLowerCase();
  const currentArticleId = pageContext?.articleId ?? manifest?.source.articleId ?? null;
  const currentCategoryId = pageContext?.categoryId ?? manifest?.source.categoryId ?? null;
  return [...candidates].sort((left, right) => {
    const score = (candidate: RemoteManifestCandidate): number => {
      let total = 0;
      const slugLower = candidate.slug.toLowerCase();
      const titleLower = candidate.title.toLowerCase();
      const descriptionLower = candidate.description.toLowerCase();
      if (slugLower === normalizedSlug) {
        total += 100;
      } else if (slugLower.startsWith(normalizedSlug)) {
        total += 70;
      } else if (slugLower.includes(normalizedSlug)) {
        total += 50;
      }
      if (titleLower.includes(normalizedSlug)) {
        total += 20;
      }
      if (descriptionLower.includes(normalizedSlug)) {
        total += 10;
      }
      if (candidate.tags.some((tag) => tag.toLowerCase().includes(normalizedSlug))) {
        total += 15;
      }
      if (currentArticleId !== null && candidate.articleId === currentArticleId) {
        total += 80;
      }
      if (currentCategoryId !== null && candidate.categoryId === currentCategoryId) {
        total += 30;
      }
      return total;
    };
    const leftScore = score(left);
    const rightScore = score(right);
    if (leftScore !== rightScore) {
      return rightScore - leftScore;
    }
    return left.slug.localeCompare(right.slug);
  });
}

async function fetchRemoteIndex(baseUrl: string): Promise<RemoteIndexResponse> {
  const indexUrls = guessRemoteIndexUrls(baseUrl);
  let lastError: Error | null = null;

  for (const indexUrl of indexUrls) {
    try {
      appendLog("尝试拉取远端索引", { url: indexUrl });
      const response = await fetch(indexUrl, { credentials: "omit" });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const candidates = parseRemoteIndexCandidates(await response.json(), baseUrl);
      if (candidates.length === 0) {
        throw new Error("远端索引中没有可用候选。");
      }
      return { candidates, sourceUrl: indexUrl };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("远端索引拉取失败。");
}

async function refreshRemoteIndexCandidates(preferredSlug?: string): Promise<RemoteManifestCandidate[]> {
  if (!elements.manifestBaseUrl || !elements.remoteSlug) {
    throw new Error("当前分支已关闭远端清单入口。");
  }
  const baseUrl = elements.manifestBaseUrl.value.trim();
  if (!baseUrl) {
    throw new Error("请先填写远端清单基地址。");
  }
  localStorage.setItem(storageKey, baseUrl);
  const indexResponse = await fetchRemoteIndex(baseUrl);
  remoteIndexSourceUrl = indexResponse.sourceUrl;
  const slug = (preferredSlug ?? elements.remoteSlug.value.trim()).trim();
  remoteManifestCandidates = slug ? rankRemoteCandidates(slug, indexResponse.candidates) : indexResponse.candidates;
  renderRemoteManifestCandidates(remoteManifestCandidates[0]?.url ?? null);
  appendLog("远端索引已载入", {
    sourceUrl: indexResponse.sourceUrl,
    candidateCount: remoteManifestCandidates.length,
    preferredSlug: slug
  });
  return remoteManifestCandidates;
}

async function loadRemoteManifestCandidate(candidateUrl: string): Promise<void> {
  const selectedCandidate = remoteManifestCandidates.find((candidate) => candidate.url === candidateUrl) ?? null;
  appendLog("尝试加载远端候选清单", { url: candidateUrl });
  const manifestValue = await fetchManifestFromUrl(candidateUrl);
  subtitleAutoBuildEnabled = false;
  resetRuntimeSubtitleBuild();
  installManifest(manifestValue, candidateUrl, "remote");
  applyRuntimeSubtitleStatus(currentRuntimeBuild);
  if (selectedCandidate) {
    setRemoteIndexStatus(`已从候选列表加载：${formatRemoteCandidateSummary(selectedCandidate)}`);
  }
}

async function fetchRemoteManifest(): Promise<void> {
  const explicitManifestUrl = searchParameters.get("manifestUrl")?.trim();
  if (explicitManifestUrl) {
    appendLog("尝试拉取显式清单 URL", { url: explicitManifestUrl });
    subtitleAutoBuildEnabled = false;
    resetRuntimeSubtitleBuild();
    installManifest(await fetchManifestFromUrl(explicitManifestUrl), explicitManifestUrl, "remote");
    applyRuntimeSubtitleStatus(currentRuntimeBuild);
    return;
  }

  if (!elements.manifestBaseUrl || !elements.remoteSlug) {
    throw new Error("当前分支已关闭远端清单入口。");
  }

  const baseUrl = elements.manifestBaseUrl.value.trim();
  if (!baseUrl) {
    throw new Error("请先填写远端清单基地址。");
  }
  const slug = elements.remoteSlug.value.trim();
  if (!slug) {
    throw new Error("请先填写剧集 slug。");
  }

  localStorage.setItem(storageKey, baseUrl);
  const candidates = guessRemoteManifestUrls(baseUrl, slug);
  let lastError: Error | null = null;

  for (const candidateUrl of candidates) {
    try {
      appendLog("尝试拉取远端清单", { url: candidateUrl });
      subtitleAutoBuildEnabled = false;
      resetRuntimeSubtitleBuild();
      installManifest(await fetchManifestFromUrl(candidateUrl), candidateUrl, "remote");
      applyRuntimeSubtitleStatus(currentRuntimeBuild);
      setRemoteIndexStatus("已通过 slug 直连找到远端清单。");
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  appendLog("slug 直连失败，转入远端索引兜底", { slug, message: lastError?.message ?? null });
  const fallbackCandidates = await refreshRemoteIndexCandidates(slug);
  const bestCandidate = fallbackCandidates.find((candidate) => candidate.slug.toLowerCase() === slug.toLowerCase()) ?? fallbackCandidates[0] ?? null;
  if (!bestCandidate) {
    throw lastError ?? new Error("远端清单拉取失败。");
  }
  await loadRemoteManifestCandidate(bestCandidate.url);
}

function seekToMilliseconds(milliseconds: number): void {
  if (!Number.isFinite(milliseconds)) {
    return;
  }
  elements.video.currentTime = Math.max(milliseconds, 0) / 1000;
  updateTransportTime();
  broadcastPlayerState(true);
}

function handleParagraphSeek(paragraphIndex: number): void {
  if (!manifest) {
    appendLog("收到页面段落点击，但当前没有同步清单。");
    return;
  }
  const entry = manifest.sync.find((item) => item.paragraphIndex === paragraphIndex);
  if (!entry) {
    appendLog("当前同步清单没有这个段落的映射", { paragraphIndex });
    return;
  }
  seekToMilliseconds(entry.startMs);
  appendLog("根据页面段落点击回跳视频", { paragraphIndex, seekMs: entry.startMs });
}

async function togglePlayback(): Promise<void> {
  if (elements.video.paused) {
    await elements.video.play();
  } else {
    elements.video.pause();
  }
  updatePlayToggle();
  broadcastPlayerState(true);
}

function adjustPlaybackBy(deltaMs: number): void {
  seekToMilliseconds(currentPlaybackTimeMs() + deltaMs);
  appendLog("快捷键跳转", { deltaMs, currentTimeMs: currentPlaybackTimeMs() });
}

async function executePlayerControlCommand(payload: {
  command: "toggle_playback" | "seek_by" | "step_playback_rate";
  deltaMs?: number;
  step?: number;
  source: "player" | "reader-page";
}): Promise<void> {
  switch (payload.command) {
    case "toggle_playback":
      await togglePlayback();
      return;
    case "seek_by":
      adjustPlaybackBy(payload.deltaMs ?? 0);
      return;
    case "step_playback_rate":
      stepPlaybackRate(payload.step ?? 0, payload.source);
      return;
    default:
      return;
  }
}

async function togglePictureInPicture(): Promise<void> {
  if (!document.pictureInPictureEnabled) {
    setStatus("当前浏览器环境不支持画中画。");
    return;
  }
  if (!elements.video.src) {
    setStatus("请先加载本地视频后再进入画中画。");
    return;
  }

  if (document.pictureInPictureElement === elements.video) {
    await document.exitPictureInPicture();
    appendLog("已退出画中画");
  } else {
    await elements.video.requestPictureInPicture();
    appendLog("已进入画中画");
  }
  updatePictureInPictureButton();
}

function requestConnectedTabs(): void {
  postRuntimeMessage({ type: "REQUEST_CONNECTED_TABS" } satisfies RuntimeMessage);
}

function refreshReaderTabs(): void {
  setConnectedTabsStatus("正在扫描所有 aim-read 页面，必要时会刷新文章页…");
  postRuntimeMessage({ type: "REFRESH_READER_TABS" } satisfies RuntimeMessage);
}

function bindSelectedPage(): void {
  const tabId = Number.parseInt(elements.pageTabSelect.value, 10);
  if (!Number.isFinite(tabId)) {
    return;
  }
  boundPageTabId = tabId;
  renderConnectedTabs();
  postRuntimeMessage({
    type: "SET_PREFERRED_TAB",
    payload: { tabId }
  } satisfies RuntimeMessage);
  setConnectedTabsStatus(`正在绑定 tab#${tabId}...`);
  if (subtitleAutoBuildEnabled) {
    requestArticleSnapshot();
  }
}

elements.videoFile.addEventListener("change", async () => {
  const file = elements.videoFile.files?.[0];
  if (!file) {
    return;
  }
  try {
    await loadVideoFile(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    appendLog("视频文件加载失败", { message, fileName: file.name });
  }
});

elements.subtitleFile.addEventListener("change", async () => {
  const file = elements.subtitleFile.files?.[0];
  if (!file) {
    return;
  }
  try {
    await loadSubtitleFile(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    updateSubtitleFileSelectionStatus(`已载入：${file.name}（加载失败）`);
    setSubtitleStatus(`字幕加载失败：${message}`);
    setStatus(message);
    appendLog("字幕文件加载失败", { message, fileName: file.name });
  }
});

elements.playOriginalVideo.addEventListener("click", () => {
  void playOriginalVideoFile().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    appendLog("直接播放原文件失败", { message, fileName: sourceVideoFile?.name ?? null });
  });
});

elements.preprocessVideo.addEventListener("click", () => {
  void preprocessVideoFile().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    appendLog("点击预处理失败", { message, fileName: sourceVideoFile?.name ?? null });
  });
});

elements.playProcessedVideo.addEventListener("click", () => {
  void playProcessedVideoFile().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    appendLog("播放转码结果失败", { message, fileName: processedVideoFile?.name ?? null });
  });
});

elements.downloadProcessedVideo.addEventListener("click", () => {
  try {
    downloadProcessedVideo();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    appendLog("下载转码结果失败", { message, fileName: processedVideoFile?.name ?? null });
  }
});

elements.manifestFile?.addEventListener("change", async () => {
  const file = elements.manifestFile?.files?.[0];
  if (!file) {
    return;
  }
  try {
    await loadManifestFile(file);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    appendLog("本地清单加载失败", { message, fileName: file.name });
  }
});

elements.fetchRemoteManifestButton?.addEventListener("click", async () => {
  try {
    setStatus("正在拉取远端清单...");
    await fetchRemoteManifest();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    appendLog("远端清单拉取失败", { message });
  }
});

elements.refreshRemoteIndexButton?.addEventListener("click", async () => {
  try {
    setStatus("正在刷新远端候选...");
    await refreshRemoteIndexCandidates();
    setStatus("远端候选已刷新。");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    appendLog("远端索引拉取失败", { message });
  }
});

elements.remoteManifestCandidate?.addEventListener("change", () => {
  updateRemoteCandidateControlState();
  syncRemoteCandidateStatus(elements.remoteManifestCandidate?.value);
});

elements.loadRemoteCandidateButton?.addEventListener("click", async () => {
  try {
    const candidateUrl = elements.remoteManifestCandidate?.value.trim() ?? "";
    if (!candidateUrl) {
      throw new Error("请先选择一个远端候选。");
    }
    setStatus("正在加载所选远端候选...");
    await loadRemoteManifestCandidate(candidateUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    appendLog("远端候选加载失败", { message });
  }
});

elements.requestPageContextButton.addEventListener("click", () => {
  postRuntimeMessage({ type: "REQUEST_ACTIVE_PAGE_CONTEXT" } satisfies RuntimeMessage);
  if (subtitleAutoBuildEnabled) {
    requestArticleSnapshot();
  }
});

elements.refreshConnectedTabsButton.addEventListener("click", () => {
  refreshReaderTabs();
});

elements.pageTabSelect.addEventListener("change", () => {
  updateConnectedTabsControlState();
});

elements.bindSelectedPageButton.addEventListener("click", () => {
  bindSelectedPage();
});

elements.saveShortcuts.addEventListener("click", () => {
  const settings = readShortcutSettingsFromInputs();
  void persistShortcutSettings(settings)
    .then(() => {
      setStatus("快捷键设置已保存。");
      appendLog("快捷键设置已保存", settings);
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      appendLog("保存快捷键设置失败", { message });
    });
});

elements.themeToggleButton.addEventListener("click", () => {
  const nextPreference = cycleThemePreference();
  void persistThemePreference(nextPreference)
    .then(() => {
      setStatus(`主题模式已切换为${describeThemePreference(nextPreference)}。`);
      appendLog("主题模式已更新", {
        preference: nextPreference,
        appliedTheme: resolveAppliedTheme(nextPreference)
      });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      appendLog("保存主题模式失败", { message });
    });
});

elements.exportPageContextButton.addEventListener("click", () => {
  if (!pageContext) {
    return;
  }
  const fileName = `aim-read-page-context-${pageContext.articleId ?? "unknown"}-${Date.now()}.json`;
  downloadJson(fileName, pageContext);
});

elements.pipToggle.addEventListener("click", async () => {
  try {
    await togglePictureInPicture();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    appendLog("画中画切换失败", { message });
  }
});

elements.pipTogglePlayer.addEventListener("click", async () => {
  try {
    await togglePictureInPicture();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    appendLog("播放器区画中画切换失败", { message });
  }
});

elements.maximizePlayerToggle.addEventListener("click", () => {
  togglePlayerExpanded();
});

elements.openTutorialButton.addEventListener("click", () => {
  openTutorial({ scroll: true });
});

elements.tutorialClose.addEventListener("click", () => {
  void dismissTutorial();
});

elements.tutorialNext.addEventListener("click", () => {
  advanceTutorial();
});

elements.playToggle.addEventListener("click", async () => {
  try {
    await togglePlayback();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    appendLog("播放器切换失败", { message });
  }
});

elements.seekRange.addEventListener("input", () => {
  const durationMs = Number.isFinite(elements.video.duration) ? elements.video.duration * 1000 : 0;
  const ratio = Number.parseInt(elements.seekRange.value, 10) / 1000;
  elements.video.currentTime = (durationMs * ratio) / 1000;
  updateTransportTime();
  broadcastPlayerState(true);
});

elements.playbackRate.addEventListener("change", () => {
  setPlaybackRate(Number.parseFloat(elements.playbackRate.value), "player");
});

elements.syncNearbyList.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  const trigger = target.closest<HTMLElement>("[data-start-ms]");
  if (!trigger) {
    return;
  }
  const startMs = Number.parseInt(trigger.dataset.startMs ?? "", 10);
  const paragraphIndex = Number.parseInt(trigger.dataset.paragraphIndex ?? "", 10);
  seekToMilliseconds(startMs);
  appendLog("从播放器附近段落列表回跳", { paragraphIndex, startMs });
});

for (const eventName of ["dragenter", "dragover"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("is-drag-over");
  });
}

for (const eventName of ["dragleave", "dragend"]) {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    const relatedTarget = "relatedTarget" in event ? event.relatedTarget : null;
    if (!(relatedTarget instanceof Node) || !elements.dropZone.contains(relatedTarget)) {
      elements.dropZone.classList.remove("is-drag-over");
    }
  });
}

elements.dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  elements.dropZone.classList.remove("is-drag-over");
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length === 0) {
    return;
  }
  void processDroppedFiles(files).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    appendLog("拖拽文件处理失败", { message });
  });
});

window.addEventListener("keydown", async (event) => {
  if (tutorialActive) {
    if (event.key === "Escape") {
      event.preventDefault();
      void dismissTutorial();
    }
    return;
  }

  if (event.key === "Escape" && playerExpanded) {
    event.preventDefault();
    setPlayerExpanded(false);
    return;
  }

  if (isEditableTarget(event.target) || event.isComposing) {
    return;
  }

  if (matchesConfiguredShortcut(event, shortcutSettings.togglePlayback)) {
    if (isEventFromVideoElement(event)) {
      return;
    }
    event.preventDefault();
    await togglePlayback().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      appendLog("快捷键播放切换失败", { message });
    });
    return;
  }

  if (matchesConfiguredShortcut(event, shortcutSettings.seekBackward)) {
    event.preventDefault();
    adjustPlaybackBy(-shortcutSettings.seekSeconds * 1000);
    return;
  }

  if (matchesConfiguredShortcut(event, shortcutSettings.seekForward)) {
    event.preventDefault();
    adjustPlaybackBy(shortcutSettings.seekSeconds * 1000);
    return;
  }

  if (matchesConfiguredShortcut(event, shortcutSettings.rateDown)) {
    event.preventDefault();
    stepPlaybackRate(-1, "player");
    return;
  }

  if (matchesConfiguredShortcut(event, shortcutSettings.rateUp)) {
    event.preventDefault();
    stepPlaybackRate(1, "player");
    return;
  }

  if (matchesKeyboardShortcut(event, "KeyJ", ["j"])) {
    adjustPlaybackBy(-10000);
    return;
  }

  if (matchesKeyboardShortcut(event, "KeyL", ["l"])) {
    adjustPlaybackBy(10000);
    return;
  }

  if (matchesKeyboardShortcut(event, "KeyP", ["p"])) {
    event.preventDefault();
    await togglePictureInPicture().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message);
      appendLog("快捷键画中画切换失败", { message });
    });
  }
});

for (const eventName of [
  "play",
  "pause",
  "canplay",
  "seeking",
  "seeked",
  "timeupdate",
  "ended",
  "error",
  "loadedmetadata",
  "enterpictureinpicture",
  "leavepictureinpicture"
]) {
  elements.video.addEventListener(eventName, () => {
    updateTransportTime();
    updatePlayToggle();
    updatePictureInPictureButton();
    broadcastPlayerState(eventName !== "timeupdate");
  });
}

elements.video.addEventListener("error", () => {
  const mediaError = elements.video.error;
  const message =
    mediaError?.message ||
    (typeof mediaError?.code === "number" ? `HTMLMediaElement error code ${mediaError.code}` : "浏览器无法播放当前视频文件。");
  setStatus(message);
  appendLog("视频加载或播放失败", {
    message,
    code: mediaError?.code ?? null,
    currentSrc: elements.video.currentSrc || null
  });
});

function handleRuntimeMessage(message: RuntimeMessage): void {
  switch (message.type) {
    case "ACTIVE_ARTICLE_SNAPSHOT_RESPONSE":
      updateArticleSnapshot(message.payload.articleSnapshot, message.payload.error, message.payload.tabId);
      return;
    case "ACTIVE_PAGE_CONTEXT_RESPONSE":
      updatePageContext(message.payload.pageContext, message.payload.tabId);
      return;
    case "CONNECTED_TABS_RESPONSE":
      updateConnectedTabs(message.payload);
      return;
    case "PLAYER_CONTROL_COMMAND":
      void executePlayerControlCommand(message.payload).catch((error: unknown) => {
        const messageText = error instanceof Error ? error.message : String(error);
        setStatus(messageText);
        appendLog("远端控制执行失败", { message: messageText, source: message.payload.source });
      });
      return;
    case "PLAYER_SEEK_COMMAND":
      handleParagraphSeek(message.payload.paragraphIndex);
      return;
    default:
      return;
  }
}

if (elements.manifestBaseUrl) {
  elements.manifestBaseUrl.value = localStorage.getItem(storageKey) ?? "";
  if (searchParameters.has("manifestBaseUrl")) {
    elements.manifestBaseUrl.value = searchParameters.get("manifestBaseUrl") ?? "";
  }
}
if (elements.remoteSlug && searchParameters.has("slug")) {
  elements.remoteSlug.value = searchParameters.get("slug") ?? "";
}
elements.playbackRate.value = "1";
elements.video.playbackRate = 1;
updateVideoFileSelectionStatus();
updateSubtitleFileSelectionStatus();
elements.subtitleName.textContent = "未加载";
resetVideoDecisionState();
setSubtitleStatus("未加载字幕。");
setRemoteIndexStatus("还没有拉取远端索引。");
setMatchingProgress("待命");
setConnectedTabsStatus("当前还没有可绑定的页面。");
updateRemoteCandidateControlState();
updateConnectedTabsControlState();
updateTransportTime();
updatePlayToggle();
updatePictureInPictureButton();
renderRemoteManifestCandidates();
renderConnectedTabs();
renderCurrentSyncDetails(currentPlaybackTimeMs());
setStatus("等待输入。");
applyPlayerExpandedState();
connectPlayerPort();
requestConnectedTabs();
postRuntimeMessage({ type: "REQUEST_ACTIVE_PAGE_CONTEXT" } satisfies RuntimeMessage);
window.addEventListener("resize", () => {
  if (tutorialActive) {
    queueTutorialPositionUpdate();
  }
});
window.addEventListener("scroll", () => {
  if (tutorialActive) {
    queueTutorialPositionUpdate();
  }
}, { passive: true });
window.addEventListener("beforeunload", () => {
  playerPageUnloading = true;
  clearTutorialPositionTimer();
  if (videoObjectUrl) {
    URL.revokeObjectURL(videoObjectUrl);
  }
  if (processedVideoObjectUrl) {
    URL.revokeObjectURL(processedVideoObjectUrl);
  }
  clearPlayerPortReconnectTimer();
  playerPort?.disconnect();
  browserFfmpegService.terminate();
});
void loadShortcutSettings().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  appendLog("读取快捷键设置失败", { message });
});
void loadThemePreference().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  appendLog("读取主题模式失败", { message });
  applyThemePreference();
});
void loadTutorialState().then(() => {
  if (shouldAutoOpenTutorial()) {
    window.setTimeout(() => {
      openTutorial({ scroll: true });
    }, 420);
  }
}).catch((error: unknown) => {
  appendLog("读取新手引导状态失败", {
    message: error instanceof Error ? error.message : String(error)
  });
});

systemDarkModeMediaQuery.addEventListener("change", () => {
  if (themePreference === "system") {
    applyThemePreference();
  }
});

if (searchParameters.get("autofetch") === "1") {
  void fetchRemoteManifest().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message);
    appendLog("自动拉取同步清单失败", { message });
  });
}
