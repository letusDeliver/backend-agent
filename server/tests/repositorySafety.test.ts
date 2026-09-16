import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertSafeRepositoryPath } from "../src/utils/repositorySafety.js";
import { InvalidRepositoryPathError } from "../src/utils/paths.js";
import { config } from "../src/config.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "safety-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("assertSafeRepositoryPath", () => {
  it("allows an ordinary project directory", () => {
    expect(() => assertSafeRepositoryPath(dir)).not.toThrow();
  });

  it("allows a safe nested project directory", async () => {
    const nested = path.join(dir, "nested", "project");
    await mkdir(nested, { recursive: true });
    expect(() => assertSafeRepositoryPath(nested)).not.toThrow();
  });

  it("allows a relative path to a safe directory", () => {
    const relative = path.relative(process.cwd(), dir);
    expect(() => assertSafeRepositoryPath(relative)).not.toThrow();
  });

  it("allows an absolute path to a safe directory", () => {
    expect(() => assertSafeRepositoryPath(path.resolve(dir))).not.toThrow();
  });

  it("rejects the developer's home directory", () => {
    expect(() => assertSafeRepositoryPath(os.homedir())).toThrow(InvalidRepositoryPathError);
  });

  it("rejects the filesystem root", () => {
    expect(() => assertSafeRepositoryPath(path.parse(dir).root)).toThrow(InvalidRepositoryPathError);
  });

  it("rejects well-known system directories", () => {
    expect(() => assertSafeRepositoryPath("/etc")).toThrow(InvalidRepositoryPathError);
    expect(() => assertSafeRepositoryPath("/usr")).toThrow(InvalidRepositoryPathError);
  });

  it("rejects the platform's own source root", () => {
    expect(() => assertSafeRepositoryPath(config.repoRoot)).toThrow(InvalidRepositoryPathError);
  });

  it("rejects a directory inside the platform's own source root", () => {
    expect(() => assertSafeRepositoryPath(path.join(config.repoRoot, "server"))).toThrow(InvalidRepositoryPathError);
  });

  it("rejects an ancestor of the platform's own source root", () => {
    expect(() => assertSafeRepositoryPath(path.dirname(config.repoRoot))).toThrow(InvalidRepositoryPathError);
  });

  it("rejects a path that does not exist", () => {
    expect(() => assertSafeRepositoryPath(path.join(dir, "does-not-exist"))).toThrow(InvalidRepositoryPathError);
  });

  describe("symlink escapes (Phase 35)", () => {
    it("rejects a symlink whose canonical target is the home directory", async () => {
      const link = path.join(dir, "escape-to-home");
      await symlink(os.homedir(), link, "dir");
      expect(() => assertSafeRepositoryPath(link)).toThrow(InvalidRepositoryPathError);
    });

    it("rejects a symlink whose canonical target is a system directory", async () => {
      const link = path.join(dir, "escape-to-etc");
      await symlink("/etc", link, "dir");
      expect(() => assertSafeRepositoryPath(link)).toThrow(InvalidRepositoryPathError);
    });

    it("rejects a symlink whose canonical target is the platform's own source root", async () => {
      const link = path.join(dir, "escape-to-platform");
      await symlink(config.repoRoot, link, "dir");
      expect(() => assertSafeRepositoryPath(link)).toThrow(InvalidRepositoryPathError);
    });

    it("rejects a directory containing a symlink that itself points at a denied root, when that directory is passed directly", async () => {
      // Mirrors the top-level-path check this function performs: the symlink
      // *is* the repository path handed to real execution, not a file inside
      // an otherwise-safe repository (files inside a repo are out of scope
      // for this boundary — see docs/PHASE_35_PLATFORM_REVIEW.md).
      const nestedLink = path.join(dir, "nested-escape");
      await symlink("/usr", nestedLink, "dir");
      expect(() => assertSafeRepositoryPath(nestedLink)).toThrow(InvalidRepositoryPathError);
    });

    it("allows a symlink whose canonical target is itself a safe directory", async () => {
      const realTarget = path.join(dir, "real-project");
      await mkdir(realTarget);
      const link = path.join(dir, "link-to-real-project");
      await symlink(realTarget, link, "dir");
      expect(() => assertSafeRepositoryPath(link)).not.toThrow();
    });
  });
});
