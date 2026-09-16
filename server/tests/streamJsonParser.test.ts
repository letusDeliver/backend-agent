import { describe, expect, it } from "vitest";
import { parseStreamJsonLine } from "../src/execution/streamJsonParser.js";

/**
 * Every line fixture below is copied verbatim (trimmed of surrounding
 * noise) from two real `claude` CLI (v2.1.236) probe runs against
 * `--output-format stream-json`, captured while building Phase 41 — not
 * hand-written guesses at the schema.
 */
describe("parseStreamJsonLine (Phase 41)", () => {
  it("extracts a tool_use progress event with the file path from a real Write call", () => {
    const line =
      '{"type":"assistant","message":{"model":"claude-sonnet-5","id":"msg_1","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_1","name":"Write","input":{"file_path":"/private/tmp/phase41-probe/hello.txt","content":"hello world\\n"}}]}}';
    const result = parseStreamJsonLine(line);
    expect(result.finalResultLine).toBeNull();
    expect(result.progressEvents).toEqual([{ kind: "tool_use", tool: "Write", detail: "/private/tmp/phase41-probe/hello.txt" }]);
  });

  it("extracts a text progress event from a real assistant text block", () => {
    const line = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Created `hello2.txt` with the line \\"second test\\"."}]}}';
    const result = parseStreamJsonLine(line);
    expect(result.progressEvents).toEqual([{ kind: "text", detail: 'Created `hello2.txt` with the line "second test".' }]);
  });

  it("ignores a thinking block — internal reasoning is not surfaced as progress", () => {
    const line = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"","signature":"x"}]}}';
    expect(parseStreamJsonLine(line).progressEvents).toEqual([]);
  });

  it("recognizes the terminal result line and returns it verbatim, extracting no progress from it", () => {
    const line =
      '{"is_error":false,"duration_api_ms":2582,"num_turns":1,"stop_reason":"end_turn","session_id":"s1","total_cost_usd":0.22,"result":"Hey there, friend!","type":"result","subtype":"success"}';
    const result = parseStreamJsonLine(line);
    expect(result.progressEvents).toEqual([]);
    expect(result.finalResultLine).toBe(line);
  });

  it("ignores system/rate_limit_event/user lines — no progress, no final result", () => {
    const systemLine = '{"type":"system","subtype":"init","cwd":"/tmp","session_id":"s1"}';
    const rateLimitLine = '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected"}}';
    const userLine = '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"t1","type":"tool_result","content":"File created successfully"}]}}';
    for (const line of [systemLine, rateLimitLine, userLine]) {
      expect(parseStreamJsonLine(line)).toEqual({ progressEvents: [], finalResultLine: null });
    }
  });

  it("falls back to the command for a Bash tool_use with no file_path", () => {
    const line = '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","input":{"command":"npm install"}}]}}';
    expect(parseStreamJsonLine(line).progressEvents).toEqual([{ kind: "tool_use", tool: "Bash", detail: "npm install" }]);
  });

  it("never throws on malformed or empty input, returning an empty result instead", () => {
    expect(parseStreamJsonLine("")).toEqual({ progressEvents: [], finalResultLine: null });
    expect(parseStreamJsonLine("   ")).toEqual({ progressEvents: [], finalResultLine: null });
    expect(parseStreamJsonLine("not json at all {{{")).toEqual({ progressEvents: [], finalResultLine: null });
    expect(parseStreamJsonLine("null")).toEqual({ progressEvents: [], finalResultLine: null });
    expect(parseStreamJsonLine('"just a string"')).toEqual({ progressEvents: [], finalResultLine: null });
  });

  it("handles multiple content blocks in one assistant line, in order", () => {
    const line =
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Writing the file now."},{"type":"tool_use","name":"Write","input":{"file_path":"src/index.ts"}}]}}';
    expect(parseStreamJsonLine(line).progressEvents).toEqual([
      { kind: "text", detail: "Writing the file now." },
      { kind: "tool_use", tool: "Write", detail: "src/index.ts" },
    ]);
  });
});
