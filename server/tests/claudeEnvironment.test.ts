import { describe, expect, it } from "vitest";
import { buildClaudeEnvironment } from "../src/execution/claudeEnvironment.js";
import { config } from "../src/config.js";

describe("buildClaudeEnvironment (Phase 35)", () => {
  it("forwards every allow-listed variable that is present in the source environment", () => {
    const source: NodeJS.ProcessEnv = {};
    for (const key of config.claudeSubprocessEnvAllowList) {
      source[key] = `value-of-${key}`;
    }
    const built = buildClaudeEnvironment(source);
    for (const key of config.claudeSubprocessEnvAllowList) {
      expect(built[key]).toBe(`value-of-${key}`);
    }
  });

  it("never forwards a variable that is not on the allow-list, however sensitive-looking", () => {
    const source: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-should-not-leak",
      AWS_SECRET_ACCESS_KEY: "should-not-leak",
      DATABASE_PASSWORD: "should-not-leak",
      GITHUB_TOKEN: "should-not-leak",
      SSH_PRIVATE_KEY: "should-not-leak",
    };
    const built = buildClaudeEnvironment(source);
    expect(built.PATH).toBe("/usr/bin");
    expect(built).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(built).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(built).not.toHaveProperty("DATABASE_PASSWORD");
    expect(built).not.toHaveProperty("GITHUB_TOKEN");
    expect(built).not.toHaveProperty("SSH_PRIVATE_KEY");
  });

  it("omits an allow-listed key entirely when it is absent from the source environment, rather than forwarding an empty string", () => {
    const built = buildClaudeEnvironment({ PATH: "/usr/bin" });
    expect(built.PATH).toBe("/usr/bin");
    expect(built).not.toHaveProperty("HOME");
  });

  it("defaults to process.env when no source is given", () => {
    const previous = process.env.PATH;
    try {
      process.env.PATH = "/sentinel/path";
      const built = buildClaudeEnvironment();
      expect(built.PATH).toBe("/sentinel/path");
    } finally {
      process.env.PATH = previous;
    }
  });
});
