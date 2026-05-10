export const playerThemeStorageKey = "reader-sync-player-theme";

export type ReaderSyncThemeMode = "auto" | "light" | "dark";
export type ResolvedReaderSyncTheme = "light" | "dark";

export function sanitizeReaderSyncThemeMode(value: unknown): ReaderSyncThemeMode {
  return value === "light" || value === "dark" || value === "auto" ? value : "auto";
}

export function resolveReaderSyncThemeMode(mode: ReaderSyncThemeMode, prefersDark: boolean): ResolvedReaderSyncTheme {
  if (mode === "auto") {
    return prefersDark ? "dark" : "light";
  }
  return mode;
}
