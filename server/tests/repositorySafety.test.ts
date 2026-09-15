import { mkdtemp, rm } from "node:fs/promises";
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
});
