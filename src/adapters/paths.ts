import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SourceId } from "../domain.js";

export function expandHomePath(value: string, home = homedir()): string {
  if (value === "~") return home;
  if (/^~[/\\]/.test(value)) return resolve(home, value.slice(2));
  return value;
}

export function sourceProfileDirectory(
  source: SourceId,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const suffix = source === "scribd" ? "PROFILE_DIR" : `${source.toUpperCase()}_PROFILE_DIR`;
  const configured = env[`DUCKDOWNLOADER_${suffix}`] || env[`SCRIBDDOCK_${suffix}`];
  if (configured) return resolve(expandHomePath(configured));
  const primary = join(homedir(), ".duckdownloader", "profiles", source);
  const legacy = join(homedir(), ".scribddock", "profiles", source);
  if (!existsSync(primary) && statSync(legacy, { throwIfNoEntry: false })?.isDirectory())
    return legacy;
  return primary;
}
