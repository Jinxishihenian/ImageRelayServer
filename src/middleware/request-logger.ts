import type { NextFunction, Request, Response } from "express";

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const startedAt = performance.now();

  res.on("finish", () => {
    const durationMs = (performance.now() - startedAt).toFixed(1);
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`);
  });

  next();
}
