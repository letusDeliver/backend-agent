import { readFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import type { DetectedStack } from "../types/index.js";

/**
 * Implements skills/repository-inspection.md: identify language/runtime,
 * package manager, framework, database/persistence, and test/lint/typecheck
 * commands from real repository evidence rather than assuming the stack from
 * the developer's free-text requirement.
 */
export async function inspectRepository(repositoryPath: string): Promise<DetectedStack> {
  const evidence: string[] = [];

  const packageJsonPath = path.join(repositoryPath, "package.json");
  if (existsSync(packageJsonPath)) {
    return inspectNode(repositoryPath, packageJsonPath, evidence);
  }

  const pyprojectPath = path.join(repositoryPath, "pyproject.toml");
  const requirementsPath = path.join(repositoryPath, "requirements.txt");
  const setupPyPath = path.join(repositoryPath, "setup.py");
  if (existsSync(pyprojectPath) || existsSync(requirementsPath) || existsSync(setupPyPath)) {
    return inspectPython(repositoryPath, evidence);
  }

  evidence.push("No package.json, pyproject.toml, requirements.txt or setup.py found at repository root.");
  return {
    language: "unknown",
    packageManager: null,
    framework: null,
    database: null,
    testCommand: null,
    lintCommand: null,
    typecheckCommand: null,
    evidence,
  };
}

async function inspectNode(repositoryPath: string, packageJsonPath: string, evidence: string[]): Promise<DetectedStack> {
  evidence.push("package.json found at repository root.");
  const raw = await readFile(packageJsonPath, "utf-8");
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  let framework: string | null = null;
  if (deps["@nestjs/core"]) {
    framework = "NestJS";
    evidence.push("Dependency @nestjs/core detected.");
  } else if (deps["express"]) {
    framework = "Express";
    evidence.push("Dependency express detected.");
  } else if (deps["fastify"]) {
    framework = "Fastify";
    evidence.push("Dependency fastify detected.");
  }

  let database: string | null = null;
  if (deps["pg"] || deps["typeorm"] || deps["sequelize"] || deps["@prisma/client"]) {
    database = "PostgreSQL";
    evidence.push("Dependency indicates PostgreSQL (pg/typeorm/sequelize/prisma).");
  } else if (deps["mongodb"] || deps["mongoose"]) {
    database = "MongoDB";
    evidence.push("Dependency indicates MongoDB (mongodb/mongoose).");
  } else if (deps["redis"] || deps["ioredis"]) {
    database = "Redis";
    evidence.push("Dependency indicates Redis (redis/ioredis).");
  }

  const packageManager = existsSync(path.join(repositoryPath, "pnpm-lock.yaml"))
    ? "pnpm"
    : existsSync(path.join(repositoryPath, "yarn.lock"))
      ? "yarn"
      : "npm";

  return {
    language: "node",
    packageManager,
    framework,
    database,
    testCommand: pkg.scripts?.test ? "npm test" : null,
    lintCommand: pkg.scripts?.lint ? "npm run lint" : null,
    typecheckCommand: pkg.scripts?.typecheck ? "npm run typecheck" : deps["typescript"] ? "npx tsc --noEmit" : null,
    evidence,
  };
}

async function inspectPython(repositoryPath: string, evidence: string[]): Promise<DetectedStack> {
  let manifestText = "";
  for (const file of ["pyproject.toml", "requirements.txt", "setup.py"]) {
    const filePath = path.join(repositoryPath, file);
    if (existsSync(filePath)) {
      evidence.push(`${file} found at repository root.`);
      manifestText += (await readFile(filePath, "utf-8")).toLowerCase() + "\n";
    }
  }

  let framework: string | null = null;
  if (manifestText.includes("fastapi")) {
    framework = "FastAPI";
    evidence.push("Dependency fastapi detected.");
  } else if (manifestText.includes("django")) {
    framework = "Django";
    evidence.push("Dependency django detected.");
  } else if (manifestText.includes("flask")) {
    framework = "Flask";
    evidence.push("Dependency flask detected.");
  }

  let database: string | null = null;
  if (manifestText.includes("psycopg") || manifestText.includes("asyncpg") || manifestText.includes("sqlalchemy")) {
    database = "PostgreSQL";
    evidence.push("Dependency indicates PostgreSQL (psycopg/asyncpg/sqlalchemy).");
  } else if (manifestText.includes("pymongo") || manifestText.includes("motor")) {
    database = "MongoDB";
    evidence.push("Dependency indicates MongoDB (pymongo/motor).");
  } else if (manifestText.includes("redis")) {
    database = "Redis";
    evidence.push("Dependency indicates Redis.");
  }

  const packageManager = existsSync(path.join(repositoryPath, "poetry.lock"))
    ? "poetry"
    : existsSync(path.join(repositoryPath, "Pipfile.lock"))
      ? "pipenv"
      : "pip";

  const hasPytest = manifestText.includes("pytest") || existsSync(path.join(repositoryPath, "pytest.ini"));

  return {
    language: "python",
    packageManager,
    framework,
    database,
    testCommand: hasPytest ? "pytest" : null,
    lintCommand: manifestText.includes("ruff") ? "ruff check ." : manifestText.includes("flake8") ? "flake8" : null,
    typecheckCommand: manifestText.includes("mypy") ? "mypy ." : null,
    evidence,
  };
}
