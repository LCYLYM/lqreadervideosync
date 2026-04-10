import type { TranscriptSegment } from "./protocol";

export interface ParsedSubtitleDocument {
  fileName: string;
  format: "ass" | "srt" | "vtt";
  transcript: {
    mode: string;
    language?: string;
    modelName: string;
    text: string;
    segments: TranscriptSegment[];
  };
  metadata: {
    title?: string;
    segmentCount: number;
    translationCount: number;
  };
}

interface ParsedSubtitleLine {
  startMs: number;
  endMs: number;
  text: string;
  translation?: string;
}

const ASS_TAG_PATTERN = /\{[^}]*\}/g;
const HTML_TAG_PATTERN = /<[^>]+>/g;
const SPEAKER_PREFIX_PATTERN = /^[A-Za-z][A-Za-z' .-]{0,40}:\s*/;
const MULTISPACE_PATTERN = /\s+/g;
const CJK_PATTERN = /[\u3400-\u9fff]/;
const LATIN_PATTERN = /[A-Za-z]/g;

function detectTextEncoding(bytes: Uint8Array): string {
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return "utf-16le";
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return "utf-16be";
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
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

async function readTextFile(file: File): Promise<string> {
  const buffer = new Uint8Array(await file.arrayBuffer());
  return new TextDecoder(detectTextEncoding(buffer), { fatal: false }).decode(buffer);
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\uFEFF/g, "")
    .replace(MULTISPACE_PATTERN, " ")
    .trim();
}

function stripSpeakerPrefix(value: string): string {
  return value.replace(SPEAKER_PREFIX_PATTERN, "").trim();
}

function scoreEnglishLikelihood(value: string): number {
  const normalized = value.trim();
  if (!normalized) {
    return -100;
  }

  const latinCount = (normalized.match(LATIN_PATTERN) ?? []).length;
  const cjkCount = (normalized.match(CJK_PATTERN) ?? []).length;
  const asciiCount = Array.from(normalized).filter((character) => character.charCodeAt(0) <= 127).length;
  return (latinCount * 3) + asciiCount - (cjkCount * 4);
}

function pickPrimaryAndTranslation(rawLines: string[]): { text: string; translation?: string } {
  const cleanedLines = rawLines
    .map((line) => normalizeWhitespace(stripSpeakerPrefix(line)))
    .filter(Boolean);
  if (cleanedLines.length === 0) {
    return { text: "" };
  }
  if (cleanedLines.length === 1) {
    return { text: cleanedLines[0] };
  }

  const rankedLines = cleanedLines
    .map((line) => ({ line, score: scoreEnglishLikelihood(line) }))
    .sort((left, right) => right.score - left.score);
  const primary = rankedLines[0]?.line ?? cleanedLines[0];
  const translation = cleanedLines.find((line) => line !== primary);
  return {
    text: primary,
    translation
  };
}

function toTranscriptSegments(lines: ParsedSubtitleLine[]): TranscriptSegment[] {
  const segments = lines
    .map((line, index) => ({
      index: index + 1,
      startMs: line.startMs,
      endMs: Math.max(line.endMs, line.startMs + 1),
      text: line.text
    }))
    .filter((segment) => segment.text.length > 0 && segment.endMs > segment.startMs);

  return segments.map((segment, index) => ({
    ...segment,
    index: index + 1
  }));
}

function normalizeSubtitleText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\uFEFF/g, "")
    .replace(ASS_TAG_PATTERN, "")
    .replace(HTML_TAG_PATTERN, "")
    .replace(/\\N/gi, "\n")
    .replace(/\\n/gi, "\n")
    .replace(/\\h/gi, " ");
}

function parseAssTimestamp(value: string): number {
  const match = value.trim().match(/^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,3})$/);
  if (!match) {
    throw new Error(`无效的 ASS 时间戳: ${value}`);
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  const fractionRaw = match[4];
  const milliseconds =
    fractionRaw.length === 1
      ? Number.parseInt(fractionRaw, 10) * 100
      : fractionRaw.length === 2
        ? Number.parseInt(fractionRaw, 10) * 10
        : Number.parseInt(fractionRaw.slice(0, 3), 10);
  return (((hours * 60) + minutes) * 60 * 1000) + (seconds * 1000) + milliseconds;
}

function parseAssDialogue(text: string): ParsedSubtitleDocument["metadata"] & { lines: ParsedSubtitleLine[] } {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalizedText.split("\n");
  let inEventsSection = false;
  let eventFormat: string[] = [];
  let title: string | undefined;
  const parsedLines: ParsedSubtitleLine[] = [];
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
      eventFormat = line
        .slice(line.indexOf(":") + 1)
        .split(",")
        .map((value) => value.trim().toLowerCase());
      continue;
    }

    if (!/^dialogue:/i.test(line)) {
      continue;
    }

    if (eventFormat.length === 0) {
      throw new Error("ASS 文件缺少 [Events] Format 定义。");
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
      throw new Error("ASS Events Format 缺少 start/end/text 字段。");
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

function parseSrtTimestamp(value: string): number {
  const match = value.trim().match(/^(\d{2,}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) {
    throw new Error(`无效的 SRT/VTT 时间戳: ${value}`);
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = Number.parseInt(match[3], 10);
  const milliseconds = Number.parseInt(match[4], 10);
  return (((hours * 60) + minutes) * 60 * 1000) + (seconds * 1000) + milliseconds;
}

function parseSimpleTimedSubtitle(text: string, format: "srt" | "vtt"): ParsedSubtitleDocument["metadata"] & { lines: ParsedSubtitleLine[] } {
  const normalizedText = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\uFEFF/g, "");
  const blocks = normalizedText.split(/\n{2,}/);
  const parsedLines: ParsedSubtitleLine[] = [];
  let translationCount = 0;

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0 || (format === "vtt" && lines[0] === "WEBVTT")) {
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

function buildParsedDocument(
  fileName: string,
  format: ParsedSubtitleDocument["format"],
  metadata: ParsedSubtitleDocument["metadata"],
  lines: ParsedSubtitleLine[]
): ParsedSubtitleDocument {
  const segments = toTranscriptSegments(lines);
  if (segments.length === 0) {
    throw new Error("字幕文件里没有可用对白段。");
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

export async function parseSubtitleFile(file: File): Promise<ParsedSubtitleDocument> {
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

  throw new Error(`当前还不支持该字幕格式: ${extension || "unknown"}`);
}
