// src/shared/logger.ts
function log(level, scope, message, metadata) {
  const prefix = `[reader-sync:${scope}]`;
  if (metadata === void 0) {
    console[level](`${prefix} ${message}`);
    return;
  }
  console[level](`${prefix} ${message}`, metadata);
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
var PLAYER_PORT_NAME = "reader-sync-player";
function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}
function normalizeEpisodeSlug(fileName) {
  const sanitized = fileName.toLowerCase().replace(/\.[a-z0-9]{2,4}$/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const seasonEpisodeMatch = sanitized.match(/^(.*?)(s\d{1,2}e\d{1,2})\b/);
  if (seasonEpisodeMatch) {
    const seriesName = seasonEpisodeMatch[1].replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
    const episodeToken = seasonEpisodeMatch[2];
    return `${seriesName}_${episodeToken}`;
  }
  return sanitized.replace(/[^a-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
}
function resolveActiveSyncEntry(manifest2, currentTimeMs) {
  if (!manifest2 || manifest2.sync.length === 0) {
    return null;
  }
  let low = 0;
  let high = manifest2.sync.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const entry = manifest2.sync[middle];
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
  let nearestEntry = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const entry of manifest2.sync) {
    if (currentTimeMs >= entry.startMs && currentTimeMs <= entry.endMs) {
      return entry;
    }
    const distance = currentTimeMs < entry.startMs ? entry.startMs - currentTimeMs : currentTimeMs - entry.endMs;
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestEntry = entry;
    }
  }
  return nearestDistance <= 1500 ? nearestEntry : null;
}

// src/shared/runtime-sync-builder.ts
var SPEAKER_PREFIX_PATTERN = /^[A-Za-z][A-Za-z' .-]{0,40}:\s*/;
var NON_ALPHANUMERIC_PATTERN = /[^a-z0-9\s]/g;
var MULTISPACE_PATTERN = /\s+/g;
function normalizeAlignmentText(value) {
  return value.toLowerCase().trim().replace(SPEAKER_PREFIX_PATTERN, "").replace(NON_ALPHANUMERIC_PATTERN, " ").replace(MULTISPACE_PATTERN, " ").trim();
}
function tokenizeAlignmentText(value) {
  return normalizeAlignmentText(value).split(" ").filter((token) => token.length >= 2);
}
function lcsLength(left, right) {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const row = new Array(right.length + 1).fill(0);
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
function calculateSimilarity(left, right) {
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
  let score = Math.max(lcsRatio, lcsRatio * 0.75 + tokenOverlap * 0.25);
  const normalizedLeft = normalizeAlignmentText(left);
  const normalizedRight = normalizeAlignmentText(right);
  if (Math.min(normalizedLeft.length, normalizedRight.length) >= 15 && tokenOverlap >= 0.45 && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))) {
    score = Math.max(score, 0.9);
  }
  return score;
}
function joinTranscriptText(segments) {
  return segments.map((segment) => normalizeAlignmentText(segment.text)).filter(Boolean).join(" ").trim();
}
function joinArticleText(paragraphs) {
  return paragraphs.map((paragraph) => normalizeAlignmentText(paragraph.text)).filter(Boolean).join(" ").trim();
}
function splitTimeRange(startMs, endMs, weights) {
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0 || endMs <= startMs) {
    return weights.map(() => [startMs, endMs]);
  }
  const result = [];
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
function isLowSignalText(value) {
  if (value.includes("\u{1F3BC}")) {
    return true;
  }
  const normalized = normalizeAlignmentText(value);
  if (!normalized) {
    return true;
  }
  const tokens = tokenizeAlignmentText(normalized);
  return tokens.length <= 2 && normalized.length <= 12;
}
function trimLowSignalSegments(segments) {
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
function buildCandidate(transcriptSegments, articleParagraphs, transcriptStart, transcriptWindow, paragraphStart, paragraphWindow, baseTranscriptIndex, baseParagraphIndex) {
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
  const continuityPenalty = (transcriptStart - baseTranscriptIndex) * 0.09 + (paragraphStart - baseParagraphIndex) * 0.06;
  const windowPenalty = (transcriptWindow - 1) * 0.02 + (paragraphWindow - 1) * 0.015;
  const score = similarity * (0.85 + 0.15 * lengthBalance) - continuityPenalty - windowPenalty;
  return {
    transcriptStart,
    transcriptEnd: transcriptStart + transcriptWindow,
    paragraphStart,
    paragraphEnd: paragraphStart + paragraphWindow,
    similarity,
    score
  };
}
function findBestCandidate(transcriptSegments, articleParagraphs, transcriptIndex, paragraphIndex, options) {
  let bestCandidate = null;
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
function calculateReanchorScore(candidate, baseTranscriptIndex, baseParagraphIndex) {
  const transcriptOffset = candidate.transcriptStart - baseTranscriptIndex;
  const paragraphOffset = candidate.paragraphStart - baseParagraphIndex;
  const windowPenalty = (candidate.transcriptEnd - candidate.transcriptStart - 1) * 0.015 + (candidate.paragraphEnd - candidate.paragraphStart - 1) * 0.012;
  return candidate.similarity - transcriptOffset * 0.02 - paragraphOffset * 0.012 - windowPenalty;
}
function findBestReanchorCandidate(transcriptSegments, articleParagraphs, transcriptIndex, paragraphIndex) {
  const options = {
    maxSegmentWindow: 4,
    maxParagraphWindow: 4,
    maxTranscriptLookahead: 24,
    maxParagraphLookahead: 12
  };
  let bestCandidate = null;
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
function appendCandidateSyncEntries(syncEntries, transcriptSegments, articleParagraphs, candidate) {
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
function fillSmallGapSyncEntries(syncEntries, articleParagraphs, options) {
  if (syncEntries.length === 0) {
    return [];
  }
  const paragraphLookup = new Map(articleParagraphs.map((paragraph) => [paragraph.paragraphIndex, paragraph]));
  const filledEntries = [];
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
    const missingParagraphs = [];
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
function estimateFallbackParagraphDurationMs(transcriptSegments, articleParagraphs, syncEntries) {
  if (syncEntries.length >= 2) {
    const totalAnchoredDuration = syncEntries[syncEntries.length - 1].endMs - syncEntries[0].startMs;
    const anchoredSpanParagraphs = syncEntries[syncEntries.length - 1].paragraphIndex - syncEntries[0].paragraphIndex + 1;
    if (totalAnchoredDuration > 0 && anchoredSpanParagraphs > 0) {
      return totalAnchoredDuration / anchoredSpanParagraphs;
    }
  }
  const transcriptDuration = Math.max(0, (transcriptSegments[transcriptSegments.length - 1]?.endMs ?? 0) - (transcriptSegments[0]?.startMs ?? 0));
  if (transcriptDuration > 0 && articleParagraphs.length > 0) {
    return transcriptDuration / articleParagraphs.length;
  }
  return 1500;
}
function fillRemainingGapSyncEntries(syncEntries, transcriptSegments, articleParagraphs) {
  if (syncEntries.length === 0) {
    return [];
  }
  const sortedEntries = [...syncEntries].sort((left, right) => left.paragraphIndex - right.paragraphIndex);
  const entryByParagraphIndex = new Map(sortedEntries.map((entry) => [entry.paragraphIndex, entry]));
  const fallbackParagraphDurationMs = estimateFallbackParagraphDurationMs(transcriptSegments, articleParagraphs, sortedEntries);
  const transcriptStartMs = Math.max(0, transcriptSegments[0]?.startMs ?? 0);
  const transcriptEndMs = Math.max(transcriptStartMs, transcriptSegments[transcriptSegments.length - 1]?.endMs ?? transcriptStartMs);
  const firstEntry = sortedEntries[0];
  if (firstEntry && firstEntry.paragraphIndex > articleParagraphs[0].paragraphIndex) {
    const headParagraphs = articleParagraphs.filter((paragraph) => paragraph.paragraphIndex < firstEntry.paragraphIndex);
    const headStartMs = Math.max(transcriptStartMs, firstEntry.startMs - fallbackParagraphDurationMs * headParagraphs.length);
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
    const ranges = gapEndMs > gapStartMs ? splitTimeRange(
      gapStartMs,
      gapEndMs,
      gapParagraphs.map((paragraph) => Math.max(1, normalizeAlignmentText(paragraph.text).length))
    ) : gapParagraphs.map((_, gapIndex) => {
      const startMs = currentEntry.endMs + gapIndex * fallbackParagraphDurationMs;
      return [startMs, startMs + fallbackParagraphDurationMs];
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
    const tailEndMs = Math.max(lastEntry.endMs, Math.min(transcriptEndMs, lastEntry.endMs + fallbackParagraphDurationMs * tailParagraphs.length));
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
function sortSyncEntriesByTimeline(syncEntries) {
  return [...syncEntries].map((entry) => {
    const startMs = Math.max(0, entry.startMs);
    return {
      ...entry,
      startMs,
      endMs: Math.max(startMs + 1, entry.endMs)
    };
  }).sort((left, right) => {
    if (left.startMs !== right.startMs) {
      return left.startMs - right.startMs;
    }
    if (left.endMs !== right.endMs) {
      return left.endMs - right.endMs;
    }
    return left.paragraphIndex - right.paragraphIndex;
  });
}
function finalizeAlignmentResult(syncEntries, transcriptSegments, articleParagraphs) {
  const smallGapFilledEntries = fillSmallGapSyncEntries(
    syncEntries.sort((left, right) => left.paragraphIndex - right.paragraphIndex),
    articleParagraphs,
    {
      maxGapParagraphs: 3,
      maxGapDurationMs: 12e3
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
function buildAlignmentOptions() {
  return {
    maxSegmentWindow: 3,
    maxParagraphWindow: 3,
    maxTranscriptLookahead: 4,
    maxParagraphLookahead: 4
  };
}
function createProgressReporter(transcriptSegments, articleParagraphs, onProgress) {
  return (phase, processedSegmentCount, processedParagraphCount, message) => {
    if (!onProgress) {
      return;
    }
    const progressBase = phase === "preparing" ? 0.04 : phase === "matching" ? 0.08 + 0.8 * Math.max(
      processedParagraphCount / Math.max(articleParagraphs.length, 1),
      processedSegmentCount / Math.max(transcriptSegments.length, 1)
    ) : phase === "smoothing" ? 0.93 : 1;
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
function yieldToBrowser() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}
async function buildSyncEntriesAsync(transcriptSegments, articleParagraphs, onProgress) {
  const reportProgress = createProgressReporter(transcriptSegments, articleParagraphs, onProgress);
  reportProgress("preparing", 0, 0, "\u6B63\u5728\u51C6\u5907\u5B57\u5E55\u548C\u6587\u7AE0\u6BB5\u843D...");
  const syncEntries = [];
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
      const rescueCandidate = candidate && candidate.score >= rescueMatchScore && candidate.transcriptStart === transcriptIndex && candidate.paragraphStart === paragraphIndex ? candidate : null;
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
          const reanchorScore = reanchorCandidate ? calculateReanchorScore(reanchorCandidate, transcriptIndex, paragraphIndex) : Number.NEGATIVE_INFINITY;
          if (reanchorCandidate && reanchorCandidate.similarity >= reanchorSimilarityThreshold && reanchorScore >= reanchorScoreThreshold) {
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
      reportProgress("matching", transcriptIndex, paragraphIndex, `\u6B63\u5728\u5339\u914D\u7B2C ${Math.min(paragraphIndex + 1, articleParagraphs.length)}/${articleParagraphs.length} \u6BB5...`);
      await yieldToBrowser();
      lastYieldAt = performance.now();
    }
  }
  reportProgress("smoothing", transcriptIndex, paragraphIndex, "\u6B63\u5728\u5E73\u6ED1\u8865\u9F50\u5C0F\u7F3A\u53E3...");
  await yieldToBrowser();
  reportProgress("finalizing", transcriptIndex, articleParagraphs.length, "\u6B63\u5728\u751F\u6210\u6700\u7EC8\u540C\u6B65\u6E05\u5355...");
  const finalizedResult = finalizeAlignmentResult(syncEntries, transcriptSegments, articleParagraphs);
  return {
    ...finalizedResult,
    consumedSegmentCount: transcriptIndex
  };
}
async function buildRuntimeManifestFromSubtitleAsync(subtitleDocument, articleSnapshot2, onProgress) {
  const transcriptSegments = subtitleDocument.transcript.segments;
  const articleParagraphs = articleSnapshot2.paragraphs;
  if (transcriptSegments.length === 0) {
    throw new Error("\u5B57\u5E55\u6587\u4EF6\u91CC\u6CA1\u6709\u53EF\u7528\u5BF9\u767D\u6BB5\u3002");
  }
  if (articleParagraphs.length === 0) {
    throw new Error("\u6587\u7AE0\u5FEB\u7167\u4E3A\u7A7A\uFF0C\u65E0\u6CD5\u6267\u884C\u8FD0\u884C\u65F6\u5339\u914D\u3002");
  }
  const alignmentResult = await buildSyncEntriesAsync(transcriptSegments, articleParagraphs, onProgress);
  if (alignmentResult.syncEntries.length === 0) {
    throw new Error("\u5B57\u5E55\u4E0E\u5F53\u524D\u6587\u7AE0\u6CA1\u6709\u627E\u5230\u53EF\u7528\u5339\u914D\uFF0C\u6682\u65F6\u65E0\u6CD5\u751F\u6210\u540C\u6B65\u6E05\u5355\u3002");
  }
  const smoothedParagraphCount = alignmentResult.syncEntries.filter((entry) => entry.transcriptSegmentIndexes.length === 0).length;
  const coverageRatio = alignmentResult.matchedParagraphCount / articleParagraphs.length;
  if (alignmentResult.matchedParagraphCount < 3) {
    throw new Error(`\u76F4\u63A5\u547D\u4E2D\u7684\u951A\u70B9\u8FC7\u5C11 (${alignmentResult.matchedParagraphCount} \u6BB5)\uFF0C\u8BF7\u786E\u8BA4\u5F53\u524D\u9875\u9762\u548C\u5B57\u5E55\u662F\u5426\u5C5E\u4E8E\u540C\u4E00\u96C6\u3002`);
  }
  const manifest2 = {
    version: "1.0.0",
    source: {
      slug: normalizeEpisodeSlug(subtitleDocument.fileName),
      title: articleSnapshot2.title || subtitleDocument.metadata.title,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      generator: "reader-sync-extension-runtime-subtitle",
      mediaFileName: subtitleDocument.fileName,
      articleUrl: articleSnapshot2.articleUrl,
      articleId: articleSnapshot2.articleId ?? void 0,
      categoryId: articleSnapshot2.categoryId ?? void 0
    },
    transcript: {
      mode: subtitleDocument.transcript.mode,
      language: subtitleDocument.transcript.language,
      modelName: subtitleDocument.transcript.modelName,
      text: subtitleDocument.transcript.text,
      segments: transcriptSegments
    },
    article: {
      capturedAt: articleSnapshot2.capturedAt,
      title: articleSnapshot2.title,
      articleUrl: articleSnapshot2.articleUrl,
      paragraphs: articleParagraphs
    },
    sync: alignmentResult.syncEntries
  };
  return {
    manifest: manifest2,
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

// src/shared/subtitle-parser.ts
var ASS_TAG_PATTERN = /\{[^}]*\}/g;
var HTML_TAG_PATTERN = /<[^>]+>/g;
var SPEAKER_PREFIX_PATTERN2 = /^[A-Za-z][A-Za-z' .-]{0,40}:\s*/;
var MULTISPACE_PATTERN2 = /\s+/g;
var CJK_PATTERN = /[\u3400-\u9fff]/;
var LATIN_PATTERN = /[A-Za-z]/g;
function detectTextEncoding(bytes) {
  if (bytes.length >= 2) {
    if (bytes[0] === 255 && bytes[1] === 254) {
      return "utf-16le";
    }
    if (bytes[0] === 254 && bytes[1] === 255) {
      return "utf-16be";
    }
  }
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) {
    return "utf-8";
  }
  let nullByteCount = 0;
  for (const value of bytes) {
    if (value === 0) {
      nullByteCount += 1;
    }
  }
  return nullByteCount > bytes.length * 0.15 ? "utf-16le" : "utf-8";
}
async function readTextFile(file) {
  const buffer = new Uint8Array(await file.arrayBuffer());
  return new TextDecoder(detectTextEncoding(buffer), { fatal: false }).decode(buffer);
}
function normalizeWhitespace(value) {
  return value.replace(/\r/g, "").replace(/\uFEFF/g, "").replace(MULTISPACE_PATTERN2, " ").trim();
}
function stripSpeakerPrefix(value) {
  return value.replace(SPEAKER_PREFIX_PATTERN2, "").trim();
}
function scoreEnglishLikelihood(value) {
  const normalized = value.trim();
  if (!normalized) {
    return -100;
  }
  const latinCount = (normalized.match(LATIN_PATTERN) ?? []).length;
  const cjkCount = (normalized.match(CJK_PATTERN) ?? []).length;
  const asciiCount = Array.from(normalized).filter((character) => character.charCodeAt(0) <= 127).length;
  return latinCount * 3 + asciiCount - cjkCount * 4;
}
function pickPrimaryAndTranslation(rawLines) {
  const cleanedLines = rawLines.map((line) => normalizeWhitespace(stripSpeakerPrefix(line))).filter(Boolean);
  if (cleanedLines.length === 0) {
    return { text: "" };
  }
  if (cleanedLines.length === 1) {
    return { text: cleanedLines[0] };
  }
  const rankedLines = cleanedLines.map((line) => ({ line, score: scoreEnglishLikelihood(line) })).sort((left, right) => right.score - left.score);
  const primary = rankedLines[0]?.line ?? cleanedLines[0];
  const translation = cleanedLines.find((line) => line !== primary);
  return {
    text: primary,
    translation
  };
}
function toTranscriptSegments(lines) {
  const segments = lines.map((line, index) => ({
    index: index + 1,
    startMs: line.startMs,
    endMs: Math.max(line.endMs, line.startMs + 1),
    text: line.text
  })).filter((segment) => segment.text.length > 0 && segment.endMs > segment.startMs);
  return segments.map((segment, index) => ({
    ...segment,
    index: index + 1
  }));
}
function normalizeSubtitleText(value) {
  return value.replace(/\r/g, "").replace(/\uFEFF/g, "").replace(ASS_TAG_PATTERN, "").replace(HTML_TAG_PATTERN, "").replace(/\\N/gi, "\n").replace(/\\n/gi, "\n").replace(/\\h/gi, " ");
}
function parseAssTimestamp(value) {
  const match = value.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$/);
  if (!match) {
    throw new Error(`\u65E0\u6548\u7684 ASS \u65F6\u95F4\u6233: ${value}`);
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  const fractionRaw = match[4];
  const milliseconds = fractionRaw.length === 1 ? Number.parseInt(fractionRaw, 10) * 100 : fractionRaw.length === 2 ? Number.parseInt(fractionRaw, 10) * 10 : Number.parseInt(fractionRaw.slice(0, 3), 10);
  return (hours * 60 + minutes) * 60 * 1e3 + seconds * 1e3 + milliseconds;
}
function parseAssDialogue(text) {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalizedText.split("\n");
  let inEventsSection = false;
  let eventFormat = [];
  let title;
  const parsedLines = [];
  let translationCount = 0;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("[")) {
      inEventsSection = line.toLowerCase() === "[events]";
      continue;
    }
    if (/^title:/i.test(line)) {
      title = normalizeWhitespace(line.slice(line.indexOf(":") + 1));
      continue;
    }
    if (!inEventsSection) {
      continue;
    }
    if (/^format:/i.test(line)) {
      eventFormat = line.slice(line.indexOf(":") + 1).split(",").map((value) => value.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue:/i.test(line)) {
      continue;
    }
    if (eventFormat.length === 0) {
      throw new Error("ASS \u6587\u4EF6\u7F3A\u5C11 [Events] Format \u5B9A\u4E49\u3002");
    }
    const rawFields = line.slice(line.indexOf(":") + 1).split(",");
    if (rawFields.length < eventFormat.length) {
      continue;
    }
    const fields = rawFields.slice(0, eventFormat.length - 1);
    fields.push(rawFields.slice(eventFormat.length - 1).join(","));
    const startIndex = eventFormat.indexOf("start");
    const endIndex = eventFormat.indexOf("end");
    const textIndex = eventFormat.indexOf("text");
    if (startIndex === -1 || endIndex === -1 || textIndex === -1) {
      throw new Error("ASS Events Format \u7F3A\u5C11 start/end/text \u5B57\u6BB5\u3002");
    }
    const normalizedDialogue = normalizeSubtitleText(fields[textIndex] ?? "");
    const { text: primaryText, translation } = pickPrimaryAndTranslation(normalizedDialogue.split("\n"));
    if (!primaryText) {
      continue;
    }
    if (translation) {
      translationCount += 1;
    }
    parsedLines.push({
      startMs: parseAssTimestamp(fields[startIndex] ?? ""),
      endMs: parseAssTimestamp(fields[endIndex] ?? ""),
      text: primaryText,
      translation
    });
  }
  return {
    title,
    segmentCount: parsedLines.length,
    translationCount,
    lines: parsedLines
  };
}
function parseSrtTimestamp(value) {
  const match = value.trim().match(/^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) {
    throw new Error(`\u65E0\u6548\u7684 SRT/VTT \u65F6\u95F4\u6233: ${value}`);
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  const milliseconds = Number.parseInt(match[4], 10);
  return (hours * 60 + minutes) * 60 * 1e3 + seconds * 1e3 + milliseconds;
}
function parseSimpleTimedSubtitle(text, format) {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\uFEFF/g, "");
  const blocks = normalizedText.split(/\n{2,}/);
  const parsedLines = [];
  let translationCount = 0;
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0 || format === "vtt" && lines[0] === "WEBVTT") {
      continue;
    }
    const timingLineIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingLineIndex === -1) {
      continue;
    }
    const [startRaw, endRaw] = lines[timingLineIndex].split("-->").map((value) => value.trim().split(/\s+/)[0] ?? "");
    const textLines = lines.slice(timingLineIndex + 1).map((line) => normalizeSubtitleText(line));
    const { text: primaryText, translation } = pickPrimaryAndTranslation(textLines);
    if (!primaryText) {
      continue;
    }
    if (translation) {
      translationCount += 1;
    }
    parsedLines.push({
      startMs: parseSrtTimestamp(startRaw),
      endMs: parseSrtTimestamp(endRaw),
      text: primaryText,
      translation
    });
  }
  return {
    segmentCount: parsedLines.length,
    translationCount,
    lines: parsedLines
  };
}
function buildParsedDocument(fileName, format, metadata, lines) {
  const segments = toTranscriptSegments(lines);
  if (segments.length === 0) {
    throw new Error("\u5B57\u5E55\u6587\u4EF6\u91CC\u6CA1\u6709\u53EF\u7528\u5BF9\u767D\u6BB5\u3002");
  }
  return {
    fileName,
    format,
    transcript: {
      mode: `subtitle-${format}`,
      language: "en",
      modelName: format === "ass" ? "sidecar-ass-subtitle" : "sidecar-subtitle",
      text: segments.map((segment) => segment.text).join(" ").trim(),
      segments
    },
    metadata: {
      ...metadata,
      segmentCount: segments.length
    }
  };
}
async function parseSubtitleFile(file) {
  const text = await readTextFile(file);
  const fileName = file.name;
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  if (extension === "ass" || extension === "ssa") {
    const parsed = parseAssDialogue(text);
    return buildParsedDocument(fileName, "ass", parsed, parsed.lines);
  }
  if (extension === "srt") {
    const parsed = parseSimpleTimedSubtitle(text, "srt");
    return buildParsedDocument(fileName, "srt", parsed, parsed.lines);
  }
  if (extension === "vtt") {
    const parsed = parseSimpleTimedSubtitle(text, "vtt");
    return buildParsedDocument(fileName, "vtt", parsed, parsed.lines);
  }
  throw new Error(`\u5F53\u524D\u8FD8\u4E0D\u652F\u6301\u8BE5\u5B57\u5E55\u683C\u5F0F: ${extension || "unknown"}`);
}

// node_modules/@ffmpeg/ffmpeg/dist/esm/const.js
var CORE_VERSION = "0.12.9";
var CORE_URL = `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/umd/ffmpeg-core.js`;
var FFMessageType;
(function(FFMessageType2) {
  FFMessageType2["LOAD"] = "LOAD";
  FFMessageType2["EXEC"] = "EXEC";
  FFMessageType2["FFPROBE"] = "FFPROBE";
  FFMessageType2["WRITE_FILE"] = "WRITE_FILE";
  FFMessageType2["READ_FILE"] = "READ_FILE";
  FFMessageType2["DELETE_FILE"] = "DELETE_FILE";
  FFMessageType2["RENAME"] = "RENAME";
  FFMessageType2["CREATE_DIR"] = "CREATE_DIR";
  FFMessageType2["LIST_DIR"] = "LIST_DIR";
  FFMessageType2["DELETE_DIR"] = "DELETE_DIR";
  FFMessageType2["ERROR"] = "ERROR";
  FFMessageType2["DOWNLOAD"] = "DOWNLOAD";
  FFMessageType2["PROGRESS"] = "PROGRESS";
  FFMessageType2["LOG"] = "LOG";
  FFMessageType2["MOUNT"] = "MOUNT";
  FFMessageType2["UNMOUNT"] = "UNMOUNT";
})(FFMessageType || (FFMessageType = {}));

// node_modules/@ffmpeg/ffmpeg/dist/esm/utils.js
var getMessageID = /* @__PURE__ */ (() => {
  let messageID = 0;
  return () => messageID++;
})();

// node_modules/@ffmpeg/ffmpeg/dist/esm/errors.js
var ERROR_UNKNOWN_MESSAGE_TYPE = new Error("unknown message type");
var ERROR_NOT_LOADED = new Error("ffmpeg is not loaded, call `await ffmpeg.load()` first");
var ERROR_TERMINATED = new Error("called FFmpeg.terminate()");
var ERROR_IMPORT_FAILURE = new Error("failed to import ffmpeg-core.js");

// node_modules/@ffmpeg/ffmpeg/dist/esm/classes.js
var FFmpeg = class {
  #worker = null;
  /**
   * #resolves and #rejects tracks Promise resolves and rejects to
   * be called when we receive message from web worker.
   */
  #resolves = {};
  #rejects = {};
  #logEventCallbacks = [];
  #progressEventCallbacks = [];
  loaded = false;
  /**
   * register worker message event handlers.
   */
  #registerHandlers = () => {
    if (this.#worker) {
      this.#worker.onmessage = ({ data: { id, type, data } }) => {
        switch (type) {
          case FFMessageType.LOAD:
            this.loaded = true;
            this.#resolves[id](data);
            break;
          case FFMessageType.MOUNT:
          case FFMessageType.UNMOUNT:
          case FFMessageType.EXEC:
          case FFMessageType.FFPROBE:
          case FFMessageType.WRITE_FILE:
          case FFMessageType.READ_FILE:
          case FFMessageType.DELETE_FILE:
          case FFMessageType.RENAME:
          case FFMessageType.CREATE_DIR:
          case FFMessageType.LIST_DIR:
          case FFMessageType.DELETE_DIR:
            this.#resolves[id](data);
            break;
          case FFMessageType.LOG:
            this.#logEventCallbacks.forEach((f) => f(data));
            break;
          case FFMessageType.PROGRESS:
            this.#progressEventCallbacks.forEach((f) => f(data));
            break;
          case FFMessageType.ERROR:
            this.#rejects[id](data);
            break;
        }
        delete this.#resolves[id];
        delete this.#rejects[id];
      };
    }
  };
  /**
   * Generic function to send messages to web worker.
   */
  #send = ({ type, data }, trans = [], signal) => {
    if (!this.#worker) {
      return Promise.reject(ERROR_NOT_LOADED);
    }
    return new Promise((resolve, reject) => {
      const id = getMessageID();
      this.#worker && this.#worker.postMessage({ id, type, data }, trans);
      this.#resolves[id] = resolve;
      this.#rejects[id] = reject;
      signal?.addEventListener("abort", () => {
        reject(new DOMException(`Message # ${id} was aborted`, "AbortError"));
      }, { once: true });
    });
  };
  on(event, callback) {
    if (event === "log") {
      this.#logEventCallbacks.push(callback);
    } else if (event === "progress") {
      this.#progressEventCallbacks.push(callback);
    }
  }
  off(event, callback) {
    if (event === "log") {
      this.#logEventCallbacks = this.#logEventCallbacks.filter((f) => f !== callback);
    } else if (event === "progress") {
      this.#progressEventCallbacks = this.#progressEventCallbacks.filter((f) => f !== callback);
    }
  }
  /**
   * Loads ffmpeg-core inside web worker. It is required to call this method first
   * as it initializes WebAssembly and other essential variables.
   *
   * @category FFmpeg
   * @returns `true` if ffmpeg core is loaded for the first time.
   */
  load = ({ classWorkerURL, ...config } = {}, { signal } = {}) => {
    if (!this.#worker) {
      this.#worker = classWorkerURL ? new Worker(new URL(classWorkerURL, import.meta.url), {
        type: "module"
      }) : (
        // We need to duplicated the code here to enable webpack
        // to bundle worekr.js here.
        new Worker(new URL("./worker.js", import.meta.url), {
          type: "module"
        })
      );
      this.#registerHandlers();
    }
    return this.#send({
      type: FFMessageType.LOAD,
      data: config
    }, void 0, signal);
  };
  /**
   * Execute ffmpeg command.
   *
   * @remarks
   * To avoid common I/O issues, ["-nostdin", "-y"] are prepended to the args
   * by default.
   *
   * @example
   * ```ts
   * const ffmpeg = new FFmpeg();
   * await ffmpeg.load();
   * await ffmpeg.writeFile("video.avi", ...);
   * // ffmpeg -i video.avi video.mp4
   * await ffmpeg.exec(["-i", "video.avi", "video.mp4"]);
   * const data = ffmpeg.readFile("video.mp4");
   * ```
   *
   * @returns `0` if no error, `!= 0` if timeout (1) or error.
   * @category FFmpeg
   */
  exec = (args, timeout = -1, { signal } = {}) => this.#send({
    type: FFMessageType.EXEC,
    data: { args, timeout }
  }, void 0, signal);
  /**
   * Execute ffprobe command.
   *
   * @example
   * ```ts
   * const ffmpeg = new FFmpeg();
   * await ffmpeg.load();
   * await ffmpeg.writeFile("video.avi", ...);
   * // Getting duration of a video in seconds: ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 video.avi -o output.txt
   * await ffmpeg.ffprobe(["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", "video.avi", "-o", "output.txt"]);
   * const data = ffmpeg.readFile("output.txt");
   * ```
   *
   * @returns `0` if no error, `!= 0` if timeout (1) or error.
   * @category FFmpeg
   */
  ffprobe = (args, timeout = -1, { signal } = {}) => this.#send({
    type: FFMessageType.FFPROBE,
    data: { args, timeout }
  }, void 0, signal);
  /**
   * Terminate all ongoing API calls and terminate web worker.
   * `FFmpeg.load()` must be called again before calling any other APIs.
   *
   * @category FFmpeg
   */
  terminate = () => {
    const ids = Object.keys(this.#rejects);
    for (const id of ids) {
      this.#rejects[id](ERROR_TERMINATED);
      delete this.#rejects[id];
      delete this.#resolves[id];
    }
    if (this.#worker) {
      this.#worker.terminate();
      this.#worker = null;
      this.loaded = false;
    }
  };
  /**
   * Write data to ffmpeg.wasm.
   *
   * @example
   * ```ts
   * const ffmpeg = new FFmpeg();
   * await ffmpeg.load();
   * await ffmpeg.writeFile("video.avi", await fetchFile("../video.avi"));
   * await ffmpeg.writeFile("text.txt", "hello world");
   * ```
   *
   * @category File System
   */
  writeFile = (path, data, { signal } = {}) => {
    const trans = [];
    if (data instanceof Uint8Array) {
      trans.push(data.buffer);
    }
    return this.#send({
      type: FFMessageType.WRITE_FILE,
      data: { path, data }
    }, trans, signal);
  };
  mount = (fsType, options, mountPoint) => {
    const trans = [];
    return this.#send({
      type: FFMessageType.MOUNT,
      data: { fsType, options, mountPoint }
    }, trans);
  };
  unmount = (mountPoint) => {
    const trans = [];
    return this.#send({
      type: FFMessageType.UNMOUNT,
      data: { mountPoint }
    }, trans);
  };
  /**
   * Read data from ffmpeg.wasm.
   *
   * @example
   * ```ts
   * const ffmpeg = new FFmpeg();
   * await ffmpeg.load();
   * const data = await ffmpeg.readFile("video.mp4");
   * ```
   *
   * @category File System
   */
  readFile = (path, encoding = "binary", { signal } = {}) => this.#send({
    type: FFMessageType.READ_FILE,
    data: { path, encoding }
  }, void 0, signal);
  /**
   * Delete a file.
   *
   * @category File System
   */
  deleteFile = (path, { signal } = {}) => this.#send({
    type: FFMessageType.DELETE_FILE,
    data: { path }
  }, void 0, signal);
  /**
   * Rename a file or directory.
   *
   * @category File System
   */
  rename = (oldPath, newPath, { signal } = {}) => this.#send({
    type: FFMessageType.RENAME,
    data: { oldPath, newPath }
  }, void 0, signal);
  /**
   * Create a directory.
   *
   * @category File System
   */
  createDir = (path, { signal } = {}) => this.#send({
    type: FFMessageType.CREATE_DIR,
    data: { path }
  }, void 0, signal);
  /**
   * List directory contents.
   *
   * @category File System
   */
  listDir = (path, { signal } = {}) => this.#send({
    type: FFMessageType.LIST_DIR,
    data: { path }
  }, void 0, signal);
  /**
   * Delete an empty directory.
   *
   * @category File System
   */
  deleteDir = (path, { signal } = {}) => this.#send({
    type: FFMessageType.DELETE_DIR,
    data: { path }
  }, void 0, signal);
};

// node_modules/@ffmpeg/ffmpeg/dist/esm/types.js
var FFFSType;
(function(FFFSType2) {
  FFFSType2["MEMFS"] = "MEMFS";
  FFFSType2["NODEFS"] = "NODEFS";
  FFFSType2["NODERAWFS"] = "NODERAWFS";
  FFFSType2["IDBFS"] = "IDBFS";
  FFFSType2["WORKERFS"] = "WORKERFS";
  FFFSType2["PROXYFS"] = "PROXYFS";
})(FFFSType || (FFFSType = {}));

// node_modules/@ffmpeg/util/dist/esm/errors.js
var ERROR_RESPONSE_BODY_READER = new Error("failed to get response body reader");
var ERROR_INCOMPLETED_DOWNLOAD = new Error("failed to complete download");

// node_modules/@ffmpeg/util/dist/esm/index.js
var readFromBlobOrFile = (blob) => new Promise((resolve, reject) => {
  const fileReader = new FileReader();
  fileReader.onload = () => {
    const { result } = fileReader;
    if (result instanceof ArrayBuffer) {
      resolve(new Uint8Array(result));
    } else {
      resolve(new Uint8Array());
    }
  };
  fileReader.onerror = (event) => {
    reject(Error(`File could not be read! Code=${event?.target?.error?.code || -1}`));
  };
  fileReader.readAsArrayBuffer(blob);
});
var fetchFile = async (file) => {
  let data;
  if (typeof file === "string") {
    if (/data:_data\/([a-zA-Z]*);base64,([^"]*)/.test(file)) {
      data = atob(file.split(",")[1]).split("").map((c) => c.charCodeAt(0));
    } else {
      data = await (await fetch(file)).arrayBuffer();
    }
  } else if (file instanceof URL) {
    data = await (await fetch(file)).arrayBuffer();
  } else if (file instanceof File || file instanceof Blob) {
    data = await readFromBlobOrFile(file);
  } else {
    return new Uint8Array();
  }
  return new Uint8Array(data);
};

// src/player/media-compatibility.ts
var preferredContainerFormats = /* @__PURE__ */ new Set(["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]);
function buildOutputVideoName(fileName) {
  const lastDotIndex = fileName.lastIndexOf(".");
  const stem = lastDotIndex === -1 ? fileName : fileName.slice(0, lastDotIndex);
  return `${stem}.hvc1.aac.mp4`;
}
function buildMediaTranscodeStrategy(fileName, probe) {
  const resolvedContainerFormats = resolveContainerFormats(fileName, probe.containerFormats);
  const videoStream = probe.streams.find((stream) => stream.codecType === "video");
  const audioStreams = probe.streams.filter((stream) => stream.codecType === "audio");
  if (!videoStream) {
    throw new Error("\u8F93\u5165\u6587\u4EF6\u7F3A\u5C11\u89C6\u9891\u6D41\uFF0C\u65E0\u6CD5\u8FDB\u5165\u64AD\u653E\u5668\u3002");
  }
  const containerAction = isPreferredContainer(resolvedContainerFormats) ? "copy" : "remux";
  const videoAction = videoStream.codecName === "hevc" ? "copy" : "transcode";
  const audioAction = audioStreams.length === 0 || audioStreams.every((stream) => stream.codecName === "aac") ? "copy" : "transcode";
  return {
    containerAction,
    videoAction,
    audioAction,
    videoCodec: videoStream.codecName,
    audioCodecs: audioStreams.map((stream) => stream.codecName),
    outputFileName: buildOutputVideoName(fileName)
  };
}
function assessMediaCompatibility(fileName, probe) {
  const resolvedContainerFormats = resolveContainerFormats(fileName, probe.containerFormats);
  const strategy = buildMediaTranscodeStrategy(fileName, probe);
  const reasons = [];
  if (strategy.containerAction === "remux") {
    reasons.push(`\u5C01\u88C5\u683C\u5F0F\u4E3A ${formatContainerFormats(resolvedContainerFormats)}\uFF0C\u4E0D\u5728\u63A8\u8350\u7684 MP4/MOV \u57FA\u7EBF\u5185`);
  }
  if (strategy.videoAction === "transcode") {
    reasons.push(`\u89C6\u9891\u7F16\u7801\u4E3A ${strategy.videoCodec}\uFF0C\u4E0D\u662F\u76EE\u6807 HEVC(HVC1)`);
  }
  if (strategy.audioAction === "transcode") {
    reasons.push(`\u97F3\u9891\u7F16\u7801\u4E3A ${formatAudioCodecs(strategy.audioCodecs)}\uFF0C\u4E0D\u662F\u76EE\u6807 AAC`);
  }
  if (reasons.length === 0) {
    return {
      isRecommendedProfile: true,
      reasons,
      summary: "\u5DF2\u547D\u4E2D\u63A8\u8350\u64AD\u653E\u57FA\u7EBF\uFF0C\u5C06\u76F4\u63A5\u8FDB\u5165\u539F\u751F\u64AD\u653E\u5668\u3002",
      detail: `\u5C01\u88C5 ${formatContainerFormats(resolvedContainerFormats)}\uFF0C\u89C6\u9891 ${strategy.videoCodec}\uFF0C\u97F3\u9891 ${formatAudioCodecs(strategy.audioCodecs)}\u3002`
    };
  }
  return {
    isRecommendedProfile: false,
    reasons,
    summary: "\u5F53\u524D\u6587\u4EF6\u504F\u79BB\u63A8\u8350\u7684 HVC1 + AAC \u64AD\u653E\u57FA\u7EBF\uFF0C\u5EFA\u8BAE\u5148\u505A\u672C\u5730\u9884\u5904\u7406\u3002",
    detail: reasons.join("\uFF1B")
  };
}
function formatContainerFormats(containerFormats) {
  return containerFormats.length > 0 ? containerFormats.join(", ") : "unknown";
}
function formatAudioCodecs(audioCodecs) {
  return audioCodecs.length > 0 ? audioCodecs.join(", ") : "none";
}
function resolveContainerFormatsForDisplay(fileName, containerFormats) {
  return resolveContainerFormats(fileName, containerFormats);
}
function isPreferredContainer(containerFormats) {
  return containerFormats.some((format) => preferredContainerFormats.has(format));
}
function resolveContainerFormats(fileName, containerFormats) {
  if (containerFormats.length > 0) {
    return containerFormats;
  }
  const extension = fileName.split(".").pop()?.trim().toLowerCase() ?? "";
  switch (extension) {
    case "mkv":
      return ["matroska"];
    case "mp4":
    case "m4v":
      return ["mp4"];
    case "mov":
      return ["mov"];
    case "webm":
      return ["webm"];
    case "avi":
      return ["avi"];
    default:
      return containerFormats;
  }
}

// src/player/browser-ffmpeg-service.ts
var ENCODING_PROFILE = Object.freeze({
  crf: "34",
  preset: "ultrafast",
  audioBitrate: "96k",
  pixelFormat: "yuv420p",
  maxWidth: "1280"
});
var LOCAL_CORE_ASSETS = Object.freeze({
  coreURL: {
    path: "vendor/ffmpeg/ffmpeg-core.js",
    mimeType: "text/javascript"
  },
  wasmURL: {
    path: "vendor/ffmpeg/ffmpeg-core.wasm",
    mimeType: "application/wasm"
  },
  classWorkerURL: {
    path: "vendor/ffmpeg-runtime/worker.js",
    mimeType: "text/javascript"
  }
});
var BrowserFfmpegService = class {
  ffmpeg = new FFmpeg();
  loaded = false;
  coreAssetUrls = null;
  recentLogs = [];
  activeHandlers = null;
  constructor() {
    this.ffmpeg.on("log", ({ message }) => {
      this.recentLogs.push(message);
      if (this.recentLogs.length > 60) {
        this.recentLogs.splice(0, this.recentLogs.length - 60);
      }
      this.activeHandlers?.onLog?.(message);
    });
    this.ffmpeg.on("progress", ({ progress, time }) => {
      this.activeHandlers?.onProgress?.({ progress, time });
    });
  }
  async inspectFile(file, handlers = {}) {
    await this.ensureLoaded(handlers);
    const jobKey = crypto.randomUUID();
    const inputPath = `${jobKey}-${sanitizeFileName(file.name)}`;
    const probeOutputPath = `${jobKey}-probe.null`;
    this.activeHandlers = handlers;
    this.recentLogs.length = 0;
    try {
      handlers.onStatusChange?.({
        phase: "writing-input",
        detail: { message: "\u6B63\u5728\u5199\u5165\u5F85\u68C0\u6D4B\u6587\u4EF6\u5230\u6D4F\u89C8\u5668\u672C\u5730\u5185\u5B58\u6587\u4EF6\u7CFB\u7EDF" }
      });
      await this.ffmpeg.writeFile(inputPath, await fetchFile(file));
      handlers.onStatusChange?.({
        phase: "probing",
        detail: { message: "\u6B63\u5728\u89E3\u6790\u5BB9\u5668\u3001\u89C6\u9891\u6D41\u548C\u97F3\u9891\u6D41\u4FE1\u606F" }
      });
      this.recentLogs.length = 0;
      const probe = await inspectMedia(this.ffmpeg, inputPath, probeOutputPath, this.recentLogs);
      return probe;
    } catch (error) {
      throw enrichWithRecentLogs(error, this.recentLogs);
    } finally {
      this.activeHandlers = null;
      await safeDelete(this.ffmpeg, inputPath);
      await safeDelete(this.ffmpeg, probeOutputPath);
    }
  }
  async transcodeFile(file, probe, handlers = {}) {
    await this.ensureLoaded(handlers);
    const strategy = buildMediaTranscodeStrategy(file.name, probe);
    const jobKey = crypto.randomUUID();
    const inputPath = `${jobKey}-${sanitizeFileName(file.name)}`;
    const outputPath = `${jobKey}-${strategy.outputFileName}`;
    this.activeHandlers = handlers;
    this.recentLogs.length = 0;
    try {
      handlers.onStatusChange?.({
        phase: "writing-input",
        detail: { message: "\u6B63\u5728\u5199\u5165\u5F85\u9884\u5904\u7406\u6587\u4EF6" }
      });
      await this.ffmpeg.writeFile(inputPath, await fetchFile(file));
      handlers.onStatusChange?.({
        phase: "transcoding",
        detail: {
          message: describeStrategy(strategy)
        }
      });
      const exitCode = await this.ffmpeg.exec(buildTranscodeCommand(inputPath, outputPath, strategy));
      if (exitCode !== 0) {
        throw new Error(buildCommandFailureMessage("FFmpeg", exitCode, this.recentLogs));
      }
      handlers.onStatusChange?.({
        phase: "finalizing-output",
        detail: { message: "FFmpeg \u5DF2\u5B8C\u6210\u7F16\u7801\uFF0C\u6B63\u5728\u5C01\u53E3 MP4 \u8F93\u51FA" }
      });
      await waitForLogFlush();
      handlers.onStatusChange?.({
        phase: "reading-output",
        detail: { message: "\u6B63\u5728\u8BFB\u53D6\u9884\u5904\u7406\u7ED3\u679C\u5E76\u751F\u6210\u53EF\u64AD\u653E\u6587\u4EF6" }
      });
      const outputData = await this.ffmpeg.readFile(outputPath);
      const outputBytes = normalizeBinaryFileData(outputData);
      if (outputBytes.byteLength === 0) {
        throw new Error("FFmpeg \u8F93\u51FA\u6587\u4EF6\u4E3A\u7A7A\uFF0C\u672A\u751F\u6210\u53EF\u64AD\u653E MP4\u3002");
      }
      const outputBlob = new Blob([copyBytesToArrayBuffer(outputBytes)], { type: "video/mp4" });
      const outputFile = new File([outputBlob], strategy.outputFileName, { type: "video/mp4" });
      handlers.onStatusChange?.({
        phase: "completed",
        detail: { message: `\u9884\u5904\u7406\u5B8C\u6210\uFF0C\u8F93\u51FA ${formatBytes(outputBytes.byteLength)}` }
      });
      return {
        file: outputFile,
        blob: outputBlob,
        strategy,
        probe
      };
    } catch (error) {
      throw enrichWithRecentLogs(error, this.recentLogs);
    } finally {
      this.activeHandlers = null;
      await safeDelete(this.ffmpeg, inputPath);
      await safeDelete(this.ffmpeg, outputPath);
    }
  }
  terminate() {
    this.ffmpeg.terminate();
    this.loaded = false;
    this.coreAssetUrls = null;
  }
  async ensureLoaded(handlers) {
    if (this.loaded) {
      handlers.onStatusChange?.({
        phase: "ready",
        detail: { message: "\u5185\u7F6E FFmpeg Core \u5DF2\u5C31\u7EEA" }
      });
      return;
    }
    handlers.onStatusChange?.({
      phase: "loading-core",
      detail: { message: "\u6B63\u5728\u88C5\u8F7D\u6269\u5C55\u5185\u7F6E FFmpeg Core" }
    });
    if (!this.coreAssetUrls) {
      this.coreAssetUrls = await loadLocalCoreAssetUrls();
    }
    await this.ffmpeg.load(this.coreAssetUrls);
    this.loaded = true;
    handlers.onStatusChange?.({
      phase: "ready",
      detail: { message: "\u5185\u7F6E FFmpeg Core \u88C5\u8F7D\u5B8C\u6210" }
    });
  }
};
function describeStrategy(strategy) {
  const videoStep = strategy.videoAction === "copy" ? `\u89C6\u9891\u76F4\u63A5\u590D\u7528(${strategy.videoCodec})` : `\u89C6\u9891\u8F6C HEVC(HVC1)`;
  const audioStep = strategy.audioAction === "copy" ? `\u97F3\u9891\u76F4\u63A5\u590D\u7528(${strategy.audioCodecs.length > 0 ? strategy.audioCodecs.join(", ") : "none"})` : `\u97F3\u9891\u8F6C AAC`;
  const containerStep = strategy.containerAction === "copy" ? "\u6CBF\u7528 MP4/MOV \u57FA\u7EBF" : "\u91CD\u5C01\u88C5\u4E3A MP4";
  return `${containerStep}\uFF1B${videoStep}\uFF1B${audioStep}`;
}
function buildTranscodeCommand(inputPath, outputPath, strategy) {
  const command = ["-i", inputPath, "-map", "0:v:0", "-map", "0:a?"];
  if (strategy.videoAction === "copy") {
    command.push("-c:v", "copy");
  } else {
    command.push(
      "-c:v",
      "libx265",
      "-preset",
      ENCODING_PROFILE.preset,
      "-crf",
      ENCODING_PROFILE.crf,
      "-vf",
      `scale='min(${ENCODING_PROFILE.maxWidth},iw)':-2`,
      "-pix_fmt",
      ENCODING_PROFILE.pixelFormat
    );
  }
  command.push("-tag:v", "hvc1");
  if (strategy.audioAction === "copy") {
    command.push("-c:a", "copy");
  } else {
    command.push("-c:a", "aac", "-ac", "2", "-b:a", ENCODING_PROFILE.audioBitrate);
  }
  command.push("-sn", "-dn", "-movflags", "+faststart", outputPath);
  return command;
}
async function inspectMedia(ffmpeg, inputPath, probeOutputPath, recentLogs) {
  const exitCode = await ffmpeg.exec([
    "-v",
    "info",
    "-i",
    inputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a?",
    "-c",
    "copy",
    "-t",
    "0.1",
    "-f",
    "null",
    probeOutputPath
  ]);
  if (exitCode !== 0) {
    throw new Error(buildCommandFailureMessage("probe(ffmpeg)", exitCode, recentLogs));
  }
  await waitForLogFlush();
  return parseProbeFromLogs(recentLogs);
}
function parseProbeFromLogs(logs) {
  const inputLine = logs.find((line) => line.startsWith("Input #0,"));
  const videoLines = logs.filter((line) => line.includes("Video:"));
  const audioLines = logs.filter((line) => line.includes("Audio:"));
  if (videoLines.length === 0) {
    throw new Error(`\u65E0\u6CD5\u4ECE FFmpeg \u65E5\u5FD7\u4E2D\u89E3\u6790\u89C6\u9891\u6D41\u4FE1\u606F\u3002
Recent logs:
${logs.slice(-20).join("\n")}`);
  }
  const containerFormats = inputLine?.match(/^Input #0,\s+(.+),\s+from\b/)?.[1]?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const streams = videoLines.map((line, index) => {
    const codecName = line.match(/Video:\s+([^\s,(]+)/)?.[1];
    const width = line.match(/(\d{2,5})x(\d{2,5})/);
    if (!codecName || !width) {
      throw new Error(`\u65E0\u6CD5\u4ECE FFmpeg \u65E5\u5FD7\u4E2D\u89E3\u6790\u89C6\u9891\u7F16\u7801\u8BE6\u60C5\u3002
Recent logs:
${logs.slice(-20).join("\n")}`);
    }
    return {
      codecType: "video",
      codecName,
      index,
      width: Number.parseInt(width[1], 10),
      height: Number.parseInt(width[2], 10)
    };
  });
  audioLines.forEach((line, index) => {
    const codecName = line.match(/Audio:\s+([^\s,(]+)/)?.[1];
    if (!codecName) {
      return;
    }
    streams.push({
      codecType: "audio",
      codecName,
      index
    });
  });
  return {
    containerFormats,
    streams
  };
}
async function loadLocalCoreAssetUrls() {
  const [coreResponse, wasmResponse, classWorkerResponse] = await Promise.all([
    fetch(chrome.runtime.getURL(LOCAL_CORE_ASSETS.coreURL.path), { cache: "force-cache" }),
    fetch(chrome.runtime.getURL(LOCAL_CORE_ASSETS.wasmURL.path), { cache: "force-cache" }),
    fetch(chrome.runtime.getURL(LOCAL_CORE_ASSETS.classWorkerURL.path), { cache: "force-cache" })
  ]);
  if (!coreResponse.ok) {
    throw new Error(`\u65E0\u6CD5\u52A0\u8F7D\u6269\u5C55\u5185\u7F6E FFmpeg Core \u8D44\u6E90\uFF1A${LOCAL_CORE_ASSETS.coreURL.path} (${coreResponse.status})`);
  }
  if (!wasmResponse.ok) {
    throw new Error(`\u65E0\u6CD5\u52A0\u8F7D\u6269\u5C55\u5185\u7F6E FFmpeg Core \u8D44\u6E90\uFF1A${LOCAL_CORE_ASSETS.wasmURL.path} (${wasmResponse.status})`);
  }
  if (!classWorkerResponse.ok) {
    throw new Error(
      `\u65E0\u6CD5\u52A0\u8F7D\u6269\u5C55\u5185\u7F6E FFmpeg Runtime Worker\uFF1A${LOCAL_CORE_ASSETS.classWorkerURL.path} (${classWorkerResponse.status})`
    );
  }
  return {
    coreURL: chrome.runtime.getURL(LOCAL_CORE_ASSETS.coreURL.path),
    wasmURL: chrome.runtime.getURL(LOCAL_CORE_ASSETS.wasmURL.path),
    classWorkerURL: chrome.runtime.getURL(LOCAL_CORE_ASSETS.classWorkerURL.path)
  };
}
async function safeDelete(ffmpeg, filePath) {
  try {
    await ffmpeg.deleteFile(filePath);
  } catch {
    return;
  }
}
function sanitizeFileName(fileName) {
  return fileName.replaceAll(/[^\w.-]+/g, "_");
}
function buildCommandFailureMessage(commandName, exitCode, logs) {
  const tail = logs.slice(-12).join("\n");
  return `${commandName} exited with code ${exitCode}${tail ? `
Recent logs:
${tail}` : ""}`;
}
function normalizeBinaryFileData(outputData) {
  return outputData instanceof Uint8Array ? outputData : new TextEncoder().encode(outputData);
}
function copyBytesToArrayBuffer(bytes) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
function formatBytes(byteLength) {
  if (byteLength < 1024) {
    return `${byteLength} B`;
  }
  if (byteLength < 1024 * 1024) {
    return `${(byteLength / 1024).toFixed(1)} KiB`;
  }
  if (byteLength < 1024 * 1024 * 1024) {
    return `${(byteLength / 1024 / 1024).toFixed(1)} MiB`;
  }
  return `${(byteLength / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}
function enrichWithRecentLogs(error, recentLogs) {
  if (error instanceof Error && !error.message.includes("Recent logs:")) {
    return new Error(`${error.message}
Recent logs:
${recentLogs.slice(-12).join("\n")}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}
function waitForLogFlush() {
  return new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
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

// src/player/player.ts
var logger = createLogger("player");
var supportedSubtitleExtensions = /* @__PURE__ */ new Set(["ass", "ssa", "srt", "vtt"]);
var supportedVideoExtensions = /* @__PURE__ */ new Set(["mp4", "mkv"]);
var themeModeOrder = ["auto", "light", "dark"];
function requireElement(selector) {
  const element = document.querySelector(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}
var elements = {
  themeToggle: requireElement("#theme-toggle"),
  readerStatusPill: requireElement("#reader-status-pill"),
  readerStatusText: requireElement("#reader-status-text"),
  readerContextValue: requireElement("#reader-context-value"),
  subtitleView: requireElement("#subtitle-view"),
  videoView: requireElement("#video-view"),
  playerView: requireElement("#player-view"),
  steps: Array.from(document.querySelectorAll(".step")),
  localSubtitleChoice: requireElement('[data-subtitle-choice="local"]'),
  onlineSubtitleChoice: requireElement('[data-subtitle-choice="online"]'),
  subtitleDrop: requireElement("#subtitle-drop"),
  subtitleFile: requireElement("#subtitle-file"),
  localSubtitleState: requireElement("#local-subtitle-state"),
  subtitleFileState: requireElement("#subtitle-file-state"),
  subtitleResultTitle: requireElement("#subtitle-result-title"),
  subtitleResultDetail: requireElement("#subtitle-result-detail"),
  toVideo: requireElement("#to-video"),
  backSubtitle: requireElement("#back-subtitle"),
  videoSubtitleChip: requireElement("#video-subtitle-chip"),
  videoDrop: requireElement("#video-drop"),
  videoFile: requireElement("#video-file"),
  videoDropTitle: requireElement("#video-drop-title"),
  videoDropDesc: requireElement("#video-drop-desc"),
  videoName: requireElement("#video-name"),
  videoContainer: requireElement("#video-container"),
  videoCodec: requireElement("#video-codec"),
  audioCodec: requireElement("#audio-codec"),
  videoPlan: requireElement("#video-plan"),
  processingBox: requireElement("#processing-box"),
  processingProgress: requireElement("#processing-progress"),
  processingText: requireElement("#processing-text"),
  riskPlay: requireElement("#risk-play"),
  processPlay: requireElement("#process-play"),
  playerWrap: requireElement("#player-wrap"),
  changeEpisode: requireElement("#change-episode"),
  playerNote: requireElement("#player-note"),
  video: requireElement("#video"),
  playToggle: requireElement("#play-toggle"),
  timeReadout: requireElement("#time-readout"),
  playbackRateTrigger: requireElement("#playback-rate-trigger"),
  playbackRateValue: requireElement("#playback-rate-value"),
  playbackRateOptions: requireElement("#playback-rate-options"),
  playbackRateOptionButtons: Array.from(document.querySelectorAll(".rate-option")),
  expandToggle: requireElement("#expand-toggle"),
  pipToggle: requireElement("#pip-toggle"),
  playerStatus: requireElement("#player-status"),
  playerVideoPill: requireElement("#player-video-pill"),
  playerSubtitlePill: requireElement("#player-subtitle-pill"),
  playerReaderPill: requireElement("#player-reader-pill"),
  riskDialog: requireElement("#risk-dialog"),
  cancelRisk: requireElement("#cancel-risk"),
  confirmRisk: requireElement("#confirm-risk")
};
var browserFfmpegService = new BrowserFfmpegService();
var playerPort = null;
var playerPortReconnectTimer = null;
var playerPageUnloading = false;
var connectedTabs = [];
var activePageTabId = null;
var pageContext = null;
var articleSnapshot = null;
var articleSnapshotError = null;
var subtitleIndex = [];
var subtitleIndexLoaded = false;
var selectedSubtitleMode = "local";
var localSubtitleMatch = null;
var loadedSubtitleDocument = null;
var currentRuntimeBuild = null;
var runtimeBuildInFlight = false;
var runtimeBuildFingerprint = null;
var runtimeBuildRequestedFingerprint = null;
var runtimeBuildFailedFingerprint = null;
var runtimeBuildToken = 0;
var articleSnapshotRequestIssuedAt = null;
var articleSnapshotLastRequestedAt = 0;
var manifest = null;
var transcriptSegmentsByIndex = /* @__PURE__ */ new Map();
var articleParagraphsByIndex = /* @__PURE__ */ new Map();
var sourceVideoFile = null;
var sourceVideoProbe = null;
var sourceVideoAssessment = null;
var sourceVideoStrategy = null;
var sourceVideoInspectionError = null;
var videoObjectUrl = null;
var processedVideoFile = null;
var processedVideoObjectUrl = null;
var currentVideoVariant = null;
var videoInspectionBusy = false;
var videoTranscodeBusy = false;
var videoInspectionToken = 0;
var lastBroadcastAt = 0;
var playerThemeMode = "auto";
var themeMediaQuery = null;
var compactLayoutRaf = null;
function clearPlayerPortReconnectTimer() {
  if (playerPortReconnectTimer !== null) {
    window.clearTimeout(playerPortReconnectTimer);
    playerPortReconnectTimer = null;
  }
}
function schedulePlayerPortReconnect(delayMs = 280) {
  if (playerPortReconnectTimer !== null) {
    return;
  }
  playerPortReconnectTimer = window.setTimeout(() => {
    playerPortReconnectTimer = null;
    connectPlayerPort();
  }, delayMs);
}
function connectPlayerPort() {
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
function resolvePlayerTheme(mode) {
  const prefersDark = themeMediaQuery?.matches ?? window.matchMedia("(prefers-color-scheme: dark)").matches;
  return resolveReaderSyncThemeMode(mode, prefersDark);
}
function applyPlayerThemeMode(mode) {
  playerThemeMode = mode;
  const resolvedTheme = resolvePlayerTheme(mode);
  document.documentElement.dataset.theme = resolvedTheme;
  document.documentElement.dataset.themeMode = mode;
  elements.themeToggle.textContent = mode === "auto" ? "\u81EA" : mode === "light" ? "\u65E5" : "\u591C";
  const label = mode === "auto" ? "\u5F53\u524D\u8DDF\u968F\u6D4F\u89C8\u5668\uFF0C\u70B9\u51FB\u5207\u6362\u5230\u65E5\u95F4\u4E3B\u9898" : mode === "light" ? "\u5F53\u524D\u65E5\u95F4\u4E3B\u9898\uFF0C\u70B9\u51FB\u5207\u6362\u5230\u591C\u95F4\u4E3B\u9898" : "\u5F53\u524D\u591C\u95F4\u4E3B\u9898\uFF0C\u70B9\u51FB\u5207\u6362\u5230\u81EA\u52A8\u4E3B\u9898";
  elements.themeToggle.setAttribute("aria-label", label);
  elements.themeToggle.title = label;
}
async function loadPlayerTheme() {
  themeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
  themeMediaQuery.addEventListener("change", () => {
    if (playerThemeMode === "auto") {
      applyPlayerThemeMode("auto");
    }
  });
  const stored = await chrome.storage.local.get(playerThemeStorageKey);
  applyPlayerThemeMode(sanitizeReaderSyncThemeMode(stored[playerThemeStorageKey]));
}
async function cyclePlayerThemeMode() {
  const currentIndex = themeModeOrder.indexOf(playerThemeMode);
  const nextThemeMode = themeModeOrder[(currentIndex + 1) % themeModeOrder.length] ?? "auto";
  applyPlayerThemeMode(nextThemeMode);
  await chrome.storage.local.set({ [playerThemeStorageKey]: nextThemeMode });
}
function postRuntimeMessage(message) {
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
function setView(stepName) {
  const views = {
    subtitle: elements.subtitleView,
    video: elements.videoView,
    player: elements.playerView
  };
  const order = ["subtitle", "video", "player"];
  const activeIndex = order.indexOf(stepName);
  for (const [name, element] of Object.entries(views)) {
    element.classList.toggle("is-active", name === stepName);
  }
  elements.steps.forEach((step, index) => {
    step.classList.toggle("is-active", index === activeIndex);
    step.classList.toggle("is-done", index < activeIndex);
    const numberElement = step.querySelector(".step-num");
    if (numberElement) {
      numberElement.textContent = index < activeIndex ? "\u2713" : String(index + 1);
    }
  });
  scheduleCompactLayoutCheck();
}
function formatPlaybackRate(rate) {
  return `${Number.isInteger(rate) ? rate.toFixed(1) : String(rate)}x`;
}
function setPlaybackRate(rate) {
  const normalizedRate = clamp(rate, 0.5, 2);
  elements.video.playbackRate = normalizedRate;
  elements.playbackRateValue.textContent = formatPlaybackRate(normalizedRate);
  for (const option of elements.playbackRateOptionButtons) {
    const optionRate = Number(option.dataset.rate);
    const active = Math.abs(optionRate - normalizedRate) < 1e-3;
    option.classList.toggle("is-active", active);
    option.setAttribute("aria-selected", active ? "true" : "false");
  }
}
function setRateMenuOpen(open) {
  elements.playbackRateOptions.classList.toggle("is-open", open);
  elements.playbackRateTrigger.setAttribute("aria-expanded", open ? "true" : "false");
}
function resolveViewportWidth() {
  return Math.min(window.innerWidth, window.visualViewport?.width ?? window.innerWidth);
}
function updateCompactLayoutMode() {
  compactLayoutRaf = null;
  const viewportWidth = resolveViewportWidth();
  const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
  const portraitLike = viewportWidth > 0 && viewportHeight > viewportWidth;
  const contentOverflow = document.documentElement.scrollWidth > Math.ceil(document.documentElement.clientWidth + 1);
  document.body.classList.toggle("layout-compact", viewportWidth <= 920 || portraitLike || contentOverflow);
}
function scheduleCompactLayoutCheck() {
  if (compactLayoutRaf !== null) {
    return;
  }
  compactLayoutRaf = window.requestAnimationFrame(updateCompactLayoutMode);
}
function fileExtension(fileName) {
  const extension = fileName.split(".").pop()?.trim().toLowerCase() ?? "";
  return extension;
}
function normalizeTextToken(value) {
  return value.toLowerCase().replace(/&/g, " and ").replace(/\b(the|one|with|where|after|and|part|friends|episode|season)\b/g, " ").replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}
function extractEpisodeToken(value) {
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
function scoreTitleSimilarity(left, right) {
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
async function loadSubtitleIndex() {
  if (subtitleIndexLoaded) {
    return;
  }
  const response = await fetch(chrome.runtime.getURL("resources/subtitles-index.json"));
  if (!response.ok) {
    throw new Error(`\u672C\u5730\u5B57\u5E55\u7D22\u5F15\u52A0\u8F7D\u5931\u8D25 (${response.status})`);
  }
  const payload = await response.json();
  subtitleIndex = Array.isArray(payload.subtitles) ? payload.subtitles : [];
  subtitleIndexLoaded = true;
}
function resolveLocalSubtitleMatch() {
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
  let best = null;
  for (const entry of subtitleIndex) {
    const score = Math.max(scoreTitleSimilarity(combined, entry.title), scoreTitleSimilarity(pageContext?.title ?? "", entry.title));
    if (!best || score > best.score) {
      best = { entry, score };
    }
  }
  return best && best.score >= 0.42 ? best.entry : null;
}
function currentReaderBlockReason() {
  if (connectedTabs.length === 0 && !pageContext) {
    return "\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A aim-read \u9605\u8BFB\u9875\u3002";
  }
  if (connectedTabs.length > 1) {
    return `\u68C0\u6D4B\u5230 ${connectedTabs.length} \u4E2A reader \u9875\u9762\uFF0C\u8BF7\u53EA\u4FDD\u7559\u4E00\u4E2A\u3002`;
  }
  if (articleSnapshotError) {
    return `\u5168\u6587\u83B7\u53D6\u5931\u8D25\uFF1A${articleSnapshotError}`;
  }
  return null;
}
function updateReaderUi() {
  const blockReason = currentReaderBlockReason();
  elements.readerStatusPill.classList.toggle("is-blocked", blockReason !== null);
  if (blockReason) {
    elements.readerStatusText.textContent = blockReason;
  } else if (pageContext) {
    elements.readerStatusText.textContent = `\u5DF2\u68C0\u6D4B\u5230 reader \u9875\u9762\uFF1A${pageContext.title || pageContext.articleUrl}`;
  } else {
    elements.readerStatusText.textContent = "\u6B63\u5728\u68C0\u6D4B reader \u9875\u9762\u2026";
  }
  const title = pageContext?.title ?? articleSnapshot?.title ?? "\u7B49\u5F85 reader \u9875\u9762";
  const paragraphCount = articleSnapshot?.paragraphs.length ?? pageContext?.paragraphs.length ?? 0;
  elements.readerContextValue.textContent = paragraphCount > 0 ? `${title} \xB7 ${paragraphCount} \u6BB5\u6B63\u6587` : title;
  elements.playerReaderPill.textContent = pageContext ? `reader\uFF1A${pageContext.title || "\u5DF2\u7ED1\u5B9A"}` : "reader\uFF1A\u7B49\u5F85\u7ED1\u5B9A";
}
function updateSubtitleChoiceUi() {
  elements.localSubtitleChoice.classList.toggle("is-selected", selectedSubtitleMode === "local");
  elements.subtitleDrop.classList.toggle("is-selected", selectedSubtitleMode === "manual");
  elements.onlineSubtitleChoice.classList.remove("is-selected");
  if (selectedSubtitleMode === "local") {
    if (localSubtitleMatch) {
      elements.localSubtitleState.textContent = `\u5DF2\u5339\u914D\uFF1A${localSubtitleMatch.fileName}`;
      elements.subtitleResultTitle.textContent = "\u5DF2\u4F7F\u7528\u672C\u5730\u81EA\u52A8\u5339\u914D";
      elements.subtitleResultDetail.textContent = `\u5F53\u524D\u5B57\u5E55\uFF1A${localSubtitleMatch.fileName} \xB7 \u82F1\u6587\u4E3B\u7EBF + \u4E2D\u6587\u5B57\u5E55\u4FDD\u7559`;
    } else {
      elements.localSubtitleState.textContent = subtitleIndexLoaded ? "\u672A\u5339\u914D\u5230\u5F53\u524D\u5267\u96C6" : "\u6B63\u5728\u52A0\u8F7D\u672C\u5730\u5B57\u5E55\u7D22\u5F15";
      elements.subtitleResultTitle.textContent = "\u7B49\u5F85\u672C\u5730\u5B57\u5E55\u5339\u914D";
      elements.subtitleResultDetail.textContent = currentReaderBlockReason() ?? "\u6B63\u5728\u6839\u636E reader \u9875\u9762\u8BC6\u522B\u5267\u96C6\u3002";
    }
  } else if (loadedSubtitleDocument) {
    elements.subtitleResultTitle.textContent = "\u5DF2\u4F7F\u7528\u624B\u52A8\u5B57\u5E55";
    elements.subtitleResultDetail.textContent = `\u5F53\u524D\u5B57\u5E55\uFF1A${loadedSubtitleDocument.fileName} \xB7 ${loadedSubtitleDocument.metadata.segmentCount} \u6761\u5B57\u5E55`;
  } else {
    elements.subtitleResultTitle.textContent = "\u7B49\u5F85\u624B\u52A8\u5B57\u5E55";
    elements.subtitleResultDetail.textContent = "\u8BF7\u62D6\u5165 ASS\u3001SSA\u3001SRT \u6216 VTT \u5B57\u5E55\u6587\u4EF6\u3002";
  }
  const buildResult = currentRuntimeBuild;
  const ready = loadedSubtitleDocument !== null && buildResult !== null && manifest !== null && currentReaderBlockReason() === null;
  elements.toVideo.disabled = !ready;
  if (ready && buildResult) {
    elements.subtitleResultTitle.textContent = selectedSubtitleMode === "local" ? "\u5DF2\u4F7F\u7528\u672C\u5730\u81EA\u52A8\u5339\u914D" : "\u5DF2\u4F7F\u7528\u624B\u52A8\u5B57\u5E55";
    elements.subtitleResultDetail.textContent = `\u5DF2\u751F\u6210\u8FD0\u884C\u65F6\u6E05\u5355\uFF1A\u8986\u76D6 ${Math.round(buildResult.stats.coverageRatio * 100)}%\uFF0C\u547D\u4E2D ${buildResult.stats.matchedParagraphCount}/${buildResult.stats.articleParagraphCount} \u6BB5\u3002`;
  } else if (loadedSubtitleDocument && !currentRuntimeBuild) {
    elements.subtitleResultTitle.textContent = "\u6B63\u5728\u6784\u5EFA\u540C\u6B65\u7D22\u5F15";
    elements.subtitleResultDetail.textContent = currentReaderBlockReason() ?? "\u5B57\u5E55\u5DF2\u8F7D\u5165\uFF0C\u6B63\u5728\u7B49\u5F85 reader \u5168\u6587\u5FEB\u7167\u5E76\u751F\u6210\u8FD0\u884C\u65F6\u5339\u914D\u3002";
  }
  const subtitleName = loadedSubtitleDocument?.fileName ?? "\u7B49\u5F85\u5B57\u5E55";
  elements.videoSubtitleChip.textContent = subtitleName;
  elements.playerSubtitlePill.textContent = `\u5B57\u5E55\uFF1A${subtitleName}`;
}
function updateAllUi() {
  updateReaderUi();
  updateSubtitleChoiceUi();
}
function setSubtitleStatus(message) {
  elements.subtitleResultDetail.textContent = message;
}
function resetRuntimeSubtitleBuild() {
  currentRuntimeBuild = null;
  runtimeBuildInFlight = false;
  runtimeBuildRequestedFingerprint = null;
  runtimeBuildFailedFingerprint = null;
  articleSnapshotRequestIssuedAt = null;
  articleSnapshotLastRequestedAt = 0;
}
function resolveRuntimeBuildFingerprint() {
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
function requestArticleSnapshot() {
  const now = Date.now();
  if (articleSnapshotRequestIssuedAt === null) {
    articleSnapshotRequestIssuedAt = now;
  }
  if (now - articleSnapshotLastRequestedAt < 4e3) {
    return;
  }
  articleSnapshotLastRequestedAt = now;
  postRuntimeMessage({ type: "REQUEST_ACTIVE_ARTICLE_SNAPSHOT" });
}
function rebuildManifestLookups(manifestValue) {
  transcriptSegmentsByIndex = new Map(
    manifestValue.transcript.segments.map((segment) => [segment.index, segment])
  );
  articleParagraphsByIndex = new Map(
    (manifestValue.article?.paragraphs ?? []).map((paragraph) => [paragraph.paragraphIndex, paragraph])
  );
}
function installManifest(manifestValue) {
  manifest = manifestValue;
  rebuildManifestLookups(manifestValue);
  elements.playerStatus.textContent = `\u540C\u6B65\u5DF2\u5C31\u7EEA\uFF1A${manifestValue.sync.length} \u6761\u6620\u5C04\u3002`;
}
function maybeRebuildRuntimeSubtitleManifest() {
  if (!loadedSubtitleDocument) {
    return;
  }
  if (articleSnapshotError) {
    setSubtitleStatus(`\u5B57\u5E55\u5DF2\u8F7D\u5165\uFF0C\u7B49\u5F85\u5168\u6587\u6587\u7AE0\u5FEB\u7167\uFF1A${articleSnapshotError}`);
    return;
  }
  if (!articleSnapshot) {
    setSubtitleStatus("\u5B57\u5E55\u5DF2\u8F7D\u5165\uFF0C\u6B63\u5728\u83B7\u53D6\u5168\u6587\u6587\u7AE0\u5FEB\u7167\u3002");
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
  if (fingerprint === runtimeBuildFailedFingerprint || runtimeBuildInFlight && fingerprint === runtimeBuildRequestedFingerprint) {
    return;
  }
  const activeBuildToken = ++runtimeBuildToken;
  const activeSubtitleDocument = loadedSubtitleDocument;
  const activeArticleSnapshot = articleSnapshot;
  runtimeBuildInFlight = true;
  runtimeBuildRequestedFingerprint = fingerprint;
  currentRuntimeBuild = null;
  setSubtitleStatus("\u5B57\u5E55\u5DF2\u8F7D\u5165\uFF0C\u6B63\u5728\u6267\u884C\u8FD0\u884C\u65F6\u5339\u914D... 0%");
  void buildRuntimeManifestFromSubtitleAsync(activeSubtitleDocument, activeArticleSnapshot, (progress) => {
    if (activeBuildToken !== runtimeBuildToken) {
      return;
    }
    setSubtitleStatus(`\u5B57\u5E55\u5DF2\u8F7D\u5165\uFF0C\u6B63\u5728\u6267\u884C\u8FD0\u884C\u65F6\u5339\u914D... ${Math.round(progress.percent * 100)}% \xB7 ${progress.message}`);
  }).then((buildResult) => {
    if (activeBuildToken !== runtimeBuildToken) {
      return;
    }
    runtimeBuildInFlight = false;
    runtimeBuildFingerprint = fingerprint;
    runtimeBuildRequestedFingerprint = null;
    runtimeBuildFailedFingerprint = null;
    currentRuntimeBuild = buildResult;
    installManifest(buildResult.manifest);
    elements.subtitleResultTitle.textContent = selectedSubtitleMode === "local" ? "\u5DF2\u4F7F\u7528\u672C\u5730\u81EA\u52A8\u5339\u914D" : "\u5DF2\u4F7F\u7528\u624B\u52A8\u5B57\u5E55";
    elements.subtitleResultDetail.textContent = `\u5DF2\u751F\u6210\u8FD0\u884C\u65F6\u6E05\u5355\uFF1A\u8986\u76D6 ${Math.round(buildResult.stats.coverageRatio * 100)}%\uFF0C\u547D\u4E2D ${buildResult.stats.matchedParagraphCount}/${buildResult.stats.articleParagraphCount} \u6BB5\u3002`;
    updateSubtitleChoiceUi();
    logger.info("Runtime subtitle manifest built", {
      subtitleFile: activeSubtitleDocument.fileName,
      articleId: activeArticleSnapshot.articleId,
      matchedParagraphCount: buildResult.stats.matchedParagraphCount
    });
  }).catch((error) => {
    if (activeBuildToken !== runtimeBuildToken) {
      return;
    }
    resetRuntimeSubtitleBuild();
    runtimeBuildFailedFingerprint = fingerprint;
    const message = error instanceof Error ? error.message : String(error);
    setSubtitleStatus(`\u5B57\u5E55\u5339\u914D\u5931\u8D25\uFF1A${message}`);
    updateSubtitleChoiceUi();
    logger.warn("Runtime subtitle manifest failed", { message });
  });
}
async function installSubtitleFile(file, mode) {
  selectedSubtitleMode = mode;
  elements.subtitleFileState.textContent = file.name;
  const parsed = await parseSubtitleFile(file);
  loadedSubtitleDocument = parsed;
  resetRuntimeSubtitleBuild();
  elements.playerSubtitlePill.textContent = `\u5B57\u5E55\uFF1A${parsed.fileName}`;
  updateSubtitleChoiceUi();
  maybeRebuildRuntimeSubtitleManifest();
}
async function loadLocalSubtitle(match) {
  const response = await fetch(chrome.runtime.getURL(match.path));
  if (!response.ok) {
    throw new Error(`\u672C\u5730\u5B57\u5E55\u52A0\u8F7D\u5931\u8D25 (${response.status})`);
  }
  const blob = await response.blob();
  const file = new File([blob], match.fileName, { type: "text/plain" });
  await installSubtitleFile(file, "local");
}
async function refreshLocalSubtitleMatch() {
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
    elements.subtitleResultTitle.textContent = "\u672C\u5730\u5B57\u5E55\u52A0\u8F7D\u5931\u8D25";
    elements.subtitleResultDetail.textContent = "\u8BF7\u6539\u7528\u624B\u52A8\u62D6\u5165\u5B57\u5E55\u3002";
  }
}
function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "00:00.000";
  }
  const minutes = Math.floor(seconds / 60);
  const wholeSeconds = Math.floor(seconds % 60);
  const milliseconds = Math.floor(seconds % 1 * 1e3);
  return `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}
function syncPlayerReadout() {
  const duration = Number.isFinite(elements.video.duration) ? elements.video.duration : 0;
  elements.timeReadout.textContent = `${formatTime(elements.video.currentTime)} / ${formatTime(duration)}`;
  elements.playToggle.textContent = elements.video.paused ? "\u64AD\u653E" : "\u6682\u505C";
}
function describeVideoProbe(fileName, probe) {
  const videoStream = probe.streams.find((stream) => stream.codecType === "video");
  const audioStreams = probe.streams.filter((stream) => stream.codecType === "audio");
  const container = formatContainerFormats(resolveContainerFormatsForDisplay(fileName, probe.containerFormats));
  const video = videoStream ? `${videoStream.codecName}${videoStream.width && videoStream.height ? ` ${videoStream.width}x${videoStream.height}` : ""}` : "none";
  const audio = formatAudioCodecs(audioStreams.map((stream) => stream.codecName));
  return {
    container,
    video,
    audio,
    detail: `\u5C01\u88C5 ${container}\uFF0C\u89C6\u9891 ${video}\uFF0C\u97F3\u9891 ${audio}`
  };
}
function describeTranscodePlan(strategy) {
  const containerStep = strategy.containerAction === "copy" ? "\u5C01\u88C5\u65E0\u9700\u91CD\u505A" : "\u91CD\u5C01\u88C5\u5230 MP4";
  const videoStep = strategy.videoAction === "copy" ? `\u89C6\u9891\u590D\u7528 ${strategy.videoCodec}` : "\u89C6\u9891\u8F6C HEVC(HVC1)";
  const audioStep = strategy.audioAction === "copy" ? `\u97F3\u9891\u590D\u7528 ${formatAudioCodecs(strategy.audioCodecs)}` : `\u97F3\u9891\u8F6C AAC\uFF08\u5F53\u524D ${formatAudioCodecs(strategy.audioCodecs)}\uFF09`;
  return `${containerStep}\uFF1B${videoStep}\uFF1B${audioStep}`;
}
function setProcessingProgress(message, percent) {
  elements.processingBox.classList.add("is-active");
  if (typeof percent === "number" && Number.isFinite(percent)) {
    elements.processingProgress.value = Math.min(100, Math.max(0, Math.round(percent * 100)));
  }
  elements.processingText.textContent = message;
}
function setVideoTranscodeProgress(message, progress) {
  if (!Number.isFinite(progress)) {
    return;
  }
  const clampedProgress = clamp(progress, 0, 1);
  const visibleProgress = clampedProgress >= 1 ? 0.99 : clampedProgress;
  setProcessingProgress(`${message} \xB7 ${Math.round(visibleProgress * 100)}%`, visibleProgress);
}
function updateVideoDecisionControls() {
  const hasSourceVideo = sourceVideoFile !== null;
  const canDirectPlay = hasSourceVideo && !videoInspectionBusy && !videoTranscodeBusy;
  const canPreprocess = hasSourceVideo && sourceVideoProbe !== null && sourceVideoAssessment !== null && !sourceVideoAssessment.isRecommendedProfile && !videoInspectionBusy && !videoTranscodeBusy;
  elements.riskPlay.disabled = !canDirectPlay;
  elements.processPlay.disabled = !(canPreprocess || sourceVideoAssessment?.isRecommendedProfile && canDirectPlay);
  elements.processPlay.textContent = sourceVideoAssessment?.isRecommendedProfile ? "\u76F4\u63A5\u8FDB\u5165\u64AD\u653E" : "\u4E00\u952E\u5904\u7406\u5E76\u64AD\u653E";
}
function revokeProcessedVideoArtifact() {
  if (processedVideoObjectUrl) {
    URL.revokeObjectURL(processedVideoObjectUrl);
    processedVideoObjectUrl = null;
  }
  processedVideoFile = null;
}
function resetVideoDecisionState(fileName) {
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
  elements.videoName.textContent = fileName ?? "\u672A\u5BFC\u5165";
  elements.videoContainer.textContent = "\u7B49\u5F85\u68C0\u6D4B";
  elements.videoCodec.textContent = "\u7B49\u5F85\u68C0\u6D4B";
  elements.audioCodec.textContent = "\u7B49\u5F85\u68C0\u6D4B";
  elements.videoPlan.textContent = "\u5BFC\u5165\u540E\u5224\u65AD";
  elements.processingBox.classList.remove("is-active");
  elements.processingProgress.value = 0;
  elements.processingText.textContent = "\u6B63\u5728\u51C6\u5907";
  elements.processPlay.textContent = "\u4E00\u952E\u5904\u7406\u5E76\u64AD\u653E";
  updateVideoDecisionControls();
}
function buildBrowserFfmpegStatusMessage(event) {
  if (event.detail?.message) {
    return event.detail.message;
  }
  switch (event.phase) {
    case "loading-core":
      return "\u6B63\u5728\u88C5\u8F7D\u5185\u7F6E FFmpeg Core";
    case "ready":
      return "\u5185\u7F6E FFmpeg Core \u5DF2\u5C31\u7EEA";
    case "writing-input":
      return "\u6B63\u5728\u5199\u5165\u8F93\u5165\u6587\u4EF6";
    case "probing":
      return "\u6B63\u5728\u68C0\u6D4B\u771F\u5B9E\u97F3\u89C6\u9891\u6D41";
    case "transcoding":
      return "\u6B63\u5728\u672C\u5730\u9884\u5904\u7406";
    case "finalizing-output":
      return "\u6B63\u5728\u5C01\u53E3 MP4 \u8F93\u51FA";
    case "reading-output":
      return "\u6B63\u5728\u8BFB\u53D6\u9884\u5904\u7406\u7ED3\u679C";
    case "completed":
      return "\u9884\u5904\u7406\u5B8C\u6210";
    default:
      return "\u6B63\u5728\u5904\u7406";
  }
}
async function loadVideoFile(file) {
  const extension = fileExtension(file.name);
  if (!supportedVideoExtensions.has(extension)) {
    elements.videoDropTitle.textContent = "\u53EA\u63A5\u53D7 MP4 \u6216 MKV";
    elements.videoDropDesc.textContent = "\u8BF7\u91CD\u65B0\u62D6\u5165\u6B63\u786E\u683C\u5F0F\u7684\u89C6\u9891\u6587\u4EF6\u3002";
    throw new Error("\u53EA\u652F\u6301 MP4 \u6216 MKV \u89C6\u9891\u6587\u4EF6\u3002");
  }
  sourceVideoFile = file;
  resetVideoDecisionState(file.name);
  elements.videoDropTitle.textContent = "\u89C6\u9891\u5DF2\u5BFC\u5165";
  elements.videoDropDesc.textContent = file.name;
  elements.playerVideoPill.textContent = `\u89C6\u9891\uFF1A${file.name}`;
  videoObjectUrl = URL.createObjectURL(file);
  elements.video.src = videoObjectUrl;
  elements.video.load();
  const token = ++videoInspectionToken;
  videoInspectionBusy = true;
  updateVideoDecisionControls();
  setProcessingProgress("\u6B63\u5728\u68C0\u6D4B\u771F\u5B9E\u97F3\u89C6\u9891\u6D41...", 0);
  try {
    const probe = await browserFfmpegService.inspectFile(file, {
      onStatusChange: (event) => setProcessingProgress(buildBrowserFfmpegStatusMessage(event)),
      onProgress: ({ progress }) => setProcessingProgress("\u6B63\u5728\u68C0\u6D4B\u771F\u5B9E\u97F3\u89C6\u9891\u6D41...", progress)
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
    elements.videoPlan.textContent = assessment.isRecommendedProfile ? "\u53EF\u76F4\u63A5\u64AD\u653E" : describeTranscodePlan(strategy);
    elements.processingText.textContent = assessment.summary;
    elements.processingProgress.value = assessment.isRecommendedProfile ? 100 : 0;
    if (assessment.isRecommendedProfile) {
      await playOriginalVideoFile({ enterPlayer: true });
    }
  } catch (error) {
    if (token !== videoInspectionToken) {
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sourceVideoInspectionError = message;
    elements.videoPlan.textContent = "\u68C0\u6D4B\u5931\u8D25";
    elements.processingText.textContent = message;
    throw error;
  } finally {
    if (token === videoInspectionToken) {
      videoInspectionBusy = false;
      updateVideoDecisionControls();
    }
  }
}
async function playOriginalVideoFile(options) {
  if (!sourceVideoFile || !videoObjectUrl) {
    throw new Error("\u8BF7\u5148\u62D6\u5165\u89C6\u9891\u6587\u4EF6\u3002");
  }
  currentVideoVariant = "original";
  elements.video.src = videoObjectUrl;
  elements.video.load();
  elements.playerVideoPill.textContent = `\u89C6\u9891\uFF1A${sourceVideoFile.name}`;
  elements.playerNote.textContent = sourceVideoAssessment?.isRecommendedProfile ? "\u5DF2\u547D\u4E2D\u63A8\u8350\u64AD\u653E\u57FA\u7EBF\uFF0C\u5F00\u59CB\u540C\u6B65 reader \u9875\u9762\u3002" : "\u6B63\u5728\u8BD5\u64AD\u539F\u59CB\u6587\u4EF6\uFF0C\u82E5\u5931\u8D25\u8BF7\u8FD4\u56DE\u4E00\u952E\u5904\u7406\u3002";
  elements.playerStatus.textContent = sourceVideoAssessment?.isRecommendedProfile ? "\u89C6\u9891\u53EF\u76F4\u63A5\u64AD\u653E\u3002" : "\u6B63\u5728\u8BD5\u64AD\u539F\u59CB\u6587\u4EF6\uFF1B\u5982\u65E0\u58F0\u6216\u9ED1\u5C4F\uFF0C\u8BF7\u5207\u6362\u4E0B\u4E00\u96C6\u540E\u91CD\u65B0\u4E00\u952E\u5904\u7406\u3002";
  if (options?.enterPlayer) {
    setView("player");
  }
}
async function playProcessedVideoFile() {
  if (!processedVideoFile || !processedVideoObjectUrl) {
    throw new Error("\u5F53\u524D\u8FD8\u6CA1\u6709\u9884\u5904\u7406\u7ED3\u679C\u3002");
  }
  currentVideoVariant = "processed";
  elements.video.src = processedVideoObjectUrl;
  elements.video.load();
  elements.playerVideoPill.textContent = `\u89C6\u9891\uFF1A${processedVideoFile.name}`;
  elements.playerNote.textContent = "\u5DF2\u5B8C\u6210\u517C\u5BB9\u5904\u7406\uFF0C\u5F00\u59CB\u540C\u6B65 reader \u9875\u9762\u3002";
  elements.playerStatus.textContent = "\u517C\u5BB9\u5224\u65AD\u5B8C\u6210\uFF0C\u53EF\u4EE5\u64AD\u653E\u3001\u8C03\u901F\u3001\u6C89\u6D78\u6216\u5207\u6362\u753B\u4E2D\u753B\u3002";
  setView("player");
}
async function preprocessVideoFile() {
  if (!sourceVideoFile || !sourceVideoProbe || !sourceVideoStrategy) {
    throw new Error("\u8BF7\u5148\u62D6\u5165\u5E76\u5B8C\u6210\u68C0\u6D4B\u3002");
  }
  if (sourceVideoAssessment?.isRecommendedProfile) {
    await playOriginalVideoFile({ enterPlayer: true });
    return;
  }
  if (videoInspectionBusy || videoTranscodeBusy) {
    throw new Error("\u5F53\u524D\u5DF2\u6709\u89C6\u9891\u4EFB\u52A1\u5728\u6267\u884C\u3002");
  }
  const sourceFile = sourceVideoFile;
  const sourceProbe = sourceVideoProbe;
  const strategy = sourceVideoStrategy;
  videoTranscodeBusy = true;
  updateVideoDecisionControls();
  setProcessingProgress("\u51C6\u5907\u5199\u5165\u89C6\u9891\u5E76\u542F\u52A8\u9884\u5904\u7406...", 0);
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
    elements.videoPlan.textContent = "\u5DF2\u751F\u6210\u517C\u5BB9\u7248\u672C";
    setProcessingProgress(`\u5DF2\u751F\u6210 ${result.file.name}\uFF0C\u6B63\u5728\u8FDB\u5165\u64AD\u653E\u3002`, 1);
    await playProcessedVideoFile();
  } finally {
    videoTranscodeBusy = false;
    updateVideoDecisionControls();
  }
}
function resolveActiveParagraphIndex(currentTimeMs) {
  return resolveActiveSyncEntry(manifest, currentTimeMs)?.paragraphIndex ?? null;
}
function broadcastPlayerState(force = false) {
  const now = Date.now();
  if (!force && now - lastBroadcastAt < 250) {
    return;
  }
  lastBroadcastAt = now;
  const state = elements.video.error ? "error" : elements.video.ended ? "ended" : elements.video.paused ? "paused" : "playing";
  const currentTimeMs = Math.round(elements.video.currentTime * 1e3);
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
function broadcastIdlePlayerState() {
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
function seekToParagraph(paragraphIndex) {
  const entry = manifest?.sync.find((item) => item.paragraphIndex === paragraphIndex);
  if (!entry) {
    return;
  }
  elements.video.currentTime = Math.max(0, entry.startMs / 1e3);
  broadcastPlayerState(true);
}
function applyPlayerControl(command) {
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
    elements.video.currentTime = Math.max(0, elements.video.currentTime + (payload.deltaMs ?? 0) / 1e3);
  } else if (payload.command === "step_playback_rate") {
    const nextRate = clamp(elements.video.playbackRate + (payload.step ?? 0) * 0.25, 0.5, 2);
    setPlaybackRate(nextRate);
  }
  broadcastPlayerState(true);
}
function handleRuntimeMessage(message) {
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
function bindDropZone(zone, callback) {
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
    const dragEvent = event;
    const file = dragEvent.dataTransfer?.files[0];
    if (file) {
      callback(file);
    }
  });
}
function resetEpisode() {
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
  elements.subtitleFileState.textContent = "\u672A\u9009\u62E9\u6587\u4EF6";
  elements.videoDropTitle.textContent = "\u628A\u89C6\u9891\u6587\u4EF6\u62D6\u5230\u8FD9\u91CC";
  elements.videoDropDesc.textContent = "\u5BFC\u5165\u540E\u4F1A\u7528\u5185\u7F6E FFmpeg \u8BFB\u53D6\u771F\u5B9E\u5BB9\u5668\u3001\u89C6\u9891\u6D41\u548C\u97F3\u9891\u6D41\u3002";
  elements.playerWrap.classList.remove("is-expanded");
  document.body.classList.remove("immersive-active");
  setView("subtitle");
  void refreshLocalSubtitleMatch();
}
function attachEvents() {
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
    elements.subtitleResultTitle.textContent = "\u5728\u7EBF\u5339\u914D\u6682\u672A\u5F00\u653E";
    elements.subtitleResultDetail.textContent = "\u540E\u7EED\u4ECE GitHub \u5B57\u5E55\u4ED3\u5E93\u52A8\u6001\u66F4\u65B0\u3002";
  });
  elements.subtitleFile.addEventListener("change", () => {
    const file = elements.subtitleFile.files?.[0];
    if (!file) {
      return;
    }
    const extension = fileExtension(file.name);
    if (!supportedSubtitleExtensions.has(extension)) {
      elements.subtitleFileState.textContent = "\u53EA\u652F\u6301 ASS/SSA/SRT/VTT";
      return;
    }
    void installSubtitleFile(file, "manual").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      elements.subtitleResultTitle.textContent = "\u5B57\u5E55\u52A0\u8F7D\u5931\u8D25";
      elements.subtitleResultDetail.textContent = message;
    });
  });
  bindDropZone(elements.subtitleDrop, (file) => {
    void installSubtitleFile(file, "manual").catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      elements.subtitleResultTitle.textContent = "\u5B57\u5E55\u52A0\u8F7D\u5931\u8D25";
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
        elements.videoDropTitle.textContent = "\u89C6\u9891\u52A0\u8F7D\u5931\u8D25";
        elements.videoDropDesc.textContent = message;
      });
    }
  });
  bindDropZone(elements.videoDrop, (file) => {
    void loadVideoFile(file).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      elements.videoDropTitle.textContent = "\u89C6\u9891\u52A0\u8F7D\u5931\u8D25";
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
    void (elements.video.paused ? elements.video.play() : Promise.resolve(elements.video.pause())).catch((error) => {
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
      elements.playerStatus.textContent = `\u500D\u901F\u5DF2\u5207\u6362\u4E3A ${formatPlaybackRate(rate)}\u3002`;
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
    elements.expandToggle.textContent = expanded ? "\u9000\u51FA\u6C89\u6D78" : "\u6C89\u6D78";
    elements.playerStatus.textContent = expanded ? "\u5DF2\u8FDB\u5165\u6C89\u6D78\u64AD\u653E\u3002" : "\u5DF2\u9000\u51FA\u6C89\u6D78\u64AD\u653E\u3002";
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
async function togglePictureInPicture() {
  if (!document.pictureInPictureEnabled || typeof elements.video.requestPictureInPicture !== "function") {
    elements.playerStatus.textContent = "\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u753B\u4E2D\u753B\u3002";
    return;
  }
  try {
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      elements.playerStatus.textContent = "\u5DF2\u9000\u51FA\u753B\u4E2D\u753B\u3002";
    } else {
      await elements.video.requestPictureInPicture();
      elements.playerStatus.textContent = "\u5DF2\u8FDB\u5165\u753B\u4E2D\u753B\u3002";
    }
  } catch (error) {
    elements.playerStatus.textContent = error instanceof Error ? error.message : "\u753B\u4E2D\u753B\u542F\u52A8\u5931\u8D25\u3002";
  }
}
async function bootstrap() {
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
//# sourceMappingURL=player.js.map
