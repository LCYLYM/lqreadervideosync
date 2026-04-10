import {
  type AimReadArticleSnapshot,
  type ArticleParagraph,
  type EpisodeSyncManifest,
  normalizeEpisodeSlug,
  type SyncEntry,
  type TranscriptSegment
} from "./protocol";
import type { ParsedSubtitleDocument } from "./subtitle-parser";

const SPEAKER_PREFIX_PATTERN = /^[A-Za-z][A-Za-z' .-]{0,40}:\s*/;
const NON_ALPHANUMERIC_PATTERN = /[^a-z0-9\s]/g;
const MULTISPACE_PATTERN = /\s+/g;

interface CandidateMatch {
  transcriptStart: number;
  transcriptEnd: number;
  paragraphStart: number;
  paragraphEnd: number;
  similarity: number;
  score: number;
}

interface AlignmentResult {
  syncEntries: SyncEntry[];
  matchedParagraphCount: number;
  unmatchedParagraphCount: number;
  consumedSegmentCount: number;
}

export interface RuntimeManifestBuildResult {
  manifest: EpisodeSyncManifest;
  stats: {
    subtitleSegmentCount: number;
    articleParagraphCount: number;
    matchedParagraphCount: number;
    unmatchedParagraphCount: number;
    smoothedParagraphCount: number;
    consumedSegmentCount: number;
    coverageRatio: number;
  };
}

export interface RuntimeManifestBuildProgress {
  phase: "preparing" | "matching" | "smoothing" | "finalizing";
  processedParagraphCount: number;
  articleParagraphCount: number;
  processedSegmentCount: number;
  subtitleSegmentCount: number;
  percent: number;
  message: string;
}

function normalizeAlignmentText(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(SPEAKER_PREFIX_PATTERN, "")
    .replace(NON_ALPHANUMERIC_PATTERN, " ")
    .replace(MULTISPACE_PATTERN, " ")
    .trim();
}

function tokenizeAlignmentText(value: string): string[] {
  return normalizeAlignmentText(value)
    .split(" ")
    .filter((token) => token.length >= 2);
}

function lcsLength(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const row = new Array<number>(right.length + 1).fill(0);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = 0;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previous = row[rightIndex];
      if (left[leftIndex - 1] === right[rightIndex - 1]) {
        row[rightIndex] = diagonal + 1;
      } else {
        row[rightIndex] = Math.max(row[rightIndex], row[rightIndex - 1]);
      }
      diagonal = previous;
    }
  }
  return row[right.length] ?? 0;
}

function calculateSimilarity(left: string, right: string): number {
  if (!left || !right) {
    return 0;
  }

  const leftTokens = tokenizeAlignmentText(left);
  const rightTokens = tokenizeAlignmentText(right);
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const leftSet = new Set(leftTokens);
  const rightSet = new Set(rightTokens);
  const overlapCount = Array.from(leftSet).filter((token) => rightSet.has(token)).length;
  const tokenOverlap = overlapCount / Math.max(leftSet.size, rightSet.size);
  const lcsRatio = lcsLength(leftTokens, rightTokens) / Math.max(leftTokens.length, rightTokens.length);
  let score = Math.max(lcsRatio, (lcsRatio * 0.75) + (tokenOverlap * 0.25));

  const normalizedLeft = normalizeAlignmentText(left);
  const normalizedRight = normalizeAlignmentText(right);
  if (
    Math.min(normalizedLeft.length, normalizedRight.length) >= 15 &&
    tokenOverlap >= 0.45 &&
    (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))
  ) {
    score = Math.max(score, 0.9);
  }

  return score;
}

function joinTranscriptText(segments: TranscriptSegment[]): string {
  return segments.map((segment) => normalizeAlignmentText(segment.text)).filter(Boolean).join(" ").trim();
}

function joinArticleText(paragraphs: ArticleParagraph[]): string {
  return paragraphs.map((paragraph) => normalizeAlignmentText(paragraph.text)).filter(Boolean).join(" ").trim();
}

function splitTimeRange(startMs: number, endMs: number, weights: number[]): Array<[number, number]> {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0 || endMs <= startMs) {
    return weights.map(() => [startMs, endMs]);
  }

  const result: Array<[number, number]> = [];
  let cursor = startMs;
  for (let index = 0; index < weights.length; index += 1) {
    if (index === weights.length - 1) {
      result.push([cursor, endMs]);
      break;
    }
    const sliceDuration = Math.max(1, Math.round((endMs - startMs) * (weights[index] / totalWeight)));
    const nextCursor = Math.min(endMs, cursor + sliceDuration);
    result.push([cursor, nextCursor]);
    cursor = nextCursor;
  }
  return result;
}

function isLowSignalText(value: string): boolean {
  if (value.includes("🎼")) {
    return true;
  }
  const normalized = normalizeAlignmentText(value);
  if (!normalized) {
    return true;
  }
  const tokens = tokenizeAlignmentText(normalized);
  return tokens.length <= 2 && normalized.length <= 12;
}

function trimLowSignalSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  let startIndex = 0;
  let endIndex = segments.length;
  while (startIndex < endIndex && isLowSignalText(segments[startIndex]?.text ?? "")) {
    startIndex += 1;
  }
  while (endIndex > startIndex && isLowSignalText(segments[endIndex - 1]?.text ?? "")) {
    endIndex -= 1;
  }
  return startIndex < endIndex ? segments.slice(startIndex, endIndex) : segments;
}

function buildCandidate(
  transcriptSegments: TranscriptSegment[],
  articleParagraphs: ArticleParagraph[],
  transcriptStart: number,
  transcriptWindow: number,
  paragraphStart: number,
  paragraphWindow: number,
  baseTranscriptIndex: number,
  baseParagraphIndex: number
): CandidateMatch | null {
  const transcriptSlice = transcriptSegments.slice(transcriptStart, transcriptStart + transcriptWindow);
  const articleSlice = articleParagraphs.slice(paragraphStart, paragraphStart + paragraphWindow);
  if (transcriptSlice.length === 0 || articleSlice.length === 0) {
    return null;
  }

  const trimmedTranscriptSlice = trimLowSignalSegments(transcriptSlice);
  const transcriptText = joinTranscriptText(trimmedTranscriptSlice);
  const articleText = joinArticleText(articleSlice);
  if (!transcriptText || !articleText) {
    return null;
  }

  const similarity = calculateSimilarity(articleText, transcriptText);
  const lengthBalance = Math.min(articleText.length, transcriptText.length) / Math.max(articleText.length, transcriptText.length);
  const continuityPenalty = ((transcriptStart - baseTranscriptIndex) * 0.09) + ((paragraphStart - baseParagraphIndex) * 0.06);
  const windowPenalty = ((transcriptWindow - 1) * 0.02) + ((paragraphWindow - 1) * 0.015);
  const score = (similarity * (0.85 + (0.15 * lengthBalance))) - continuityPenalty - windowPenalty;

  return {
    transcriptStart,
    transcriptEnd: transcriptStart + transcriptWindow,
    paragraphStart,
    paragraphEnd: paragraphStart + paragraphWindow,
    similarity,
    score
  };
}

function findBestCandidate(
  transcriptSegments: TranscriptSegment[],
  articleParagraphs: ArticleParagraph[],
  transcriptIndex: number,
  paragraphIndex: number,
  options: {
    maxSegmentWindow: number;
    maxParagraphWindow: number;
    maxTranscriptLookahead: number;
    maxParagraphLookahead: number;
  }
): CandidateMatch | null {
  let bestCandidate: CandidateMatch | null = null;

  for (let transcriptOffset = 0; transcriptOffset <= options.maxTranscriptLookahead; transcriptOffset += 1) {
    const candidateTranscriptStart = transcriptIndex + transcriptOffset;
    if (candidateTranscriptStart >= transcriptSegments.length) {
      break;
    }

    for (let paragraphOffset = 0; paragraphOffset <= options.maxParagraphLookahead; paragraphOffset += 1) {
      const candidateParagraphStart = paragraphIndex + paragraphOffset;
      if (candidateParagraphStart >= articleParagraphs.length) {
        break;
      }

      for (let transcriptWindow = 1; transcriptWindow <= options.maxSegmentWindow; transcriptWindow += 1) {
        if (candidateTranscriptStart + transcriptWindow > transcriptSegments.length) {
          break;
        }

        for (let paragraphWindow = 1; paragraphWindow <= options.maxParagraphWindow; paragraphWindow += 1) {
          if (candidateParagraphStart + paragraphWindow > articleParagraphs.length) {
            break;
          }

          const candidate = buildCandidate(
            transcriptSegments,
            articleParagraphs,
            candidateTranscriptStart,
            transcriptWindow,
            candidateParagraphStart,
            paragraphWindow,
            transcriptIndex,
            paragraphIndex
          );
          if (!candidate) {
            continue;
          }
          if (!bestCandidate || candidate.score > bestCandidate.score) {
            bestCandidate = candidate;
          }
        }
      }
    }
  }

  return bestCandidate;
}

function calculateReanchorScore(
  candidate: CandidateMatch,
  baseTranscriptIndex: number,
  baseParagraphIndex: number
): number {
  const transcriptOffset = candidate.transcriptStart - baseTranscriptIndex;
  const paragraphOffset = candidate.paragraphStart - baseParagraphIndex;
  const windowPenalty =
    ((candidate.transcriptEnd - candidate.transcriptStart - 1) * 0.015) +
    ((candidate.paragraphEnd - candidate.paragraphStart - 1) * 0.012);
  return candidate.similarity - (transcriptOffset * 0.02) - (paragraphOffset * 0.012) - windowPenalty;
}

function findBestReanchorCandidate(
  transcriptSegments: TranscriptSegment[],
  articleParagraphs: ArticleParagraph[],
  transcriptIndex: number,
  paragraphIndex: number
): CandidateMatch | null {
  const options = {
    maxSegmentWindow: 4,
    maxParagraphWindow: 4,
    maxTranscriptLookahead: 24,
    maxParagraphLookahead: 12
  };

  let bestCandidate: CandidateMatch | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let transcriptOffset = 0; transcriptOffset <= options.maxTranscriptLookahead; transcriptOffset += 1) {
    const candidateTranscriptStart = transcriptIndex + transcriptOffset;
    if (candidateTranscriptStart >= transcriptSegments.length) {
      break;
    }

    for (let paragraphOffset = 0; paragraphOffset <= options.maxParagraphLookahead; paragraphOffset += 1) {
      const candidateParagraphStart = paragraphIndex + paragraphOffset;
      if (candidateParagraphStart >= articleParagraphs.length) {
        break;
      }

      for (let transcriptWindow = 1; transcriptWindow <= options.maxSegmentWindow; transcriptWindow += 1) {
        if (candidateTranscriptStart + transcriptWindow > transcriptSegments.length) {
          break;
        }

        for (let paragraphWindow = 1; paragraphWindow <= options.maxParagraphWindow; paragraphWindow += 1) {
          if (candidateParagraphStart + paragraphWindow > articleParagraphs.length) {
            break;
          }

          const candidate = buildCandidate(
            transcriptSegments,
            articleParagraphs,
            candidateTranscriptStart,
            transcriptWindow,
            candidateParagraphStart,
            paragraphWindow,
            transcriptIndex,
            paragraphIndex
          );
          if (!candidate) {
            continue;
          }

          const reanchorScore = calculateReanchorScore(candidate, transcriptIndex, paragraphIndex);
          if (!bestCandidate || reanchorScore > bestScore) {
            bestCandidate = candidate;
            bestScore = reanchorScore;
          }
        }
      }
    }
  }

  return bestCandidate;
}

function appendCandidateSyncEntries(
  syncEntries: SyncEntry[],
  transcriptSegments: TranscriptSegment[],
  articleParagraphs: ArticleParagraph[],
  candidate: CandidateMatch
): void {
  const transcriptSlice = trimLowSignalSegments(
    transcriptSegments.slice(candidate.transcriptStart, candidate.transcriptEnd)
  );
  const articleSlice = articleParagraphs.slice(candidate.paragraphStart, candidate.paragraphEnd);
  const weights = articleSlice.map((paragraph) => Math.max(1, normalizeAlignmentText(paragraph.text).length));
  const timeRanges = splitTimeRange(
    transcriptSlice[0]?.startMs ?? 0,
    transcriptSlice[transcriptSlice.length - 1]?.endMs ?? 0,
    weights
  );
  const transcriptSegmentIndexes = transcriptSlice.map((segment) => segment.index);
  for (let itemIndex = 0; itemIndex < articleSlice.length; itemIndex += 1) {
    const paragraph = articleSlice[itemIndex];
    const [startMs, endMs] = timeRanges[itemIndex] ?? [
      transcriptSlice[0]?.startMs ?? 0,
      transcriptSlice[transcriptSlice.length - 1]?.endMs ?? 0
    ];
    syncEntries.push({
      paragraphIndex: paragraph.paragraphIndex,
      startMs,
      endMs,
      transcriptSegmentIndexes,
      alignmentScore: candidate.similarity
    });
  }
}

function fillSmallGapSyncEntries(
  syncEntries: SyncEntry[],
  articleParagraphs: ArticleParagraph[],
  options: { maxGapParagraphs: number; maxGapDurationMs: number }
): SyncEntry[] {
  if (syncEntries.length === 0) {
    return [];
  }

  const paragraphLookup = new Map(articleParagraphs.map((paragraph) => [paragraph.paragraphIndex, paragraph] as const));
  const filledEntries: SyncEntry[] = [];

  for (let index = 0; index < syncEntries.length; index += 1) {
    const currentEntry = syncEntries[index];
    filledEntries.push(currentEntry);
    if (index === syncEntries.length - 1) {
      continue;
    }

    const nextEntry = syncEntries[index + 1];
    const missingCount = nextEntry.paragraphIndex - currentEntry.paragraphIndex - 1;
    const availableDuration = nextEntry.startMs - currentEntry.endMs;
    if (missingCount <= 0 || missingCount > options.maxGapParagraphs) {
      continue;
    }
    if (availableDuration <= 120 || availableDuration > options.maxGapDurationMs) {
      continue;
    }

    const missingParagraphs: ArticleParagraph[] = [];
    for (let paragraphIndex = currentEntry.paragraphIndex + 1; paragraphIndex < nextEntry.paragraphIndex; paragraphIndex += 1) {
      const paragraph = paragraphLookup.get(paragraphIndex);
      if (!paragraph) {
        missingParagraphs.length = 0;
        break;
      }
      missingParagraphs.push(paragraph);
    }

    if (missingParagraphs.length === 0) {
      continue;
    }

    const weights = missingParagraphs.map((paragraph) => Math.max(1, normalizeAlignmentText(paragraph.text).length));
    const timeRanges = splitTimeRange(currentEntry.endMs, nextEntry.startMs, weights);
    for (let missingIndex = 0; missingIndex < missingParagraphs.length; missingIndex += 1) {
      const paragraph = missingParagraphs[missingIndex];
      const [startMs, endMs] = timeRanges[missingIndex] ?? [currentEntry.endMs, nextEntry.startMs];
      filledEntries.push({
        paragraphIndex: paragraph.paragraphIndex,
        startMs,
        endMs,
        transcriptSegmentIndexes: [],
        alignmentScore: 0.35
      });
    }
  }

  return filledEntries.sort((left, right) => left.paragraphIndex - right.paragraphIndex);
}

function estimateFallbackParagraphDurationMs(
  transcriptSegments: TranscriptSegment[],
  articleParagraphs: ArticleParagraph[],
  syncEntries: SyncEntry[]
): number {
  if (syncEntries.length >= 2) {
    const totalAnchoredDuration = syncEntries[syncEntries.length - 1].endMs - syncEntries[0].startMs;
    const anchoredSpanParagraphs = syncEntries[syncEntries.length - 1].paragraphIndex - syncEntries[0].paragraphIndex + 1;
    if (totalAnchoredDuration > 0 && anchoredSpanParagraphs > 0) {
      return totalAnchoredDuration / anchoredSpanParagraphs;
    }
  }

  const transcriptDuration =
    Math.max(0, (transcriptSegments[transcriptSegments.length - 1]?.endMs ?? 0) - (transcriptSegments[0]?.startMs ?? 0));
  if (transcriptDuration > 0 && articleParagraphs.length > 0) {
    return transcriptDuration / articleParagraphs.length;
  }

  return 1500;
}

function fillRemainingGapSyncEntries(
  syncEntries: SyncEntry[],
  transcriptSegments: TranscriptSegment[],
  articleParagraphs: ArticleParagraph[]
): SyncEntry[] {
  if (syncEntries.length === 0) {
    return [];
  }

  const sortedEntries = [...syncEntries].sort((left, right) => left.paragraphIndex - right.paragraphIndex);
  const entryByParagraphIndex = new Map(sortedEntries.map((entry) => [entry.paragraphIndex, entry] as const));
  const fallbackParagraphDurationMs = estimateFallbackParagraphDurationMs(transcriptSegments, articleParagraphs, sortedEntries);
  const transcriptStartMs = Math.max(0, transcriptSegments[0]?.startMs ?? 0);
  const transcriptEndMs = Math.max(transcriptStartMs, transcriptSegments[transcriptSegments.length - 1]?.endMs ?? transcriptStartMs);

  const firstEntry = sortedEntries[0];
  if (firstEntry && firstEntry.paragraphIndex > articleParagraphs[0].paragraphIndex) {
    const headParagraphs = articleParagraphs.filter((paragraph) => paragraph.paragraphIndex < firstEntry.paragraphIndex);
    const headStartMs = Math.max(transcriptStartMs, firstEntry.startMs - (fallbackParagraphDurationMs * headParagraphs.length));
    const headRanges = splitTimeRange(headStartMs, Math.max(headStartMs, firstEntry.startMs), headParagraphs.map((paragraph) => Math.max(1, normalizeAlignmentText(paragraph.text).length)));
    headParagraphs.forEach((paragraph, index) => {
      if (entryByParagraphIndex.has(paragraph.paragraphIndex)) {
        return;
      }
      const [startMs, endMs] = headRanges[index] ?? [headStartMs, firstEntry.startMs];
      entryByParagraphIndex.set(paragraph.paragraphIndex, {
        paragraphIndex: paragraph.paragraphIndex,
        startMs,
        endMs,
        transcriptSegmentIndexes: [],
        alignmentScore: 0.2
      });
    });
  }

  for (let index = 0; index < sortedEntries.length - 1; index += 1) {
    const currentEntry = sortedEntries[index];
    const nextEntry = sortedEntries[index + 1];
    const gapParagraphs = articleParagraphs.filter(
      (paragraph) => paragraph.paragraphIndex > currentEntry.paragraphIndex && paragraph.paragraphIndex < nextEntry.paragraphIndex
    );
    if (gapParagraphs.length === 0) {
      continue;
    }

    const gapStartMs = Math.min(currentEntry.endMs, nextEntry.startMs);
    const gapEndMs = Math.max(currentEntry.endMs, nextEntry.startMs);
    const ranges =
      gapEndMs > gapStartMs
        ? splitTimeRange(
            gapStartMs,
            gapEndMs,
            gapParagraphs.map((paragraph) => Math.max(1, normalizeAlignmentText(paragraph.text).length))
          )
        : gapParagraphs.map((_, gapIndex) => {
            const startMs = currentEntry.endMs + (gapIndex * fallbackParagraphDurationMs);
            return [startMs, startMs + fallbackParagraphDurationMs] as [number, number];
          });

    gapParagraphs.forEach((paragraph, gapIndex) => {
      if (entryByParagraphIndex.has(paragraph.paragraphIndex)) {
        return;
      }
      const [startMs, endMs] = ranges[gapIndex] ?? [currentEntry.endMs, nextEntry.startMs];
      entryByParagraphIndex.set(paragraph.paragraphIndex, {
        paragraphIndex: paragraph.paragraphIndex,
        startMs,
        endMs,
        transcriptSegmentIndexes: [],
        alignmentScore: 0.18
      });
    });
  }

  const lastEntry = sortedEntries[sortedEntries.length - 1];
  if (lastEntry && lastEntry.paragraphIndex < articleParagraphs[articleParagraphs.length - 1].paragraphIndex) {
    const tailParagraphs = articleParagraphs.filter((paragraph) => paragraph.paragraphIndex > lastEntry.paragraphIndex);
    const tailEndMs = Math.max(lastEntry.endMs, Math.min(transcriptEndMs, lastEntry.endMs + (fallbackParagraphDurationMs * tailParagraphs.length)));
    const tailRanges = splitTimeRange(lastEntry.endMs, tailEndMs, tailParagraphs.map((paragraph) => Math.max(1, normalizeAlignmentText(paragraph.text).length)));
    tailParagraphs.forEach((paragraph, index) => {
      if (entryByParagraphIndex.has(paragraph.paragraphIndex)) {
        return;
      }
      const [startMs, endMs] = tailRanges[index] ?? [lastEntry.endMs, tailEndMs];
      entryByParagraphIndex.set(paragraph.paragraphIndex, {
        paragraphIndex: paragraph.paragraphIndex,
        startMs,
        endMs,
        transcriptSegmentIndexes: [],
        alignmentScore: 0.2
      });
    });
  }

  return Array.from(entryByParagraphIndex.values()).sort((left, right) => left.paragraphIndex - right.paragraphIndex);
}

function sortSyncEntriesByTimeline(syncEntries: SyncEntry[]): SyncEntry[] {
  return [...syncEntries]
    .map((entry) => {
      const startMs = Math.max(0, entry.startMs);
      return {
        ...entry,
        startMs,
        endMs: Math.max(startMs + 1, entry.endMs)
      };
    })
    .sort((left, right) => {
      if (left.startMs !== right.startMs) {
        return left.startMs - right.startMs;
      }
      if (left.endMs !== right.endMs) {
        return left.endMs - right.endMs;
      }
      return left.paragraphIndex - right.paragraphIndex;
    });
}

function finalizeAlignmentResult(
  syncEntries: SyncEntry[],
  transcriptSegments: TranscriptSegment[],
  articleParagraphs: ArticleParagraph[]
): AlignmentResult {
  const smallGapFilledEntries = fillSmallGapSyncEntries(
    syncEntries.sort((left, right) => left.paragraphIndex - right.paragraphIndex),
    articleParagraphs,
    {
      maxGapParagraphs: 3,
      maxGapDurationMs: 12000
    }
  );
  const allFilledEntries = fillRemainingGapSyncEntries(smallGapFilledEntries, transcriptSegments, articleParagraphs);
  const timelineSortedEntries = sortSyncEntriesByTimeline(allFilledEntries);
  const anchoredParagraphCount = timelineSortedEntries.filter((entry) => entry.transcriptSegmentIndexes.length > 0).length;
  const unmatchedParagraphCount = articleParagraphs.length - timelineSortedEntries.length;

  return {
    syncEntries: timelineSortedEntries,
    matchedParagraphCount: anchoredParagraphCount,
    unmatchedParagraphCount,
    consumedSegmentCount: transcriptSegments.length
  };
}

function buildAlignmentOptions(): {
  maxSegmentWindow: number;
  maxParagraphWindow: number;
  maxTranscriptLookahead: number;
  maxParagraphLookahead: number;
} {
  return {
    maxSegmentWindow: 3,
    maxParagraphWindow: 3,
    maxTranscriptLookahead: 4,
    maxParagraphLookahead: 4
  };
}

function createProgressReporter(
  transcriptSegments: TranscriptSegment[],
  articleParagraphs: ArticleParagraph[],
  onProgress?: (progress: RuntimeManifestBuildProgress) => void
): (phase: RuntimeManifestBuildProgress["phase"], processedSegmentCount: number, processedParagraphCount: number, message: string) => void {
  return (phase, processedSegmentCount, processedParagraphCount, message) => {
    if (!onProgress) {
      return;
    }

    const progressBase =
      phase === "preparing"
        ? 0.04
        : phase === "matching"
          ? 0.08 + (0.8 * Math.max(
            processedParagraphCount / Math.max(articleParagraphs.length, 1),
            processedSegmentCount / Math.max(transcriptSegments.length, 1)
          ))
          : phase === "smoothing"
            ? 0.93
            : 1;

    onProgress({
      phase,
      processedParagraphCount,
      articleParagraphCount: articleParagraphs.length,
      processedSegmentCount,
      subtitleSegmentCount: transcriptSegments.length,
      percent: Math.max(0, Math.min(1, progressBase)),
      message
    });
  };
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

function buildSyncEntries(
  transcriptSegments: TranscriptSegment[],
  articleParagraphs: ArticleParagraph[]
): AlignmentResult {
  const syncEntries: SyncEntry[] = [];
  let transcriptIndex = 0;
  let paragraphIndex = 0;

  const options = buildAlignmentOptions();
  const minimumMatchScore = 0.55;
  const rescueMatchScore = 0.48;
  const reanchorSimilarityThreshold = 0.74;
  const reanchorScoreThreshold = 0.56;

  while (transcriptIndex < transcriptSegments.length && paragraphIndex < articleParagraphs.length) {
    const candidate = findBestCandidate(transcriptSegments, articleParagraphs, transcriptIndex, paragraphIndex, options);
    if (candidate && candidate.score >= minimumMatchScore) {
      appendCandidateSyncEntries(syncEntries, transcriptSegments, articleParagraphs, candidate);
      transcriptIndex = candidate.transcriptEnd;
      paragraphIndex = candidate.paragraphEnd;
      continue;
    }

    const rescueCandidate =
      candidate &&
      candidate.score >= rescueMatchScore &&
      candidate.transcriptStart === transcriptIndex &&
      candidate.paragraphStart === paragraphIndex
        ? candidate
        : null;
    if (rescueCandidate) {
      appendCandidateSyncEntries(syncEntries, transcriptSegments, articleParagraphs, rescueCandidate);
      transcriptIndex = rescueCandidate.transcriptEnd;
      paragraphIndex = rescueCandidate.paragraphEnd;
      continue;
    }

    const currentTranscriptText = transcriptSegments[transcriptIndex]?.text ?? "";
    const currentParagraphText = articleParagraphs[paragraphIndex]?.text ?? "";
    if (isLowSignalText(currentTranscriptText)) {
      transcriptIndex += 1;
      continue;
    }
    if (isLowSignalText(currentParagraphText)) {
      paragraphIndex += 1;
      continue;
    }

    const reanchorCandidate = findBestReanchorCandidate(
      transcriptSegments,
      articleParagraphs,
      transcriptIndex,
      paragraphIndex
    );
    const reanchorScore = reanchorCandidate
      ? calculateReanchorScore(reanchorCandidate, transcriptIndex, paragraphIndex)
      : Number.NEGATIVE_INFINITY;
    if (
      reanchorCandidate &&
      reanchorCandidate.similarity >= reanchorSimilarityThreshold &&
      reanchorScore >= reanchorScoreThreshold
    ) {
      appendCandidateSyncEntries(syncEntries, transcriptSegments, articleParagraphs, reanchorCandidate);
      transcriptIndex = reanchorCandidate.transcriptEnd;
      paragraphIndex = reanchorCandidate.paragraphEnd;
      continue;
    }

    const skipTranscriptCandidate = findBestCandidate(
      transcriptSegments,
      articleParagraphs,
      Math.min(transcriptIndex + 1, transcriptSegments.length),
      paragraphIndex,
      options
    );
    const skipParagraphCandidate = findBestCandidate(
      transcriptSegments,
      articleParagraphs,
      transcriptIndex,
      Math.min(paragraphIndex + 1, articleParagraphs.length),
      options
    );
    const skipTranscriptScore = skipTranscriptCandidate?.score ?? -1;
    const skipParagraphScore = skipParagraphCandidate?.score ?? -1;
    if (skipTranscriptScore >= skipParagraphScore) {
      transcriptIndex += 1;
    } else {
      paragraphIndex += 1;
    }
  }

  const finalizedResult = finalizeAlignmentResult(syncEntries, transcriptSegments, articleParagraphs);
  return {
    ...finalizedResult,
    consumedSegmentCount: transcriptIndex
  };
}

async function buildSyncEntriesAsync(
  transcriptSegments: TranscriptSegment[],
  articleParagraphs: ArticleParagraph[],
  onProgress?: (progress: RuntimeManifestBuildProgress) => void
): Promise<AlignmentResult> {
  const reportProgress = createProgressReporter(transcriptSegments, articleParagraphs, onProgress);
  reportProgress("preparing", 0, 0, "正在准备字幕和文章段落...");

  const syncEntries: SyncEntry[] = [];
  let transcriptIndex = 0;
  let paragraphIndex = 0;
  let iterationCount = 0;
  let lastYieldAt = performance.now();

  const options = buildAlignmentOptions();
  const minimumMatchScore = 0.55;
  const rescueMatchScore = 0.48;
  const reanchorSimilarityThreshold = 0.74;
  const reanchorScoreThreshold = 0.56;

  while (transcriptIndex < transcriptSegments.length && paragraphIndex < articleParagraphs.length) {
    iterationCount += 1;
    const candidate = findBestCandidate(transcriptSegments, articleParagraphs, transcriptIndex, paragraphIndex, options);
    if (candidate && candidate.score >= minimumMatchScore) {
      appendCandidateSyncEntries(syncEntries, transcriptSegments, articleParagraphs, candidate);
      transcriptIndex = candidate.transcriptEnd;
      paragraphIndex = candidate.paragraphEnd;
    } else {
      const rescueCandidate =
        candidate &&
        candidate.score >= rescueMatchScore &&
        candidate.transcriptStart === transcriptIndex &&
        candidate.paragraphStart === paragraphIndex
          ? candidate
          : null;

      if (rescueCandidate) {
        appendCandidateSyncEntries(syncEntries, transcriptSegments, articleParagraphs, rescueCandidate);
        transcriptIndex = rescueCandidate.transcriptEnd;
        paragraphIndex = rescueCandidate.paragraphEnd;
      } else {
        const currentTranscriptText = transcriptSegments[transcriptIndex]?.text ?? "";
        const currentParagraphText = articleParagraphs[paragraphIndex]?.text ?? "";
        if (isLowSignalText(currentTranscriptText)) {
          transcriptIndex += 1;
        } else if (isLowSignalText(currentParagraphText)) {
          paragraphIndex += 1;
        } else {
          const reanchorCandidate = findBestReanchorCandidate(
            transcriptSegments,
            articleParagraphs,
            transcriptIndex,
            paragraphIndex
          );
          const reanchorScore = reanchorCandidate
            ? calculateReanchorScore(reanchorCandidate, transcriptIndex, paragraphIndex)
            : Number.NEGATIVE_INFINITY;
          if (
            reanchorCandidate &&
            reanchorCandidate.similarity >= reanchorSimilarityThreshold &&
            reanchorScore >= reanchorScoreThreshold
          ) {
            appendCandidateSyncEntries(syncEntries, transcriptSegments, articleParagraphs, reanchorCandidate);
            transcriptIndex = reanchorCandidate.transcriptEnd;
            paragraphIndex = reanchorCandidate.paragraphEnd;
            continue;
          }

          const skipTranscriptCandidate = findBestCandidate(
            transcriptSegments,
            articleParagraphs,
            Math.min(transcriptIndex + 1, transcriptSegments.length),
            paragraphIndex,
            options
          );
          const skipParagraphCandidate = findBestCandidate(
            transcriptSegments,
            articleParagraphs,
            transcriptIndex,
            Math.min(paragraphIndex + 1, articleParagraphs.length),
            options
          );
          const skipTranscriptScore = skipTranscriptCandidate?.score ?? -1;
          const skipParagraphScore = skipParagraphCandidate?.score ?? -1;
          if (skipTranscriptScore >= skipParagraphScore) {
            transcriptIndex += 1;
          } else {
            paragraphIndex += 1;
          }
        }
      }
    }

    if (iterationCount % 2 === 0 || performance.now() - lastYieldAt >= 20) {
      reportProgress("matching", transcriptIndex, paragraphIndex, `正在匹配第 ${Math.min(paragraphIndex + 1, articleParagraphs.length)}/${articleParagraphs.length} 段...`);
      await yieldToBrowser();
      lastYieldAt = performance.now();
    }
  }

  reportProgress("smoothing", transcriptIndex, paragraphIndex, "正在平滑补齐小缺口...");
  await yieldToBrowser();

  reportProgress("finalizing", transcriptIndex, articleParagraphs.length, "正在生成最终同步清单...");

  const finalizedResult = finalizeAlignmentResult(syncEntries, transcriptSegments, articleParagraphs);
  return {
    ...finalizedResult,
    consumedSegmentCount: transcriptIndex
  };
}

export function buildRuntimeManifestFromSubtitle(
  subtitleDocument: ParsedSubtitleDocument,
  articleSnapshot: AimReadArticleSnapshot
): RuntimeManifestBuildResult {
  const transcriptSegments = subtitleDocument.transcript.segments;
  const articleParagraphs = articleSnapshot.paragraphs;
  if (transcriptSegments.length === 0) {
    throw new Error("字幕文件里没有可用对白段。");
  }
  if (articleParagraphs.length === 0) {
    throw new Error("文章快照为空，无法执行运行时匹配。");
  }

  const alignmentResult = buildSyncEntries(transcriptSegments, articleParagraphs);
  if (alignmentResult.syncEntries.length === 0) {
    throw new Error("字幕与当前文章没有找到可用匹配，暂时无法生成同步清单。");
  }

  const smoothedParagraphCount = alignmentResult.syncEntries.filter((entry) => entry.transcriptSegmentIndexes.length === 0).length;
  const coverageRatio = alignmentResult.matchedParagraphCount / articleParagraphs.length;
  if (alignmentResult.matchedParagraphCount < 3) {
    throw new Error(`直接命中的锚点过少 (${alignmentResult.matchedParagraphCount} 段)，请确认当前页面和字幕是否属于同一集。`);
  }

  const manifest: EpisodeSyncManifest = {
    version: "1.0.0",
    source: {
      slug: normalizeEpisodeSlug(subtitleDocument.fileName),
      title: articleSnapshot.title || subtitleDocument.metadata.title,
      createdAt: new Date().toISOString(),
      generator: "reader-sync-extension-runtime-subtitle",
      mediaFileName: subtitleDocument.fileName,
      articleUrl: articleSnapshot.articleUrl,
      articleId: articleSnapshot.articleId ?? undefined,
      categoryId: articleSnapshot.categoryId ?? undefined
    },
    transcript: {
      mode: subtitleDocument.transcript.mode,
      language: subtitleDocument.transcript.language,
      modelName: subtitleDocument.transcript.modelName,
      text: subtitleDocument.transcript.text,
      segments: transcriptSegments
    },
    article: {
      capturedAt: articleSnapshot.capturedAt,
      title: articleSnapshot.title,
      articleUrl: articleSnapshot.articleUrl,
      paragraphs: articleParagraphs
    },
    sync: alignmentResult.syncEntries
  };

  return {
    manifest,
    stats: {
      subtitleSegmentCount: transcriptSegments.length,
      articleParagraphCount: articleParagraphs.length,
      matchedParagraphCount: alignmentResult.matchedParagraphCount,
      unmatchedParagraphCount: alignmentResult.unmatchedParagraphCount,
      smoothedParagraphCount,
      consumedSegmentCount: alignmentResult.consumedSegmentCount,
      coverageRatio
    }
  };
}

export async function buildRuntimeManifestFromSubtitleAsync(
  subtitleDocument: ParsedSubtitleDocument,
  articleSnapshot: AimReadArticleSnapshot,
  onProgress?: (progress: RuntimeManifestBuildProgress) => void
): Promise<RuntimeManifestBuildResult> {
  const transcriptSegments = subtitleDocument.transcript.segments;
  const articleParagraphs = articleSnapshot.paragraphs;
  if (transcriptSegments.length === 0) {
    throw new Error("字幕文件里没有可用对白段。");
  }
  if (articleParagraphs.length === 0) {
    throw new Error("文章快照为空，无法执行运行时匹配。");
  }

  const alignmentResult = await buildSyncEntriesAsync(transcriptSegments, articleParagraphs, onProgress);
  if (alignmentResult.syncEntries.length === 0) {
    throw new Error("字幕与当前文章没有找到可用匹配，暂时无法生成同步清单。");
  }

  const smoothedParagraphCount = alignmentResult.syncEntries.filter((entry) => entry.transcriptSegmentIndexes.length === 0).length;
  const coverageRatio = alignmentResult.matchedParagraphCount / articleParagraphs.length;
  if (alignmentResult.matchedParagraphCount < 3) {
    throw new Error(`直接命中的锚点过少 (${alignmentResult.matchedParagraphCount} 段)，请确认当前页面和字幕是否属于同一集。`);
  }

  const manifest: EpisodeSyncManifest = {
    version: "1.0.0",
    source: {
      slug: normalizeEpisodeSlug(subtitleDocument.fileName),
      title: articleSnapshot.title || subtitleDocument.metadata.title,
      createdAt: new Date().toISOString(),
      generator: "reader-sync-extension-runtime-subtitle",
      mediaFileName: subtitleDocument.fileName,
      articleUrl: articleSnapshot.articleUrl,
      articleId: articleSnapshot.articleId ?? undefined,
      categoryId: articleSnapshot.categoryId ?? undefined
    },
    transcript: {
      mode: subtitleDocument.transcript.mode,
      language: subtitleDocument.transcript.language,
      modelName: subtitleDocument.transcript.modelName,
      text: subtitleDocument.transcript.text,
      segments: transcriptSegments
    },
    article: {
      capturedAt: articleSnapshot.capturedAt,
      title: articleSnapshot.title,
      articleUrl: articleSnapshot.articleUrl,
      paragraphs: articleParagraphs
    },
    sync: alignmentResult.syncEntries
  };

  return {
    manifest,
    stats: {
      subtitleSegmentCount: transcriptSegments.length,
      articleParagraphCount: articleParagraphs.length,
      matchedParagraphCount: alignmentResult.matchedParagraphCount,
      unmatchedParagraphCount: alignmentResult.unmatchedParagraphCount,
      smoothedParagraphCount,
      consumedSegmentCount: alignmentResult.consumedSegmentCount,
      coverageRatio
    }
  };
}
