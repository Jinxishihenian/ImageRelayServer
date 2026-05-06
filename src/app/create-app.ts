import compression from "compression";
import cors from "cors";
import express from "express";
import helmet from "helmet";

import type { AppEnv } from "../config/env.js";
import {
  getDatabaseHealthStatus,
  type DatabaseHealthStatus,
} from "../database/mysql.js";
import { errorHandler } from "../middleware/error-handler.js";
import { notFoundHandler } from "../middleware/not-found.js";
import { requestLogger } from "../middleware/request-logger.js";
import { createRootRouter } from "../routes/index.js";

export type AppDependencies = {
  getDatabaseHealthStatus?: () => Promise<DatabaseHealthStatus>;
};

export function createApp(env: AppEnv, dependencies: AppDependencies = {}) {
  const app = express();
  const resolveDatabaseHealthStatus =
    dependencies.getDatabaseHealthStatus ?? getDatabaseHealthStatus;

  app.set("envConfig", env);
  app.set("fileBaseUrl", env.fileBaseUrl);

  app.disable("x-powered-by");

  app.use(helmet());

  app.use(
    cors({
      origin(origin, callback) {
        // 浏览器同源请求不会带 origin；开发阶段未配置白名单时也允许通过。
        if (!origin || env.corsOrigins.length === 0 || env.corsOrigins.includes(origin)) {
          callback(null, true);
          return;
        }

        callback(new Error(`不允许的跨域来源: ${origin}`));
      },
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
      allowedHeaders: [
        "Authorization",
        "Content-Type",
        "Tus-Resumable",
        "Upload-Length",
        "Upload-Offset",
        "Upload-Metadata",
      ],
      exposedHeaders: [
        "Location",
        "Upload-Offset",
        "Upload-Length",
        "Tus-Resumable",
        "Tus-Version",
        "Tus-Extension",
      ],
    }),
  );

  app.use(compression());
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: true, limit: "1mb" }));
  app.use(requestLogger);

  app.use(createRootRouter(env, resolveDatabaseHealthStatus));
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
