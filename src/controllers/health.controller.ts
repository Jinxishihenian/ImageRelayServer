import type { RequestHandler } from "express";

import type { DatabaseHealthStatus } from "../database/mysql.js";

export type GetDatabaseHealthStatus = () => Promise<DatabaseHealthStatus>;

function getHealthErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "健康检查执行失败";
}

export function createGetHealth(getDatabaseHealthStatus: GetDatabaseHealthStatus): RequestHandler {
  return async (_req, res) => {
    let database: DatabaseHealthStatus;

    try {
      database = await getDatabaseHealthStatus();
    } catch (error) {
      database = {
        status: "down",
        message: getHealthErrorMessage(error),
      };
    }

    const isHealthy = database.status === "up";

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? "ok" : "degraded",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      database,
    });
  };
}
