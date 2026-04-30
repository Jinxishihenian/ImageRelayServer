import type { ErrorRequestHandler } from "express";

import { AppError } from "../utils/app-error.js";

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.expose ? error.message : "服务器内部错误。",
        details: error.expose ? error.details : undefined,
      },
    });
    return;
  }

  console.error("Unhandled error:", error);

  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      // 生产环境不返回内部错误细节，避免把堆栈或实现信息暴露给客户端。
      message: process.env.NODE_ENV === "production" ? "服务器内部错误。" : "未处理的服务器错误。",
    },
  });
};
