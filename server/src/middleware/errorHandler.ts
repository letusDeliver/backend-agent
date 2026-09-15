import type { NextFunction, Request, Response } from "express";
import { InvalidRepositoryPathError } from "../utils/paths.js";

export class ApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: { message: "Not found" } });
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: { message: err.message } });
    return;
  }
  if (err instanceof InvalidRepositoryPathError) {
    res.status(400).json({ error: { message: err.message } });
    return;
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: { message: "Internal server error" } });
}
