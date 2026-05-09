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
  createDatasetVersionDownloadLinkHandler,
  downloadDatasetVersionFileHandler,
  getDatasetDetailHandler,
  listDatasetsHandler,
  publicDownloadDatasetVersionFileHandler,
} from "../datasets/datasets.controller.js";
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
  reviewTaskStageHandler,
} from "../tasks/tasks.controller.js";
import {
  createModelIterationHandler,
  getModelIterationDetailHandler,
  listModelIterationsHandler,
  markCurrentBestModelResultHandler,
} from "../model-iterations/model-iterations.controller.js";
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
  apiRouter.get("/datasets", authRequired, requireRoles("admin"), listDatasetsHandler);
  apiRouter.get("/datasets/:datasetId", authRequired, requireRoles("admin"), getDatasetDetailHandler);
  apiRouter.get(
    "/datasets/:datasetId/versions/:versionId/download",
    authRequired,
    requireRoles("admin"),
    downloadDatasetVersionFileHandler,
  );
  apiRouter.get(
    "/datasets/:datasetId/versions/:versionId/download-link",
    authRequired,
    requireRoles("admin"),
    createDatasetVersionDownloadLinkHandler,
  );
  apiRouter.get(
    "/model-iterations",
    authRequired,
    requireRoles("admin"),
    listModelIterationsHandler,
  );
  apiRouter.get(
    "/model-iterations/:modelIterationId",
    authRequired,
    requireRoles("admin"),
    getModelIterationDetailHandler,
  );
  apiRouter.post(
    "/model-iterations",
    authRequired,
    requireRoles("admin"),
    createModelIterationHandler,
  );
  apiRouter.post(
    "/model-iterations/:modelIterationId/current-best-task",
    authRequired,
    requireRoles("admin"),
    markCurrentBestModelResultHandler,
  );
  apiRouter.get("/models", authRequired, requireRoles("admin"), listModelsHandler);
  apiRouter.get("/tasks", authRequired, listTasksHandler);
  apiRouter.get("/tasks/:taskId", authRequired, getTaskDetailHandler);
  apiRouter.post("/tasks", authRequired, requireRoles("admin"), createTaskHandler);
  apiRouter.delete("/tasks/:taskId", authRequired, requireRoles("admin"), deleteTaskHandler);
  apiRouter.post("/tasks/:taskId/complete-stage", authRequired, completeTaskStageHandler);
  apiRouter.post("/tasks/:taskId/review", authRequired, requireRoles("admin"), reviewTaskStageHandler);
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
  apiRouter.get("/public/dataset-versions/download", publicDownloadDatasetVersionFileHandler);
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
