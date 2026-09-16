import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { combinedRequirementText, readRequirementDocs } from "../src/orchestrator/requirementDocs.js";
import { config } from "../src/config.js";

describe("readRequirementDocs (Phase 38)", () => {
  let repoDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    repoDir = await mkdtemp(path.join(tmpdir(), "reqdocs-repo-"));
    outsideDir = await mkdtemp(path.join(tmpdir(), "reqdocs-outside-"));
  });

  afterEach(async () => {
    await rm(repoDir, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });

  it("reads a real file's content verbatim", async () => {
    await mkdir(path.join(repoDir, "docs"), { recursive: true });
    await writeFile(path.join(repoDir, "docs", "requirements.md"), "# Login flow\nUse JWT auth.");

    const [doc] = await readRequirementDocs(repoDir, ["docs/requirements.md"]);
    expect(doc.readError).toBeUndefined();
    expect(doc.content).toBe("# Login flow\nUse JWT auth.");
    expect(doc.truncated).toBe(false);
    expect(doc.totalChars).toBe(doc.content.length);
  });

  it("reports a missing file as a readError rather than throwing", async () => {
    const [doc] = await readRequirementDocs(repoDir, ["docs/does-not-exist.md"]);
    expect(doc.readError).toMatch(/not found/i);
    expect(doc.content).toBe("");
  });

  it("truncates a document larger than the configured limit, but reports the real total", async () => {
    const original = config.maxRequirementDocChars;
    config.maxRequirementDocChars = 10;
    try {
      await writeFile(path.join(repoDir, "big.md"), "0123456789ABCDEF");
      const [doc] = await readRequirementDocs(repoDir, ["big.md"]);
      expect(doc.truncated).toBe(true);
      expect(doc.content).toBe("0123456789");
      expect(doc.totalChars).toBe(16);
    } finally {
      config.maxRequirementDocChars = original;
    }
  });

  it("refuses a path that escapes the repository via traversal", async () => {
    await writeFile(path.join(outsideDir, "secret.txt"), "top secret");
    const [doc] = await readRequirementDocs(repoDir, ["../" + path.basename(outsideDir) + "/secret.txt"]);
    expect(doc.readError).toMatch(/escapes the repository/i);
    expect(doc.content).toBe("");
  });

  it("refuses a symlink that resolves outside the repository", async () => {
    await writeFile(path.join(outsideDir, "secret.txt"), "top secret");
    await symlink(path.join(outsideDir, "secret.txt"), path.join(repoDir, "innocuous.md"));

    const [doc] = await readRequirementDocs(repoDir, ["innocuous.md"]);
    expect(doc.readError).toMatch(/symlink/i);
    expect(doc.content).toBe("");
  });

  it("reads multiple docs independently — one failure doesn't affect the others", async () => {
    await writeFile(path.join(repoDir, "a.md"), "doc A content");
    const docs = await readRequirementDocs(repoDir, ["a.md", "missing.md"]);
    expect(docs).toHaveLength(2);
    expect(docs[0].content).toBe("doc A content");
    expect(docs[1].readError).toBeTruthy();
  });
});

describe("combinedRequirementText (Phase 38)", () => {
  it("returns the requirement unchanged when there are no docs", () => {
    expect(combinedRequirementText("Build a login endpoint.", undefined)).toBe("Build a login endpoint.");
    expect(combinedRequirementText("Build a login endpoint.", [])).toBe("Build a login endpoint.");
  });

  it("appends every successfully-read doc's content, skipping nothing but not crashing on read errors", () => {
    const result = combinedRequirementText("Build the backend.", [
      { path: "a.md", content: "Use FastAPI and PostgreSQL.", truncated: false, totalChars: 27 },
      { path: "b.md", content: "", truncated: false, totalChars: 0, readError: "File not found." },
    ]);
    expect(result).toContain("Build the backend.");
    expect(result).toContain("Use FastAPI and PostgreSQL.");
  });
});
