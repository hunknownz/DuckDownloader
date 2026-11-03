import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sourceProfileDirectory } from "../src/adapters/paths.js";

const home = vi.hoisted(() => ({ path: "" }));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  homedir: () => home.path,
}));

beforeEach(async () => {
  home.path = await mkdtemp(join(tmpdir(), "duckdownloader-profile-path-"));
});
afterEach(async () => {
  await rm(home.path, { recursive: true, force: true });
});

it.each(["scribd", "wechat", "feishu"] as const)(
  "keeps %s profiles separate under the new name",
  (source) => {
    expect(sourceProfileDirectory(source, {})).toBe(
      join(home.path, ".duckdownloader", "profiles", source),
    );
  },
);

it.each(["scribd", "wechat", "feishu"] as const)(
  "accepts new and legacy overrides for %s with new-name precedence",
  (source) => {
    const suffix = source === "scribd" ? "PROFILE_DIR" : `${source.toUpperCase()}_PROFILE_DIR`;
    const legacy = { [`SCRIBDDOCK_${suffix}`]: "~/existing session" };
    expect(sourceProfileDirectory(source, legacy)).toBe(join(home.path, "existing session"));
    expect(
      sourceProfileDirectory(source, { ...legacy, [`DUCKDOWNLOADER_${suffix}`]: "~/new session" }),
    ).toBe(join(home.path, "new session"));
  },
);

it("reuses an existing legacy profile without copying credentials and prefers a new profile once present", async () => {
  const oldProfile = join(home.path, ".scribddock", "profiles", "feishu");
  const newProfile = join(home.path, ".duckdownloader", "profiles", "feishu");
  await mkdir(oldProfile, { recursive: true });
  expect(sourceProfileDirectory("feishu", {})).toBe(oldProfile);
  expect(
    sourceProfileDirectory("feishu", { DUCKDOWNLOADER_FEISHU_PROFILE_DIR: "~/explicit" }),
  ).toBe(join(home.path, "explicit"));
  await mkdir(newProfile, { recursive: true });
  expect(sourceProfileDirectory("feishu", {})).toBe(newProfile);
});
