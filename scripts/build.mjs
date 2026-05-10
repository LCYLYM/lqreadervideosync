import { cp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const sourceDir = path.join(rootDir, "src");
const publicDir = path.join(rootDir, "public");
const resourcesDir = path.join(rootDir, "resources");
const outputDir = path.join(rootDir, "dist");
const ffmpegCoreDir = path.join(rootDir, "node_modules", "@ffmpeg", "core", "dist", "esm");
const ffmpegRuntimeDir = path.join(rootDir, "node_modules", "@ffmpeg", "ffmpeg", "dist", "esm");

function normalizeTitleToken(value) {
  return value
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/g, "")
    .replace(/\b(2160p|uhd|bluray|blu|ray|remux|dv|hdr|hevc|dts|hd|ma|5|1|chi|ass|friends)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function buildSubtitleIndexEntry(fileName) {
  const match = fileName.match(/Friends\.S(\d{2})E(\d{2})\.(.*?)\.2160p/i);
  if (!match) {
    return null;
  }

  const season = Number.parseInt(match[1], 10);
  const episode = Number.parseInt(match[2], 10);
  const title = match[3].replace(/\./g, " ").trim();
  return {
    id: `S${match[1]}E${match[2]}`,
    season,
    episode,
    title,
    normalizedTitle: normalizeTitleToken(title),
    fileName,
    path: `resources/subtitles/${fileName}`
  };
}

async function buildSubtitleIndex(outputResourcesDir) {
  const subtitlesDir = path.join(resourcesDir, "subtitles");
  let entries = [];
  try {
    const fileNames = await readdir(subtitlesDir);
    entries = fileNames
      .filter((fileName) => fileName.toLowerCase().endsWith(".ass"))
      .map(buildSubtitleIndexEntry)
      .filter(Boolean)
      .sort((left, right) => {
        if (left.season !== right.season) {
          return left.season - right.season;
        }
        return left.episode - right.episode;
      });
  } catch (error) {
    if (error && error.code === "ENOENT") {
      entries = [];
    } else {
      throw error;
    }
  }

  await writeFile(
    path.join(outputResourcesDir, "subtitles-index.json"),
    `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), subtitles: entries }, null, 2)}\n`
  );
}

async function copyStaticAssets() {
  await cp(path.join(publicDir, "manifest.json"), path.join(outputDir, "manifest.json"));
  await cp(path.join(publicDir, "icons"), path.join(outputDir, "icons"), { recursive: true });
  await mkdir(path.join(outputDir, "resources"), { recursive: true });
  await cp(resourcesDir, path.join(outputDir, "resources"), { recursive: true });
  await buildSubtitleIndex(path.join(outputDir, "resources"));
  await mkdir(path.join(outputDir, "player"), { recursive: true });
  await cp(path.join(sourceDir, "player", "player.html"), path.join(outputDir, "player", "player.html"));
  await cp(path.join(sourceDir, "player", "player.css"), path.join(outputDir, "player", "player.css"));
  await mkdir(path.join(outputDir, "vendor", "ffmpeg"), { recursive: true });
  await cp(path.join(ffmpegCoreDir, "ffmpeg-core.js"), path.join(outputDir, "vendor", "ffmpeg", "ffmpeg-core.js"));
  await cp(path.join(ffmpegCoreDir, "ffmpeg-core.wasm"), path.join(outputDir, "vendor", "ffmpeg", "ffmpeg-core.wasm"));
  await cp(path.join(ffmpegRuntimeDir), path.join(outputDir, "vendor", "ffmpeg-runtime"), { recursive: true });
}

async function build() {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  await esbuild.build({
    entryPoints: {
      "background/service-worker": path.join(sourceDir, "background", "service-worker.ts"),
      "content/index": path.join(sourceDir, "content", "index.ts"),
      "player/player": path.join(sourceDir, "player", "player.ts")
    },
    bundle: true,
    outdir: outputDir,
    format: "esm",
    target: "chrome120",
    platform: "browser",
    sourcemap: true,
    logLevel: "info"
  });

  await copyStaticAssets();
}

build().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
