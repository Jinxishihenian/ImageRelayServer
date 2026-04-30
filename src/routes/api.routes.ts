import express, { Router } from "express";

import { createLoginHandler } from "../auth/auth.controller.js";
import { requireAuth, requireRoles } from "../auth/auth.middleware.js";
import type { AppEnv } from "../config/env.js";
import { getPing } from "../controllers/ping.controller.js";
import { uploadFileHandler } from "../files/file.controller.js";
import {
  completeTaskStageHandler,
  createTaskHandler,
  deleteTaskHandler,
  downloadTaskFileHandler,
  getTaskDetailHandler,
  listTasksHandler,
} from "../tasks/tasks.controller.js";
import {
  createUserHandler,
  deleteUserHandler,
  listUsersHandler,
  updateUserHandler,
} from "../users/users.controller.js";

export function createApiRouter(env: AppEnv) {
  const apiRouter = Router();
  const authRequired = requireAuth(env);

  apiRouter.get("/ping", getPing);
  apiRouter.post("/auth/login", createLoginHandler(env));
  apiRouter.get("/users", authRequired, requireRoles("admin"), listUsersHandler);
  apiRouter.post("/users", authRequired, requireRoles("admin"), createUserHandler);
  apiRouter.put("/users/:userId", authRequired, requireRoles("admin"), updateUserHandler);
  apiRouter.delete("/users/:userId", authRequired, requireRoles("admin"), deleteUserHandler);
  apiRouter.get("/tasks", authRequired, listTasksHandler);
  apiRouter.get("/tasks/:taskId", authRequired, getTaskDetailHandler);
  apiRouter.post("/tasks", authRequired, requireRoles("admin"), createTaskHandler);
  apiRouter.delete("/tasks/:taskId", authRequired, requireRoles("admin"), deleteTaskHandler);
  apiRouter.post("/tasks/:taskId/complete-stage", authRequired, completeTaskStageHandler);
  apiRouter.get("/tasks/:taskId/files/:fileAlias/download", authRequired, downloadTaskFileHandler);
  apiRouter.post(
    "/files/upload",
    authRequired,
    express.raw({
      limit: env.maxUploadSizeBytes,
      type: () => true,
    }),
    uploadFileHandler,
  );

  return apiRouter;
}
