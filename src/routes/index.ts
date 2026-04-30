import { Router } from "express";

import type { GetDatabaseHealthStatus } from "../controllers/health.controller.js";
import type { AppEnv } from "../config/env.js";
import { createApiRouter } from "./api.routes.js";
import { createHealthRouter } from "./health.routes.js";

export function createRootRouter(env: AppEnv, getDatabaseHealthStatus: GetDatabaseHealthStatus) {
  const rootRouter = Router();

  rootRouter.use("/health", createHealthRouter(getDatabaseHealthStatus));
  rootRouter.use("/api/v1", createApiRouter(env));

  return rootRouter;
}
