import { spawn } from "node:child_process";
import { exec as execCb } from "node:child_process";
import { promisify } from "node:util";
import { config } from "../config.js";
import type {
  ClaudeCodeExecutor,
  AnalyzeParams,
  ImplementParams,
  ReviewParams,
  RunTestsParams,
} from "./ClaudeCodeExecutor.js";
import type { ExecutionReport, ReviewReport, SpecialistReport, TestRunResult } from "../types/index.js";

const exec = promisify(execCb);

class ClaudeCliError extends Error {}

/**
 * Shells out to the local `claude` CLI in non-interactive print mode
 * (`claude -p ... --output-format json`). This is real Claude Code
 * execution: it can read the target repository and — for implement() —
 * actually modify files on disk. It is only ever instantiated when
 * CLAUDE_EXECUTION_MODE=real is explicitly set (see config.ts); the server
 * never falls into this path by default.
 */
export class RealClaudeCodeExecutor implements ClaudeCodeExecutor {
  readonly mode = "real" as const;

  private async runClaudeCli(prompt: string, cwd: string, permissionMode: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--permission-mode",
        permissionMode,
        "--add-dir",
        cwd,
      ];
      const child = spawn(config.claudeCliPath, args, { cwd, timeout: config.claudeTimeoutMs });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
      child.on("error", (err) => reject(new ClaudeCliError(`Failed to launch claude CLI: ${err.message}`)));
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new ClaudeCliError(`claude CLI exited with code ${code}: ${stderr.slice(0, 2000)}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  private parseResultText(stdout: string): string {
    let envelope: { result?: string; subtype?: string };
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw new ClaudeCliError("claude CLI did not return valid JSON output.");
    }
    if (!envelope.result) {
      throw new ClaudeCliError(`claude CLI response had no result field (subtype: ${envelope.subtype ?? "unknown"}).`);
    }
    return envelope.result;
  }

  private extractJsonPayload<T>(resultText: string): T {
    const fenced = resultText.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : resultText;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new ClaudeCliError("Could not locate a JSON object in the claude CLI response.");
    }
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  }

  async analyze({ agent, task, detectedStack, specialistContract, question }: AnalyzeParams): Promise<SpecialistReport> {
    const prompt = [
      `You are acting as the ${agent} specialist under this contract:`,
      specialistContract,
      "",
      `Task: ${task.title}`,
      `Requirement: ${task.requirement}`,
      `Detected stack: ${JSON.stringify(detectedStack)}`,
      `Specific question from the orchestrator: ${question}`,
      "",
      "Inspect the repository at the current working directory as needed (read-only — do not modify files).",
      "Respond with ONLY a JSON object of this exact shape, no prose outside it:",
      '{"recommendation": string, "findings": [{"summary": string, "evidence": string}], "risks": [{"summary": string, "severity": "low"|"medium"|"high"}], "assumptions": string[], "confidence": number between 0 and 1}',
    ].join("\n");

    try {
      const stdout = await this.runClaudeCli(prompt, task.repository, "plan");
      const resultText = this.parseResultText(stdout);
      const payload = this.extractJsonPayload<Pick<SpecialistReport, "recommendation" | "findings" | "risks" | "assumptions" | "confidence">>(resultText);
      return {
        agent,
        taskId: task.id,
        status: "completed",
        recommendation: payload.recommendation,
        findings: payload.findings,
        risks: payload.risks,
        assumptions: payload.assumptions,
        confidence: payload.confidence,
        executionMode: "real",
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        agent,
        taskId: task.id,
        status: "failed",
        recommendation: "",
        findings: [],
        risks: [],
        assumptions: [`Real execution failed: ${(err as Error).message}`],
        confidence: 0,
        executionMode: "real",
        createdAt: new Date().toISOString(),
      };
    }
  }

  async implement({ task, plan, detectedStack }: ImplementParams): Promise<ExecutionReport> {
    const prompt = [
      `Implement the following reconciled engineering plan inside this repository.`,
      `Task: ${task.title}`,
      `Requirement: ${task.requirement}`,
      `Detected stack: ${JSON.stringify(detectedStack)}`,
      `Plan summary: ${plan.summary}`,
      `Expected files: ${plan.files.map((f) => `${f.path} — ${f.description}`).join("; ")}`,
      "",
      "Make the smallest reviewable change that satisfies the requirement, following existing repository conventions.",
      "After implementing, respond with ONLY a JSON object of this exact shape, no prose outside it:",
      '{"changedFiles": string[], "commandsExecuted": string[], "notes": string[]}',
    ].join("\n");

    try {
      const stdout = await this.runClaudeCli(prompt, task.repository, "acceptEdits");
      const resultText = this.parseResultText(stdout);
      const payload = this.extractJsonPayload<{ changedFiles: string[]; commandsExecuted: string[]; notes: string[] }>(resultText);
      return {
        taskId: task.id,
        executionMode: "real",
        status: "completed",
        changedFiles: payload.changedFiles,
        tests: [],
        commandsExecuted: payload.commandsExecuted,
        notes: payload.notes,
        createdAt: new Date().toISOString(),
      };
    } catch (err) {
      return {
        taskId: task.id,
        executionMode: "real",
        status: "failed",
        changedFiles: [],
        tests: [],
        commandsExecuted: [],
        notes: [`Real execution failed: ${(err as Error).message}`],
        createdAt: new Date().toISOString(),
      };
    }
  }

  async runTests({ task, detectedStack }: RunTestsParams): Promise<TestRunResult[]> {
    if (!detectedStack.testCommand) {
      return [
        {
          command: "(none detected)",
          status: "skipped",
          passed: 0,
          failed: 0,
          evidenceRef: "no-test-command-detected",
        },
      ];
    }
    try {
      const { stdout } = await exec(detectedStack.testCommand, {
        cwd: task.repository,
        timeout: config.claudeTimeoutMs,
      });
      const passedMatch = stdout.match(/(\d+)\s+passed/i);
      const failedMatch = stdout.match(/(\d+)\s+failed/i);
      return [
        {
          command: detectedStack.testCommand,
          status: failedMatch && Number(failedMatch[1]) > 0 ? "failed" : "passed",
          passed: passedMatch ? Number(passedMatch[1]) : 0,
          failed: failedMatch ? Number(failedMatch[1]) : 0,
          evidenceRef: stdout.slice(-4000),
        },
      ];
    } catch (err) {
      const execErr = err as { stdout?: string; stderr?: string };
      return [
        {
          command: detectedStack.testCommand,
          status: "failed",
          passed: 0,
          failed: 0,
          evidenceRef: `${execErr.stdout ?? ""}\n${execErr.stderr ?? (err as Error).message}`.slice(-4000),
        },
      ];
    }
  }

  async review({ agent, task, specialistContract, plan, executionReport, attempt }: ReviewParams): Promise<ReviewReport> {
    const prompt = [
      `You are acting as the ${agent} specialist reviewing an implementation, under this contract:`,
      specialistContract,
      "",
      `Task: ${task.title}`,
      `Plan: ${plan.summary}`,
      `Files changed: ${executionReport.changedFiles.join(", ") || "(none reported)"}`,
      `Test evidence: ${JSON.stringify(executionReport.tests)}`,
      "",
      "Review the actual current state of the repository (read-only — do not modify files) for correctness, security, scope discipline and architecture adherence.",
      "Respond with ONLY a JSON object of this exact shape, no prose outside it:",
      '{"status": "PASS"|"FAIL", "findings": [{"summary": string, "severity": "warning"|"blocking", "location": string, "recommendation": string}]}',
    ].join("\n");

    try {
      const stdout = await this.runClaudeCli(prompt, task.repository, "plan");
      const resultText = this.parseResultText(stdout);
      const payload = this.extractJsonPayload<{ status: "PASS" | "FAIL"; findings: ReviewReport["findings"] }>(resultText);
      return {
        agent,
        taskId: task.id,
        status: payload.status,
        findings: payload.findings,
        executionMode: "real",
        createdAt: new Date().toISOString(),
        attempt,
      };
    } catch (err) {
      return {
        agent,
        taskId: task.id,
        status: "FAIL",
        findings: [
          {
            summary: `Real review execution failed: ${(err as Error).message}`,
            severity: "blocking",
            recommendation: "Re-run the review once the underlying error is resolved.",
          },
        ],
        executionMode: "real",
        createdAt: new Date().toISOString(),
        attempt,
      };
    }
  }
}
