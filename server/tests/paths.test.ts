import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InvalidRepositoryPathError, resolveRepositoryPath, resolveWithinRoot } from "../src/utils/paths.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "paths-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveRepositoryPath", () => {
  it("resolves an existing directory", () => {
    expect(resolveRepositoryPath(dir)).toBe(path.resolve(dir));
  });

  it("rejects an empty path", () => {
    expect(() => resolveRepositoryPath("")).toThrow(InvalidRepositoryPathError);
  });

  it("rejects a path that does not exist", () => {
    expect(() => resolveRepositoryPath(path.join(dir, "does-not-exist"))).toThrow(InvalidRepositoryPathError);
  });

  it("rejects a path that is a file, not a directory", async () => {
    const { writeFile } = await import("node:fs/promises");
    const filePath = path.join(dir, "file.txt");
    await writeFile(filePath, "hello");
    expect(() => resolveRepositoryPath(filePath)).toThrow(InvalidRepositoryPathError);
  });
});

describe("resolveWithinRoot", () => {
  it("allows a path inside the root", () => {
    expect(resolveWithinRoot(dir, "sub/file.json")).toBe(path.resolve(dir, "sub/file.json"));
  });

  it("rejects a path that escapes the root via ..", () => {
    expect(() => resolveWithinRoot(dir, "../../etc/passwd")).toThrow(InvalidRepositoryPathError);
  });
});
