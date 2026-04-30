import { Router } from "express";

import {
  createGetHealth,
  type GetDatabaseHealthStatus,
} from "../controllers/health.controller.js";

export function createHealthRouter(getDatabaseHealthStatus: GetDatabaseHealthStatus) {
  const healthRouter = Router();

  healthRouter.get("/", createGetHealth(getDatabaseHealthStatus));

  return healthRouter;
}
