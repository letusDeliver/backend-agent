import { test, expect } from "@playwright/test";
import path from "node:path";

/**
 * Reaches a genuinely `blocked` task through a real, supported application
 * boundary (task creation + start against a fixture repository with no
 * detectable stack), rather than swapping in a fixture executor — the mock
 * executor's routing decision is deterministic and identical in mock and
 * real mode, so this exercises the actual production code path
 * (Phase 34: TaskOrchestrator.block() at the routing stage) in a real
 * browser. This suite is mock-executor-only, same as happy-path.spec.ts —
 * it does not and cannot claim to exercise a real Claude Code failure.
 */
const ambiguousRepositoryPath = path.resolve(__dirname, "../fixtures/ambiguous-repo");

test("blocked task shows a truthful Outcome, a correct stage timeline, and no console errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto("/dashboard", { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "+ New Backend Task" }).click();
  await expect(page.getByText("New Backend Task")).toBeVisible();

  await page.locator("#requirement").fill("Improve the documentation clarity.");
  await page.locator("#repository").fill(ambiguousRepositoryPath);
  await page.getByRole("button", { name: "Start Engineering" }).click();

  await page.waitForURL(/\/tasks\/.+/, { timeout: 15_000 });
  await expect(page.locator(".status-badge")).toHaveText(/blocked/i, { timeout: 15_000 });

  // Outcome (Phase 34): a truthful, deterministic sentence — not an
  // inferred root cause — naming the real stage the task stopped at.
  await expect(page.getByRole("heading", { name: "Outcome" })).toBeVisible();
  await expect(page.getByText("Task is blocked at specialist routing.")).toBeVisible();
  await expect(page.getByText("No specialist analysis or later artifacts were produced before this happened.")).toBeVisible();

  // Stage timeline (Phase 34 bug fix): earlier stages marked done, the
  // stage the task actually stopped at marked with the "stopped" (✕)
  // state — previously every stage rendered as not-yet-reached for every
  // blocked task, regardless of real progress.
  const timelineRows = page.locator(".timeline-row");
  await expect(timelineRows.filter({ hasText: "Task created" })).toHaveClass(/state-done/);
  await expect(timelineRows.filter({ hasText: "Repository inspected" })).toHaveClass(/state-done/);
  await expect(timelineRows.filter({ hasText: "Specialists selected" })).toHaveClass(/state-stopped/);
  await expect(timelineRows.filter({ hasText: "Specialists analyzing" })).toHaveClass(/state-pending/);

  expect(consoleErrors, `Unexpected browser console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
