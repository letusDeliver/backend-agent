import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../src/types/index.js";
import type { GitWorktreeManager } from "../src/execution/gitWorktree.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

const { RealClaudeCodeExecutor } = await import("../src/execution/RealClaudeCodeExecutor.js");

function makeFakeChild() {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn((signal: string) => {
    child.signalCode = signal;
  });
  return child;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Add a health route",
    requirement: "Add a GET /health endpoint.",
    repository: "/dev/original-repo",
    status: "analyzing",
    detectedStack: null,
    selectedAgents: ["node-backend"],
    currentStage: "analyzing",
    executionMode: "real",
    reviewRetryCount: 0,
    attempt: 1,
    executionWorkspace: {
      workspacePath: "/tasks/t1/workspace",
      branch: "agent/task-t1",
      baseRevision: "abc123",
      status: "ready",
      createdAt: "now",
    },
    createdAt: "now",
    updatedAt: "now",
    ...overrides,
  };
}

const stack = {
  language: "node" as const,
  packageManager: "npm",
  framework: null,
  database: null,
  testCommand: null,
  lintCommand: null,
  typecheckCommand: null,
  evidence: [],
};

/**
 * The extra type/subtype fields make this envelope shape valid for both
 * analyze()'s batch --output-format json path (which only ever reads
 * `.result`, ignoring anything else) and implement()'s streaming
 * --output-format stream-json path (Phase 41), which requires
 * `type: "result"` to recognize this as the terminal line.
 */
function respond(child: ReturnType<typeof makeFakeChild>, json: unknown) {
  child.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "success", result: "```json\n" + JSON.stringify(json) + "\n```" })));
  child.emit("close", 0, null);
}

beforeEach(() => {
  spawnMock.mockReset();
});

describe("RealClaudeCodeExecutor — process invocation", () => {
  it("analyze() runs in plan mode against the isolated workspace, never the original repository path", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const executor = new RealClaudeCodeExecutor({} as GitWorktreeManager);
    const task = makeTask();

    const promise = executor.analyze({
      agent: "node-backend",
      task,
      detectedStack: stack,
      specialistContract: "contract",
      question: "how?",
      memoryContext: [],
    });

    await Promise.resolve();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args, options] = spawnMock.mock.calls[0];
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(options.cwd).toBe("/tasks/t1/workspace");
    expect(options.cwd).not.toBe(task.repository);

    respond(child, { recommendation: "x", findings: [], risks: [], assumptions: [], confidence: 0.5 });

    const report = await promise;
    expect(report.status).toBe("completed");
    expect(report.recommendation).toBe("x");
    expect(report.executionMode).toBe("real");
  });

  it("implement() runs in acceptEdits mode and derives changedFiles/diff from the worktree manager, not the CLI's self-report", async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);
    const worktrees = {
      commitChanges: vi.fn().mockResolvedValue({ committed: true }),
      diff: vi.fn().mockResolvedValue({
        files: [{ path: "real-file.ts", additions: 3, deletions: 0 }],
        summary: "1 file changed, 3 insertions(+)",
      }),
    } as unknown as GitWorktreeManager;
    const executor = new RealClaudeCodeExecutor(worktrees);
    const task = makeTask({ currentStage: "implementing", status: "implementing" });

    const promise = executor.implement({
      task,
      plan: { taskId: "t1", summary: "s", files: [], validationCommands: [], createdAt: "now" },
      detectedStack: stack,
    });

    await Promise.resolve();
    const [, args, options] = spawnMock.mock.calls[0];
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("acceptEdits");
    expect(options.cwd).toBe("/tasks/t1/workspace");

    // The CLI self-reports a totally different file — the executor must
    // ignore that in favor of the git-diff-derived ground truth.
    respond(child, { changedFiles: ["claude-said-this.ts"], commandsExecuted: [], notes: [] });

    const report = await promise;
    expect(report.changedFiles).toEqual(["real-file.ts"]);
    expect(report.changedFiles).not.toContain("claude-said-this.ts");
    expect(report.diff?.branch).toBe("agent/task-t1");
    expect(worktrees.commitChanges).toHaveBeenCalledWith("/tasks/t1/workspace", expect.stringContaining("Task ID: t1"));
  });

  it("refuses to run — without spawning any process — when no isolated workspace is present", async () => {
    const executor = new RealClaudeCodeExecutor({} as GitWorktreeManager);
    const task = makeTask({ executionWorkspace: undefined });

    const report = await executor.analyze({
      agent: "node-backend",
      task,
      detectedStack: stack,
      specialistContract: "contract",
      question: "how?",
      memoryContext: [],
    });

    expect(spawnMock).not.toHaveBeenCalled();
    expect(report.status).toBe("failed");
    expect(report.assumptions.join(" ")).toMatch(/isolated workspace/i);
  });

  it("cancel() sends SIGTERM to the tracked in-flight process for that task, and leaves other tasks' processes alone", async () => {
    const childA = makeFakeChild();
    const childB = makeFakeChild();
    spawnMock.mockReturnValueOnce(childA).mockReturnValueOnce(childB);
    const executor = new RealClaudeCodeExecutor({} as GitWorktreeManager);

    void executor.analyze({
      agent: "node-backend",
      task: makeTask({ id: "task-a", executionWorkspace: { ...makeTask().executionWorkspace!, workspacePath: "/a" } }),
      detectedStack: stack,
      specialistContract: "c",
      question: "q",
      memoryContext: [],
    });
    void executor.analyze({
      agent: "node-backend",
      task: makeTask({ id: "task-b", executionWorkspace: { ...makeTask().executionWorkspace!, workspacePath: "/b" } }),
      detectedStack: stack,
      specialistContract: "c",
      question: "q",
      memoryContext: [],
    });
    await Promise.resolve();

    executor.cancel("task-a");
    expect(childA.kill).toHaveBeenCalledWith("SIGTERM");
    expect(childB.kill).not.toHaveBeenCalled();
  });
});
