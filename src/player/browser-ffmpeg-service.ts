import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import {
  buildMediaTranscodeStrategy,
  type MediaProbeResult,
  type MediaTranscodeStrategy
} from "./media-compatibility";

interface StatusDetail {
  message: string;
}

export interface BrowserFfmpegStatusEvent {
  phase:
    | "loading-core"
    | "ready"
    | "writing-input"
    | "probing"
    | "transcoding"
    | "finalizing-output"
    | "reading-output"
    | "completed";
  detail?: StatusDetail;
}

export interface BrowserFfmpegProgressEvent {
  progress: number;
  time: number;
}

export interface BrowserFfmpegHandlers {
  onStatusChange?: (event: BrowserFfmpegStatusEvent) => void;
  onProgress?: (event: BrowserFfmpegProgressEvent) => void;
  onLog?: (message: string) => void;
}

export interface BrowserFfmpegTranscodeResult {
  file: File;
  blob: Blob;
  strategy: MediaTranscodeStrategy;
  probe: MediaProbeResult;
}

interface LocalCoreAssetUrls {
  coreURL: string;
  wasmURL: string;
  classWorkerURL: string;
  workerURL?: string;
}

const ENCODING_PROFILE = Object.freeze({
  crf: "34",
  preset: "ultrafast",
  audioBitrate: "96k",
  pixelFormat: "yuv420p",
  maxWidth: "1280"
});

const LOCAL_CORE_ASSETS = Object.freeze({
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

export class BrowserFfmpegService {
  private readonly ffmpeg = new FFmpeg();

  private loaded = false;

  private coreAssetUrls: LocalCoreAssetUrls | null = null;

  private readonly recentLogs: string[] = [];

  private activeHandlers: BrowserFfmpegHandlers | null = null;

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

  async inspectFile(file: File, handlers: BrowserFfmpegHandlers = {}): Promise<MediaProbeResult> {
    await this.ensureLoaded(handlers);
    const jobKey = crypto.randomUUID();
    const inputPath = `${jobKey}-${sanitizeFileName(file.name)}`;
    const probeOutputPath = `${jobKey}-probe.null`;

    this.activeHandlers = handlers;
    this.recentLogs.length = 0;

    try {
      handlers.onStatusChange?.({
        phase: "writing-input",
        detail: { message: "正在写入待检测文件到浏览器本地内存文件系统" }
      });
      await this.ffmpeg.writeFile(inputPath, await fetchFile(file));

      handlers.onStatusChange?.({
        phase: "probing",
        detail: { message: "正在解析容器、视频流和音频流信息" }
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

  async transcodeFile(
    file: File,
    probe: MediaProbeResult,
    handlers: BrowserFfmpegHandlers = {}
  ): Promise<BrowserFfmpegTranscodeResult> {
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
        detail: { message: "正在写入待预处理文件" }
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
        detail: { message: "FFmpeg 已完成编码，正在封口 MP4 输出" }
      });
      await waitForLogFlush();

      handlers.onStatusChange?.({
        phase: "reading-output",
        detail: { message: "正在读取预处理结果并生成可播放文件" }
      });
      const outputData = await this.ffmpeg.readFile(outputPath);
      const outputBytes = normalizeBinaryFileData(outputData);
      if (outputBytes.byteLength === 0) {
        throw new Error("FFmpeg 输出文件为空，未生成可播放 MP4。");
      }
      const outputBlob = new Blob([copyBytesToArrayBuffer(outputBytes)], { type: "video/mp4" });
      const outputFile = new File([outputBlob], strategy.outputFileName, { type: "video/mp4" });

      handlers.onStatusChange?.({
        phase: "completed",
        detail: { message: `预处理完成，输出 ${formatBytes(outputBytes.byteLength)}` }
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

  terminate(): void {
    this.ffmpeg.terminate();
    this.loaded = false;
    this.coreAssetUrls = null;
  }

  private async ensureLoaded(handlers: BrowserFfmpegHandlers): Promise<void> {
    if (this.loaded) {
      handlers.onStatusChange?.({
        phase: "ready",
        detail: { message: "内置 FFmpeg Core 已就绪" }
      });
      return;
    }

    handlers.onStatusChange?.({
      phase: "loading-core",
      detail: { message: "正在装载扩展内置 FFmpeg Core" }
    });

    if (!this.coreAssetUrls) {
      this.coreAssetUrls = await loadLocalCoreAssetUrls();
    }

    await this.ffmpeg.load(this.coreAssetUrls);
    this.loaded = true;

    handlers.onStatusChange?.({
      phase: "ready",
      detail: { message: "内置 FFmpeg Core 装载完成" }
    });
  }
}

function describeStrategy(strategy: MediaTranscodeStrategy): string {
  const videoStep =
    strategy.videoAction === "copy" ? `视频直接复用(${strategy.videoCodec})` : `视频转 HEVC(HVC1)`;
  const audioStep =
    strategy.audioAction === "copy"
      ? `音频直接复用(${strategy.audioCodecs.length > 0 ? strategy.audioCodecs.join(", ") : "none"})`
      : `音频转 AAC`;
  const containerStep = strategy.containerAction === "copy" ? "沿用 MP4/MOV 基线" : "重封装为 MP4";
  return `${containerStep}；${videoStep}；${audioStep}`;
}

function buildTranscodeCommand(inputPath: string, outputPath: string, strategy: MediaTranscodeStrategy): string[] {
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

async function inspectMedia(
  ffmpeg: FFmpeg,
  inputPath: string,
  probeOutputPath: string,
  recentLogs: string[]
): Promise<MediaProbeResult> {
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

function parseProbeFromLogs(logs: string[]): MediaProbeResult {
  const inputLine = logs.find((line) => line.startsWith("Input #0,"));
  const videoLines = logs.filter((line) => line.includes("Video:"));
  const audioLines = logs.filter((line) => line.includes("Audio:"));

  if (videoLines.length === 0) {
    throw new Error(`无法从 FFmpeg 日志中解析视频流信息。\nRecent logs:\n${logs.slice(-20).join("\n")}`);
  }

  const containerFormats =
    inputLine
      ?.match(/^Input #0,\s+(.+),\s+from\b/)?.[1]
      ?.split(",")
      .map((value) => value.trim())
      .filter(Boolean) ?? [];

  const streams: MediaProbeResult["streams"] = videoLines.map((line, index) => {
    const codecName = line.match(/Video:\s+([^\s,(]+)/)?.[1];
    const width = line.match(/(\d{2,5})x(\d{2,5})/);
    if (!codecName || !width) {
      throw new Error(`无法从 FFmpeg 日志中解析视频编码详情。\nRecent logs:\n${logs.slice(-20).join("\n")}`);
    }
    return {
      codecType: "video" as const,
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

async function loadLocalCoreAssetUrls(): Promise<LocalCoreAssetUrls> {
  const [coreResponse, wasmResponse, classWorkerResponse] = await Promise.all([
    fetch(chrome.runtime.getURL(LOCAL_CORE_ASSETS.coreURL.path), { cache: "force-cache" }),
    fetch(chrome.runtime.getURL(LOCAL_CORE_ASSETS.wasmURL.path), { cache: "force-cache" }),
    fetch(chrome.runtime.getURL(LOCAL_CORE_ASSETS.classWorkerURL.path), { cache: "force-cache" })
  ]);

  if (!coreResponse.ok) {
    throw new Error(`无法加载扩展内置 FFmpeg Core 资源：${LOCAL_CORE_ASSETS.coreURL.path} (${coreResponse.status})`);
  }
  if (!wasmResponse.ok) {
    throw new Error(`无法加载扩展内置 FFmpeg Core 资源：${LOCAL_CORE_ASSETS.wasmURL.path} (${wasmResponse.status})`);
  }
  if (!classWorkerResponse.ok) {
    throw new Error(
      `无法加载扩展内置 FFmpeg Runtime Worker：${LOCAL_CORE_ASSETS.classWorkerURL.path} (${classWorkerResponse.status})`
    );
  }

  return {
    coreURL: chrome.runtime.getURL(LOCAL_CORE_ASSETS.coreURL.path),
    wasmURL: chrome.runtime.getURL(LOCAL_CORE_ASSETS.wasmURL.path),
    classWorkerURL: chrome.runtime.getURL(LOCAL_CORE_ASSETS.classWorkerURL.path)
  };
}

async function safeDelete(ffmpeg: FFmpeg, filePath: string): Promise<void> {
  try {
    await ffmpeg.deleteFile(filePath);
  } catch {
    return;
  }
}

function sanitizeFileName(fileName: string): string {
  return fileName.replaceAll(/[^\w.-]+/g, "_");
}

function buildCommandFailureMessage(commandName: string, exitCode: number, logs: string[]): string {
  const tail = logs.slice(-12).join("\n");
  return `${commandName} exited with code ${exitCode}${tail ? `\nRecent logs:\n${tail}` : ""}`;
}

function normalizeBinaryFileData(outputData: Uint8Array | string): Uint8Array {
  return outputData instanceof Uint8Array ? outputData : new TextEncoder().encode(outputData);
}

function copyBytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function formatBytes(byteLength: number): string {
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

function enrichWithRecentLogs(error: unknown, recentLogs: string[]): Error {
  if (error instanceof Error && !error.message.includes("Recent logs:")) {
    return new Error(`${error.message}\nRecent logs:\n${recentLogs.slice(-12).join("\n")}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function waitForLogFlush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
}
