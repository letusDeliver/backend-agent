import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectRepository } from "../src/orchestrator/repositoryInspector.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "repo-inspector-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("inspectRepository", () => {
  it("detects a Node + Express + PostgreSQL repository from package.json", async () => {
    await writeFile(
      path.join(dir, "package.json"),
      JSON.stringify({
        dependencies: { express: "^4.0.0", pg: "^8.0.0" },
        devDependencies: { typescript: "^5.0.0" },
        scripts: { test: "vitest run", lint: "eslint ." },
      })
    );
    const stack = await inspectRepository(dir);
    expect(stack.language).toBe("node");
    expect(stack.framework).toBe("Express");
    expect(stack.database).toBe("PostgreSQL");
    expect(stack.testCommand).toBe("npm test");
    expect(stack.typecheckCommand).toBe("npx tsc --noEmit");
  });

  it("detects a Python + FastAPI + PostgreSQL repository from requirements.txt", async () => {
    await writeFile(path.join(dir, "requirements.txt"), "fastapi\nsqlalchemy\npytest\n");
    const stack = await inspectRepository(dir);
    expect(stack.language).toBe("python");
    expect(stack.framework).toBe("FastAPI");
    expect(stack.database).toBe("PostgreSQL");
    expect(stack.testCommand).toBe("pytest");
  });

  it("returns an unknown stack with evidence when no manifest is present", async () => {
    const stack = await inspectRepository(dir);
    expect(stack.language).toBe("unknown");
    expect(stack.evidence.length).toBeGreaterThan(0);
  });

  it("does not report a database when no persistence dependency is present", async () => {
    await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { express: "^4.0.0" } }));
    const stack = await inspectRepository(dir);
    expect(stack.database).toBeNull();
  });
});
