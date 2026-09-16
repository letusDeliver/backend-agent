import { readFile, realpath } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import type { RequirementDocExcerpt } from "../types/index.js";

/**
 * Reads every doc a task points at (`Task.requirementDocPaths`) from the
 * target repository, deterministically, once, at inspection time — before
 * routing or any specialist call runs (Phase 38). This exists so a
 * developer who already documented their requirement in the repo (a
 * README, a `docs/login-flow.md`, a task list) doesn't have to re-paste it
 * into the requirement field, and so that routing — which only ever sees
 * `task.requirement` plus this — isn't blind to what's actually being
 * asked for.
 *
 * Each path is resolved and contained the same way `resolveWithinRoot`
 * confines artifact writes, plus an `fs.realpath` check (the Phase 35
 * symlink-safety convention) before the file is trusted — a path that
 * escapes the repository, by traversal or by symlink, is refused, never
 * silently followed.
 */
export async function readRequirementDocs(repositoryPath: string, docPaths: string[]): Promise<RequirementDocExcerpt[]> {
  const results: RequirementDocExcerpt[] = [];
  for (const rawPath of docPaths) {
    results.push(await readOneDoc(repositoryPath, rawPath));
  }
  return results;
}

async function readOneDoc(repositoryPath: string, rawPath: string): Promise<RequirementDocExcerpt> {
  const resolvedRoot = path.resolve(repositoryPath);
  const resolvedCandidate = path.resolve(resolvedRoot, rawPath);
  const withinRoot = resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + path.sep);

  if (!withinRoot) {
    return emptyExcerpt(rawPath, "Path escapes the repository root and was refused.");
  }
  if (!existsSync(resolvedCandidate)) {
    return emptyExcerpt(rawPath, "File not found in the repository.");
  }

  try {
    // The repository root itself may sit under a symlink (e.g. macOS's
    // /tmp -> /private/tmp) — realpath *both* sides before comparing, or a
    // perfectly legitimate file would false-positive as "escaping."
    const rootReal = await realpath(resolvedRoot);
    const real = await realpath(resolvedCandidate);
    const realWithinRoot = real === rootReal || real.startsWith(rootReal + path.sep);
    if (!realWithinRoot) {
      return emptyExcerpt(rawPath, "Path resolves outside the repository root (symlink) and was refused.");
    }

    const raw = await readFile(real, "utf-8");
    const truncated = raw.length > config.maxRequirementDocChars;
    return {
      path: rawPath,
      content: truncated ? raw.slice(0, config.maxRequirementDocChars) : raw,
      truncated,
      totalChars: raw.length,
    };
  } catch (err) {
    return emptyExcerpt(rawPath, `Could not read file: ${(err as Error).message}`);
  }
}

function emptyExcerpt(rawPath: string, readError: string): RequirementDocExcerpt {
  return { path: rawPath, content: "", truncated: false, totalChars: 0, readError };
}

/**
 * The text routing/decideDirection() reason over — the requirement plus
 * every successfully-read doc's content, so a keyword like "python" or
 * "postgres" sitting only inside a referenced doc still reaches these
 * deterministic, pre-execution decision points. Docs that failed to read
 * contribute nothing (their `content` is already empty).
 */
export function combinedRequirementText(requirement: string, docs: RequirementDocExcerpt[] | undefined): string {
  if (!docs || docs.length === 0) return requirement;
  return `${requirement} ${docs.map((d) => d.content).join(" ")}`;
}
