import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const sourceDir = path.join(rootDir, "src");
const publicDir = path.join(rootDir, "public");
const outputDir = path.join(rootDir, "dist");
const ffmpegCoreDir = path.join(rootDir, "node_modules", "@ffmpeg", "core", "dist", "esm");
const ffmpegRuntimeDir = path.join(rootDir, "node_modules", "@ffmpeg", "ffmpeg", "dist", "esm");

async function copyStaticAssets() {
  await cp(path.join(publicDir, "manifest.json"), path.join(outputDir, "manifest.json"));
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
