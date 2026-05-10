export interface MediaStreamProbe {
  codecType: "video" | "audio";
  codecName: string;
  index: number;
  width?: number;
  height?: number;
}

export interface MediaProbeResult {
  containerFormats: string[];
  streams: MediaStreamProbe[];
}

export interface MediaTranscodeStrategy {
  containerAction: "copy" | "remux";
  videoAction: "copy" | "transcode";
  audioAction: "copy" | "transcode";
  videoCodec: string;
  audioCodecs: string[];
  outputFileName: string;
}

export interface MediaCompatibilityAssessment {
  isRecommendedProfile: boolean;
  reasons: string[];
  summary: string;
  detail: string;
}

const preferredContainerFormats = new Set(["mov", "mp4", "m4a", "3gp", "3g2", "mj2"]);
const browserPlayableVideoCodecs = new Set(["hevc", "h264", "avc1"]);
const hevcSampleEntries = new Set(["hvc1", "hev1"]);
const h264SampleEntries = new Set(["avc1", "avc2", "avc3", "avc4"]);
const aacSampleEntries = new Set(["mp4a"]);
const browserPlayableVideoCodecLabels = new Map<string, string>([
  ["hevc", "HEVC(HVC1)"],
  ["h264", "H.264/AVC"],
  ["avc1", "H.264/AVC"]
]);

export function buildOutputVideoName(fileName: string, strategy?: Pick<MediaTranscodeStrategy, "videoAction" | "audioAction" | "videoCodec">): string {
  const lastDotIndex = fileName.lastIndexOf(".");
  const stem = lastDotIndex === -1 ? fileName : fileName.slice(0, lastDotIndex);
  if (!strategy) {
    return `${stem}.hvc1.aac.mp4`;
  }
  const videoProfile = strategy.videoAction === "copy" ? normalizeOutputCodecSlug(strategy.videoCodec) : "hvc1";
  const audioProfile = strategy.audioAction === "copy" ? "source-audio" : "aac";
  return `${stem}.${videoProfile}.${audioProfile}.mp4`;
}

export function buildMediaTranscodeStrategy(fileName: string, probe: MediaProbeResult): MediaTranscodeStrategy {
  const resolvedContainerFormats = resolveContainerFormats(fileName, probe.containerFormats);
  const videoStream = probe.streams.find((stream) => stream.codecType === "video");
  const audioStreams = probe.streams.filter((stream) => stream.codecType === "audio");

  if (!videoStream) {
    throw new Error("输入文件缺少视频流，无法进入播放器。");
  }

  const containerAction = isPreferredContainer(resolvedContainerFormats) ? "copy" : "remux";
  const normalizedVideoCodec = normalizeCodecName(videoStream.codecName);
  const videoAction = browserPlayableVideoCodecs.has(normalizedVideoCodec) ? "copy" : "transcode";
  const normalizedAudioCodecs = audioStreams.map((stream) => normalizeCodecName(stream.codecName));
  const audioAction =
    normalizedAudioCodecs.length === 0 || normalizedAudioCodecs.every((codecName) => codecName === "aac")
      ? "copy"
      : "transcode";

  return {
    containerAction,
    videoAction,
    audioAction,
    videoCodec: normalizedVideoCodec,
    audioCodecs: normalizedAudioCodecs,
    outputFileName: buildOutputVideoName(fileName, {
      videoAction,
      audioAction,
      videoCodec: normalizedVideoCodec
    })
  };
}

export function assessMediaCompatibility(fileName: string, probe: MediaProbeResult): MediaCompatibilityAssessment {
  const resolvedContainerFormats = resolveContainerFormats(fileName, probe.containerFormats);
  const strategy = buildMediaTranscodeStrategy(fileName, probe);
  const reasons: string[] = [];

  if (strategy.containerAction === "remux") {
    reasons.push(`封装格式为 ${formatContainerFormats(resolvedContainerFormats)}，不在推荐的 MP4/MOV 基线内`);
  }
  if (strategy.videoCodec !== "hevc") {
    reasons.push(`视频编码为 ${formatVideoCodec(strategy.videoCodec)}，不是直接播放目标 HEVC(HVC1)`);
  }
  if (strategy.audioAction === "transcode") {
    reasons.push(`音频编码为 ${formatAudioCodecs(strategy.audioCodecs)}，不是目标 AAC`);
  }

  if (reasons.length === 0) {
    return {
      isRecommendedProfile: true,
      reasons,
      summary: "已命中推荐播放基线，将直接进入原生播放器。",
      detail: `封装 ${formatContainerFormats(resolvedContainerFormats)}，视频 ${formatVideoCodec(strategy.videoCodec)}，音频 ${formatAudioCodecs(strategy.audioCodecs)}。`
    };
  }

  return {
    isRecommendedProfile: false,
    reasons,
    summary: "当前文件偏离推荐播放基线，建议先做本地预处理。",
    detail: reasons.join("；")
  };
}

export function formatContainerFormats(containerFormats: string[]): string {
  return containerFormats.length > 0 ? containerFormats.join(", ") : "unknown";
}

export function formatAudioCodecs(audioCodecs: string[]): string {
  return audioCodecs.length > 0 ? audioCodecs.join(", ") : "none";
}

export function resolveContainerFormatsForDisplay(fileName: string, containerFormats: string[]): string[] {
  return resolveContainerFormats(fileName, containerFormats);
}

function isPreferredContainer(containerFormats: string[]): boolean {
  return containerFormats.some((format) => preferredContainerFormats.has(format));
}

function normalizeCodecName(codecName: string): string {
  const normalized = codecName.trim().toLowerCase();
  if (hevcSampleEntries.has(normalized)) {
    return "hevc";
  }
  if (h264SampleEntries.has(normalized)) {
    return "h264";
  }
  if (aacSampleEntries.has(normalized)) {
    return "aac";
  }
  return normalized;
}

function normalizeOutputCodecSlug(codecName: string): string {
  const normalized = normalizeCodecName(codecName);
  if (normalized === "hevc") {
    return "hvc1";
  }
  if (normalized === "h264" || normalized === "avc1") {
    return "avc1";
  }
  return normalized.replaceAll(/[^a-z0-9]+/g, "-").replaceAll(/^-|-$/g, "") || "video";
}

export function formatVideoCodec(codecName: string): string {
  const normalized = normalizeCodecName(codecName);
  return browserPlayableVideoCodecLabels.get(normalized) ?? codecName;
}

function resolveContainerFormats(fileName: string, containerFormats: string[]): string[] {
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
