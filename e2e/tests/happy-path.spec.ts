import { test, expect } from "@playwright/test";
import path from "node:path";

const repositoryPath = path.resolve(__dirname, "../../server");

test("dashboard → create task → live SSE completion, zero console errors", async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

  await page.goto("/dashboard", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Backend Engineering AI" })).toBeVisible();

  await page.getByRole("link", { name: "+ New Backend Task" }).click();
  await expect(page.getByText("New Backend Task")).toBeVisible();

  await page.locator("#requirement").fill(
    "Add a GET /api/reports endpoint with PostgreSQL persistence and pagination"
  );
  await page.locator("#repository").fill(repositoryPath);
  await page.getByRole("button", { name: "Start Engineering" }).click();

  await page.waitForURL(/\/tasks\/.+/, { timeout: 15_000 });

  // The live execution timeline is driven entirely by real SSE events into
  // signals — waiting for the terminal badge exercises that whole pipeline,
  // not just the initial page render.
  await expect(page.locator(".status-badge")).toHaveText(/completed/i, { timeout: 30_000 });

  await expect(page.getByText("Task Complete")).toBeVisible();
  await expect(page.locator(".mode-banner")).toContainText("MOCK / SIMULATED EXECUTION");

  expect(consoleErrors, `Unexpected browser console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
});
