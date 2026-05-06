import express, { Router } from "express";

import { createLoginHandler } from "../auth/auth.controller.js";
import { requireAuth, requireRoles } from "../auth/auth.middleware.js";
import type { AppEnv } from "../config/env.js";
import { getPing } from "../controllers/ping.controller.js";
import {
  completeUploadSessionHandler,
  createUploadSessionHandler,
  tusBindHandler,
  tusCreateHandler,
  tusHeadHandler,
  tusOptionsHandler,
  tusPatchHandler,
  uploadFileHandler,
} from "../files/file.controller.js";
import {
  completeTaskStageHandler,
  createTaskFileDownloadLinkHandler,
  createTaskHandler,
  deleteTaskHandler,
  downloadTaskFileHandler,
  getTaskDetailHandler,
  listModelsHandler,
  listTasksHandler,
  listTaskFilePreviewHandler,
  publicDownloadTaskFileHandler,
  previewTaskFileImageHandler,
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
  apiRouter.get("/models", authRequired, requireRoles("admin"), listModelsHandler);
  apiRouter.get("/tasks", authRequired, listTasksHandler);
  apiRouter.get("/tasks/:taskId", authRequired, getTaskDetailHandler);
  apiRouter.post("/tasks", authRequired, requireRoles("admin"), createTaskHandler);
  apiRouter.delete("/tasks/:taskId", authRequired, requireRoles("admin"), deleteTaskHandler);
  apiRouter.post("/tasks/:taskId/complete-stage", authRequired, completeTaskStageHandler);
  apiRouter.get("/tasks/:taskId/files/:fileAlias/download", authRequired, downloadTaskFileHandler);
  apiRouter.get(
    "/tasks/:taskId/files/:fileAlias/download-link",
    authRequired,
    createTaskFileDownloadLinkHandler,
  );
  apiRouter.get("/tasks/:taskId/files/:fileAlias/preview", authRequired, listTaskFilePreviewHandler);
  apiRouter.get(
    "/tasks/:taskId/files/:fileAlias/preview/:entryId",
    authRequired,
    previewTaskFileImageHandler,
  );
  apiRouter.get("/public/task-files/download", publicDownloadTaskFileHandler);
  apiRouter.post("/files/uploads", authRequired, createUploadSessionHandler);
  apiRouter.post("/files/uploads/:uploadId/complete", authRequired, completeUploadSessionHandler);
  apiRouter.options("/files/tus", authRequired, tusOptionsHandler);
  apiRouter.post("/files/tus", authRequired, tusCreateHandler);
  apiRouter.options("/files/tus/:uploadId", authRequired, tusOptionsHandler);
  apiRouter.post("/files/tus/:uploadId", authRequired, tusBindHandler);
  apiRouter.head("/files/tus/:uploadId", authRequired, tusHeadHandler);
  apiRouter.patch("/files/tus/:uploadId", authRequired, tusPatchHandler);
  apiRouter.post("/files/upload", authRequired, uploadFileHandler);

  return apiRouter;
}
