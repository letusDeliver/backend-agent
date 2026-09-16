/**
 * Parses `claude --output-format stream-json` NDJSON output (Phase 41).
 * The exact line shapes here were captured empirically from the real
 * `claude` CLI (v2.1.236) — not guessed — via two probe runs: a plain-text
 * prompt and a prompt that writes a file, both piped through
 * `--output-format stream-json`. Deliberately consumes only the
 * fully-formed `"assistant"` message lines (whose `content` blocks are
 * already complete, valid objects), not the intermediate `"stream_event"`
 * `content_block_delta` fragments `--include-partial-messages` would add —
 * this platform only needs "which tool, touching what" as soon as a tool
 * call is decided, not character-by-character text deltas, so that flag is
 * deliberately omitted from the spawn args in RealClaudeCodeExecutor.
 */

export interface ImplementProgressEvent {
  kind: "tool_use" | "text";
  /** The tool name (e.g. "Write", "Edit", "Bash") — only present for kind "tool_use". */
  tool?: string;
  /** A file path, command, or other short human-readable detail. */
  detail: string;
}

export interface ParsedStreamLine {
  progressEvents: ImplementProgressEvent[];
  /**
   * The raw terminal `"result"` line, verbatim — structurally identical to
   * the single-object envelope `--output-format json` (non-streaming)
   * already produces (`{result, subtype, ...}`), so it can be handed to
   * the exact same `parseResultText()`/`extractJsonPayload()` this
   * platform already uses for the non-streaming path, unchanged.
   */
  finalResultLine: string | null;
}

const EMPTY: ParsedStreamLine = { progressEvents: [], finalResultLine: null };

/**
 * Never throws — a malformed or unrecognized line is silently skipped
 * (returns no progress events, no final line) rather than aborting an
 * otherwise-successful implementation pass over one line the platform
 * doesn't understand. The `claude` CLI's own NDJSON stream is trusted to be
 * well-formed per-line; this defends against a future CLI version adding
 * line shapes this parser doesn't yet know about, not against malice.
 */
export function parseStreamJsonLine(rawLine: string): ParsedStreamLine {
  const line = rawLine.trim();
  if (!line) return EMPTY;

  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return EMPTY;
  }
  if (typeof obj !== "object" || obj === null) return EMPTY;
  const record = obj as Record<string, unknown>;

  if (record.type === "result") {
    return { progressEvents: [], finalResultLine: line };
  }

  if (record.type !== "assistant") return EMPTY;
  const message = record.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (!Array.isArray(content)) return EMPTY;

  const progressEvents: ImplementProgressEvent[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "tool_use") {
      const input = (b.input as Record<string, unknown>) ?? {};
      const detail = input.file_path ?? input.path ?? input.command ?? JSON.stringify(input).slice(0, 200);
      progressEvents.push({
        kind: "tool_use",
        tool: typeof b.name === "string" ? b.name : "tool",
        detail: String(detail),
      });
    } else if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
      progressEvents.push({ kind: "text", detail: b.text.trim().slice(0, 300) });
    }
    // Other block types (e.g. "thinking") are deliberately not surfaced as
    // progress — internal reasoning, not an observable action.
  }
  return { progressEvents, finalResultLine: null };
}
