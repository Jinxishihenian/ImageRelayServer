import type { NextFunction, Request, Response } from "express";

import { AppError } from "../utils/app-error.js";

export function notFoundHandler(req: Request, _res: Response, next: NextFunction): void {
  next(
    new AppError(`未找到路由: ${req.method} ${req.originalUrl}`, {
      statusCode: 404,
      code: "ROUTE_NOT_FOUND",
    }),
  );
}
