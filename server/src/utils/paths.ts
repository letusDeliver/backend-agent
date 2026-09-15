import path from "node:path";
import { existsSync, statSync } from "node:fs";

export class InvalidRepositoryPathError extends Error {}

/**
 * Resolves a developer-supplied repository path and confirms it exists and is
 * a directory. Repository content is treated as untrusted evidence (Project
 * Memory §93), but the path itself must still be validated so the server
 * never silently inspects or later writes to an unintended location.
 */
export function resolveRepositoryPath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new InvalidRepositoryPathError("Repository path is required.");
  }
  const resolved = path.resolve(rawPath.trim());
  if (!existsSync(resolved)) {
    throw new InvalidRepositoryPathError(`Repository path does not exist: ${resolved}`);
  }
  if (!statSync(resolved).isDirectory()) {
    throw new InvalidRepositoryPathError(`Repository path is not a directory: ${resolved}`);
  }
  return resolved;
}

/**
 * Confines a task-workspace-relative write to the task's own directory,
 * rejecting any path segment that would escape it (e.g. `..`).
 */
export function resolveWithinRoot(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(resolvedRoot, relativePath);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new InvalidRepositoryPathError(`Path escapes workspace root: ${relativePath}`);
  }
  return resolvedTarget;
}

export function slugifyTaskTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 40);
}
