import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { chromium } from "playwright-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(__dirname, "..");

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const current = process.argv[index];
  if (!current.startsWith("--")) {
    continue;
  }
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) {
    args.set(current.slice(2), "1");
    continue;
  }
  args.set(current.slice(2), next);
  index += 1;
}

const targetUrl = args.get("target-url") ?? "https://aim-read.top/daily-feed/319?categoryId=60";
const authStatePath = path.resolve(extensionRoot, args.get("auth-state-path") ?? ".tmp/aim-read-auth-state.json");
const userDataDir = path.resolve(extensionRoot, args.get("user-data-dir") ?? ".tmp/aim-read-auth-profile");
const browserChannel = args.get("browser-channel") ?? "chromium";
const browserExecutablePath = args.get("browser-executable-path") ?? null;
const proxyServer = args.get("proxy-server") ?? null;

function log(message, metadata) {
  if (metadata === undefined) {
    console.log(`[refresh-aim-read-auth] ${message}`);
    return;
  }
  console.log(`[refresh-aim-read-auth] ${message}`, metadata);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (browserExecutablePath && !(await fileExists(browserExecutablePath))) {
    throw new Error(`Browser executable not found: ${browserExecutablePath}`);
  }

  await fs.mkdir(userDataDir, { recursive: true });
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: browserChannel,
    executablePath: browserExecutablePath ?? undefined,
    headless: false,
    args: [...(proxyServer ? [`--proxy-server=${proxyServer}`] : [])]
  });

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    log("Opened aim-read page. If redirected to login, finish login in this browser window.", {
      targetUrl,
      currentUrl: page.url()
    });

    await page.waitForURL((url) => {
      const value = url.toString();
      return value.startsWith(targetUrl) && !value.includes("/login");
    }, { timeout: 0 });

    await page.waitForLoadState("domcontentloaded", { timeout: 120000 }).catch(() => {});
    await fs.mkdir(path.dirname(authStatePath), { recursive: true });
    await context.storageState({ path: authStatePath, indexedDB: true });
    log("Saved fresh aim-read auth state", { authStatePath, userDataDir });
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error("[refresh-aim-read-auth] failed", error);
  process.exitCode = 1;
});
