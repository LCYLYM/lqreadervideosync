export const PLAYER_PORT_NAME = "reader-sync-player";
export const CONTENT_PORT_NAME = "reader-sync-content";

export type PlaybackState = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export interface TranscriptSegment {
  index: number;
  startMs: number;
  endMs: number;
  text: string;
}

export interface ArticleParagraph {
  paragraphIndex: number;
  text: string;
  translation?: string;
  domPath?: string;
  contentPage?: number;
  top?: number;
}

export interface AimReadPageContext {
  articleUrl: string;
  articleId: number | null;
  categoryId: number | null;
  title: string;
  capturedAt: string;
  paragraphs: ArticleParagraph[];
}

export interface AimReadArticleSnapshot {
  articleUrl: string;
  articleId: number | null;
  categoryId: number | null;
  title: string;
  capturedAt: string;
  paragraphCount: number;
  paragraphs: ArticleParagraph[];
  pageInfo?: {
    totalPages: number | null;
    pageSize: number | null;
    totalElements: number | null;
  };
}

export interface ConnectedAimReadTab {
  tabId: number;
  windowId: number;
  active: boolean;
  title: string;
  url: string;
  articleId: number | null;
  categoryId: number | null;
  paragraphCount: number;
  preferred: boolean;
  capturedAt: string | null;
}

export interface SyncEntry {
  paragraphIndex: number;
  startMs: number;
  endMs: number;
  transcriptSegmentIndexes: number[];
  alignmentScore: number;
}

export interface EpisodeSyncManifest {
  version: "1.0.0";
  source: {
    slug: string;
    title?: string;
    createdAt: string;
    generator: string;
    mediaPath?: string;
    mediaFileName?: string;
    articleUrl?: string;
    articleId?: number;
    categoryId?: number;
  };
  transcript: {
    mode: string;
    text: string;
    language?: string;
    modelName?: string;
    segments: TranscriptSegment[];
  };
  article?: {
    capturedAt: string;
    title?: string;
    articleUrl?: string;
    paragraphs: ArticleParagraph[];
  };
  sync: SyncEntry[];
}

export interface PlayerStateUpdateMessage {
  type: "PLAYER_STATE_UPDATE";
  payload: {
    currentTimeMs: number;
    state: PlaybackState;
    activeParagraphIndex: number | null;
    manifestSlug: string | null;
    playbackRate: number;
  };
}

export interface PlayerControlCommandMessage {
  type: "PLAYER_CONTROL_COMMAND";
  payload: {
    command: "toggle_playback" | "seek_by" | "step_playback_rate";
    deltaMs?: number;
    step?: number;
    source: "player" | "reader-page";
  };
}

export interface PlayerSeekCommandMessage {
  type: "PLAYER_SEEK_COMMAND";
  payload: {
    seekMs: number;
    paragraphIndex: number;
  };
}

export interface CollectPageContextMessage {
  type: "COLLECT_PAGE_CONTEXT";
}

export interface CollectArticleSnapshotMessage {
  type: "COLLECT_ARTICLE_SNAPSHOT";
}

export interface PageContextUpdateMessage {
  type: "PAGE_CONTEXT_UPDATE";
  payload: AimReadPageContext;
}

export interface ArticleSnapshotUpdateMessage {
  type: "ARTICLE_SNAPSHOT_UPDATE";
  payload: AimReadArticleSnapshot;
}

export interface ArticleSnapshotErrorMessage {
  type: "ARTICLE_SNAPSHOT_ERROR";
  payload: {
    message: string;
  };
}

export interface PageParagraphClickedMessage {
  type: "PAGE_PARAGRAPH_CLICKED";
  payload: {
    paragraphIndex: number;
  };
}

export interface RequestActivePageContextMessage {
  type: "REQUEST_ACTIVE_PAGE_CONTEXT";
}

export interface RequestActiveArticleSnapshotMessage {
  type: "REQUEST_ACTIVE_ARTICLE_SNAPSHOT";
}

export interface ActivePageContextResponseMessage {
  type: "ACTIVE_PAGE_CONTEXT_RESPONSE";
  payload: {
    tabId: number | null;
    pageContext: AimReadPageContext | null;
  };
}

export interface ActiveArticleSnapshotResponseMessage {
  type: "ACTIVE_ARTICLE_SNAPSHOT_RESPONSE";
  payload: {
    tabId: number | null;
    articleSnapshot: AimReadArticleSnapshot | null;
    error: string | null;
  };
}

export interface RequestConnectedTabsMessage {
  type: "REQUEST_CONNECTED_TABS";
}

export interface RefreshReaderTabsMessage {
  type: "REFRESH_READER_TABS";
}

export interface ConnectedTabsResponseMessage {
  type: "CONNECTED_TABS_RESPONSE";
  payload: {
    preferredTabId: number | null;
    tabs: ConnectedAimReadTab[];
  };
}

export interface SetPreferredTabMessage {
  type: "SET_PREFERRED_TAB";
  payload: {
    tabId: number;
  };
}

export interface LogEntryMessage {
  type: "LOG_ENTRY";
  payload: import("./logger").ReaderSyncLogEntry;
}

export interface ExportFeedbackBundleMessage {
  type: "EXPORT_FEEDBACK_BUNDLE";
  payload: {
    description: string;
    includeScreenshot: boolean;
  };
}

export interface ExportFeedbackBundleResultMessage {
  type: "EXPORT_FEEDBACK_BUNDLE_RESULT";
  payload: {
    ok: boolean;
    fileName?: string;
    logCount?: number;
    screenshotIncluded?: boolean;
    error?: string;
  };
}

export type RuntimeMessage =
  | ActiveArticleSnapshotResponseMessage
  | ActivePageContextResponseMessage
  | ArticleSnapshotErrorMessage
  | ArticleSnapshotUpdateMessage
  | CollectArticleSnapshotMessage
  | CollectPageContextMessage
  | ConnectedTabsResponseMessage
  | ExportFeedbackBundleMessage
  | ExportFeedbackBundleResultMessage
  | LogEntryMessage
  | PageContextUpdateMessage
  | PageParagraphClickedMessage
  | PlayerControlCommandMessage
  | PlayerSeekCommandMessage
  | PlayerStateUpdateMessage
  | RefreshReaderTabsMessage
  | RequestActiveArticleSnapshotMessage
  | RequestConnectedTabsMessage
  | RequestActivePageContextMessage
  | SetPreferredTabMessage;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isRuntimeMessage(value: unknown): value is RuntimeMessage {
  return isObject(value) && typeof value.type === "string";
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function normalizeEpisodeSlug(fileName: string): string {
  const sanitized = fileName
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const seasonEpisodeMatch = sanitized.match(/^(.*?)(s\d{1,2}e\d{1,2})\b/);
  if (seasonEpisodeMatch) {
    const seriesName = seasonEpisodeMatch[1]
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "");
    const episodeToken = seasonEpisodeMatch[2];
    return `${seriesName}_${episodeToken}`;
  }
  return sanitized
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function resolveActiveSyncEntry(
  manifest: Pick<EpisodeSyncManifest, "sync"> | null,
  currentTimeMs: number
): SyncEntry | null {
  if (!manifest || manifest.sync.length === 0) {
    return null;
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
    if (currentTimeMs > entry.endMs) {
      low = middle + 1;
      continue;
    }
    return entry;
  }

  let nearestEntry: SyncEntry | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const entry of manifest.sync) {
    if (currentTimeMs >= entry.startMs && currentTimeMs <= entry.endMs) {
      return entry;
    }
    const distance =
      currentTimeMs < entry.startMs
        ? entry.startMs - currentTimeMs
        : currentTimeMs - entry.endMs;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestEntry = entry;
    }
  }

  return nearestDistance <= 1500 ? nearestEntry : null;
}
