import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { RequestHandler, Response } from "express";

import {
  canPreviewTaskArchive,
  getFileExtension,
  isArchiveFileName,
  listZipPreviewItems,
  openZipPreviewStream,
} from "../files/archive-utils.js";
import {
  buildPaginationMeta,
  parsePaginationQuery,
  parseOptionalString,
  parsePositiveInteger,
} from "../common/http.js";
import {
  FILE_LABELS,
  ROLE_LABELS,
  STATUS_LABELS,
  getAllowedFileAliases,
  getNextStatus,
  getStageRole,
} from "../common/role-status.js";
import { ensureStoredFileExists, moveTempUploadToTask } from "../files/file-storage.js";
import type {
  AuthenticatedUser,
  TaskFileAlias,
  UploadedFileRef,
  UserRole,
} from "../types/domain.js";
import { AppError } from "../utils/app-error.js";
import { getAuthUser } from "../auth/auth.middleware.js";
import { findUsersByIds } from "../users/users.repository.js";
import {
  attachSourceFile,
  completeTaskStage,
  createTask,
  deleteTaskById,
  findTaskById,
  listModels,
  listTasksForUser,
  type ModelListItem,
  type TaskRow,
} from "./tasks.repository.js";
import { TASK_STATUSES, type TaskStatus } from "../types/domain.js";
import { canUserAccessTask } from "./task-visibility.js";

const DOWNLOAD_LINK_ROUTE = "/api/v1/public/task-files/download";
const RANGE_HEADER_PREFIX = "bytes=";
const DEFAULT_DOWNLOAD_MIME_TYPE = "application/octet-stream";

function createDownloadLinkSignature(
  taskId: number,
  alias: TaskFileAlias,
  expiresAt: number,
  secret: string,
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${taskId}:${alias}:${expiresAt}`)
    .digest("base64url");
}

function buildAbsoluteUrl(req: Parameters<RequestHandler>[0], path: string): string {
  const baseUrl = req.app.get("fileBaseUrl") as string | undefined;

  if (baseUrl?.trim()) {
    return new URL(path, `${baseUrl.replace(/\/+$/, "")}/`).toString();
  }

  return new URL(path, `${req.protocol}://${req.get("host") ?? "localhost"}`).toString();
}

function isTaskFileAlias(value: string): value is TaskFileAlias {
  return ["source", "cleaned", "annotated", "model"].includes(value);
}

function getSingleRouteParam(value: string | string[] | undefined, fieldName: string): string {
  if (typeof value === "string") {
    return value;
  }

  throw new AppError(`缺少有效的路由参数 ${fieldName}。`, {
    statusCode: 400,
    code: "INVALID_ROUTE_PARAM",
  });
}

function canAccessTask(task: TaskRow, user: AuthenticatedUser): boolean {
  return canUserAccessTask(task, user);
}

function canHandleCurrentStage(task: TaskRow, user: AuthenticatedUser): boolean {
  const stageRole = getStageRole(task.status);

  if (!stageRole || user.role !== stageRole) {
    return false;
  }

  switch (stageRole) {
    case "cleaner":
      return task.cleanerId === user.id;
    case "annotator":
      return task.annotatorId === user.id;
    case "trainer":
      return task.trainerId === user.id;
    case "admin":
      return false;
  }
}

function getDownloadFields(task: TaskRow, user: AuthenticatedUser) {
  return getAllowedFileAliases(user.role)
    .map((alias) => {
      const file = getTaskFileInfo(task, alias);

      if (!file.storageKey || !file.originalName) {
        return null;
      }

      return {
        alias,
        label: FILE_LABELS[alias],
        fileName: file.originalName,
        endpoint: `/api/v1/tasks/${task.id}/files/${alias}/download`,
        canPreview: canPreviewTaskArchive(alias, file.originalName),
        previewEndpoint: canPreviewTaskArchive(alias, file.originalName)
          ? `/api/v1/tasks/${task.id}/files/${alias}/preview`
          : null,
      };
    })
    .filter(Boolean);
}

function getTaskFileInfo(task: TaskRow, alias: TaskFileAlias) {
  switch (alias) {
    case "source":
      return {
        storageKey: task.sourceFile,
        originalName: task.sourceFileName,
      };
    case "cleaned":
      return {
        storageKey: task.cleanedFile,
        originalName: task.cleanedFileName,
      };
    case "annotated":
      return {
        storageKey: task.annotatedFile,
        originalName: task.annotatedFileName,
      };
    case "model":
      return {
        storageKey: task.modelFile,
        originalName: task.modelFileName,
      };
  }
}

function getAccessibleTaskFile(
  task: TaskRow,
  user: AuthenticatedUser,
  alias: TaskFileAlias,
  errorAction: "下载" | "预览" = "下载",
): {
  storageKey: string;
  originalName: string;
} {
  if (!canAccessTask(task, user)) {
    throw new AppError(`当前用户无权${errorAction}该文件。`, {
      statusCode: 403,
      code: "FORBIDDEN_FILE_ACCESS",
    });
  }

  if (user.role !== "admin" && !getAllowedFileAliases(user.role).includes(alias)) {
    throw new AppError(`当前角色无权${errorAction}该文件。`, {
      statusCode: 403,
      code: "FORBIDDEN_FILE_ACCESS",
    });
  }

  const fileInfo = getTaskFileInfo(task, alias);

  if (!fileInfo.storageKey || !fileInfo.originalName) {
    throw new AppError("任务文件不存在。", {
      statusCode: 404,
      code: "TASK_FILE_NOT_FOUND",
    });
  }

  return {
    storageKey: fileInfo.storageKey,
    originalName: fileInfo.originalName,
  };
}

function encodeContentDispositionFileName(fileName: string): string {
  // 同时提供 ASCII fallback 和 RFC 5987 UTF-8 文件名，兼容不同浏览器保存文件名的行为。
  const sanitizedFallback = path
    .basename(fileName)
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_");

  return `attachment; filename="${sanitizedFallback || "download"}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function parseSingleRangeHeader(rangeHeader: string, fileSize: number): {
  start: number;
  end: number;
} {
  if (!rangeHeader.startsWith(RANGE_HEADER_PREFIX)) {
    throw new AppError("Range 请求头格式不正确。", {
      statusCode: 416,
      code: "INVALID_RANGE_HEADER",
    });
  }

  const rawRangeValue = rangeHeader.slice(RANGE_HEADER_PREFIX.length).trim();

  if (!rawRangeValue || rawRangeValue.includes(",")) {
    throw new AppError("当前仅支持单个 Range 下载。", {
      statusCode: 416,
      code: "INVALID_RANGE_HEADER",
    });
  }

  const [startRaw, endRaw] = rawRangeValue.split("-", 2);

  if (startRaw === undefined || endRaw === undefined) {
    throw new AppError("Range 请求头格式不正确。", {
      statusCode: 416,
      code: "INVALID_RANGE_HEADER",
    });
  }

  if (startRaw === "") {
    const suffixLength = Number(endRaw);

    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      throw new AppError("Range 请求头格式不正确。", {
        statusCode: 416,
        code: "INVALID_RANGE_HEADER",
      });
    }

    const boundedLength = Math.min(suffixLength, fileSize);

    return {
      start: Math.max(fileSize - boundedLength, 0),
      end: fileSize - 1,
    };
  }

  const start = Number(startRaw);

  if (!Number.isInteger(start) || start < 0 || start >= fileSize) {
    throw new AppError("Range 超出文件大小范围。", {
      statusCode: 416,
      code: "INVALID_RANGE_HEADER",
    });
  }

  if (endRaw === "") {
    return {
      start,
      end: fileSize - 1,
    };
  }

  const end = Number(endRaw);

  if (!Number.isInteger(end) || end < start) {
    throw new AppError("Range 请求头格式不正确。", {
      statusCode: 416,
      code: "INVALID_RANGE_HEADER",
    });
  }

  return {
    start,
    end: Math.min(end, fileSize - 1),
  };
}

async function streamStoredFileDownload(
  req: Parameters<RequestHandler>[0],
  res: Response,
  absolutePath: string,
  originalName: string,
): Promise<void> {
  const fileStat = await fs.promises.stat(absolutePath);

  if (!fileStat.isFile()) {
    throw new AppError("文件不存在。", {
      statusCode: 404,
      code: "FILE_NOT_FOUND",
    });
  }

  const fileSize = fileStat.size;
  const mimeType = DEFAULT_DOWNLOAD_MIME_TYPE;
  const rangeHeader = req.headers.range;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", mimeType);
  res.setHeader("Content-Disposition", encodeContentDispositionFileName(originalName));
  res.setHeader("Cache-Control", "private, no-store");

  if (!rangeHeader) {
    res.status(200);
    res.setHeader("Content-Length", fileSize);

    const fileStream = fs.createReadStream(absolutePath);
    await pipeline(fileStream, res);
    return;
  }

  let start = 0;
  let end = 0;

  try {
    ({ start, end } = parseSingleRangeHeader(rangeHeader, fileSize));
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 416) {
      res.setHeader("Content-Range", `bytes */${fileSize}`);
    }

    throw error;
  }

  const chunkSize = end - start + 1;

  res.status(206);
  res.setHeader("Content-Length", chunkSize);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);

  // 大文件下载必须走流式区间读取，避免一次性把几 GB 文件读进内存。
  const fileStream = fs.createReadStream(absolutePath, {
    start,
    end,
  });
  await pipeline(fileStream, res);
}

function getMyRole(task: TaskRow, user: AuthenticatedUser): UserRole {
  if (user.role === "admin") {
    return "admin";
  }

  if (task.cleanerId === user.id) {
    return "cleaner";
  }

  if (task.annotatorId === user.id) {
    return "annotator";
  }

  return "trainer";
}

function mapTaskSummary(task: TaskRow, user: AuthenticatedUser) {
  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    statusLabel: STATUS_LABELS[task.status],
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
    creator: {
      id: task.creatorId,
      username: task.creatorUsername,
    },
    assignees: {
      cleaner: {
        id: task.cleanerId,
        username: task.cleanerUsername,
      },
      annotator: {
        id: task.annotatorId,
        username: task.annotatorUsername,
      },
      trainer: {
        id: task.trainerId,
        username: task.trainerUsername,
      },
    },
    myRole: getMyRole(task, user),
    canHandle: canHandleCurrentStage(task, user),
  };
}

function mapTaskDetail(task: TaskRow, user: AuthenticatedUser) {
  const stageRole = getStageRole(task.status);

  return {
    ...mapTaskSummary(task, user),
    remarks: {
      cleaner: task.cleanerRemark,
      annotator: task.annotatorRemark,
      trainer: task.trainerRemark,
    },
    downloads: getDownloadFields(task, user),
    canSubmitCurrentStage: canHandleCurrentStage(task, user),
    currentStage: {
      role: stageRole,
      label: stageRole ? ROLE_LABELS[stageRole] : "流程结束",
    },
  };
}

function mapModelListItem(item: ModelListItem) {
  return {
    taskId: item.taskId,
    taskTitle: item.taskTitle,
    modelFileName: item.modelFileName,
    trainerRemark: item.trainerRemark,
    finishedAt: item.finishedAt,
    trainer: item.trainer,
    download: {
      alias: "model" as const,
      label: FILE_LABELS.model,
      fileName: item.modelFileName,
      endpoint: `/api/v1/tasks/${item.taskId}/files/model/download`,
    },
  };
}

async function validateTaskAssignees(cleanerId: number, annotatorId: number, trainerId: number) {
  const users = await findUsersByIds([cleanerId, annotatorId, trainerId]);
  const userMap = new Map(users.map((user) => [user.id, user]));

  const cleaner = userMap.get(cleanerId);
  const annotator = userMap.get(annotatorId);
  const trainer = userMap.get(trainerId);

  if (!cleaner || cleaner.role !== "cleaner") {
    throw new AppError("所选清洗者无效。", {
      statusCode: 400,
      code: "INVALID_CLEANER",
    });
  }

  if (!annotator || annotator.role !== "annotator") {
    throw new AppError("所选标注者无效。", {
      statusCode: 400,
      code: "INVALID_ANNOTATOR",
    });
  }

  if (!trainer || trainer.role !== "trainer") {
    throw new AppError("所选训练者无效。", {
      statusCode: 400,
      code: "INVALID_TRAINER",
    });
  }
}

function parseUploadedFile(input: unknown): UploadedFileRef {
  if (!input || typeof input !== "object") {
    throw new AppError("文件信息不能为空。", {
      statusCode: 400,
      code: "INVALID_FILE_REFERENCE",
    });
  }

  const candidate = input as Partial<UploadedFileRef>;

  if (
    !candidate.storageKey ||
    !candidate.originalName ||
    typeof candidate.storageKey !== "string" ||
    typeof candidate.originalName !== "string"
  ) {
    throw new AppError("上传文件引用格式不正确。", {
      statusCode: 400,
      code: "INVALID_FILE_REFERENCE",
    });
  }

  return {
    storageKey: candidate.storageKey,
    originalName: candidate.originalName,
    mimeType: typeof candidate.mimeType === "string" ? candidate.mimeType : "application/octet-stream",
    size: typeof candidate.size === "number" ? candidate.size : 0,
  };
}

function assertArchiveFileName(fileName: string, message: string, code: string): void {
  if (isArchiveFileName(fileName)) {
    return;
  }

  throw new AppError(message, {
    statusCode: 400,
    code,
  });
}

function assertPreviewableTaskAlias(alias: TaskFileAlias): void {
  if (alias === "source" || alias === "cleaned") {
    return;
  }

  throw new AppError("当前文件类型暂不支持预览。", {
    statusCode: 400,
    code: "UNSUPPORTED_PREVIEW_ALIAS",
  });
}

async function getPreviewableTaskFile(
  task: TaskRow,
  user: AuthenticatedUser,
  alias: TaskFileAlias,
): Promise<{
  absolutePath: string;
  originalName: string;
}> {
  if (!canAccessTask(task, user)) {
    throw new AppError("当前用户无权预览该文件。", {
      statusCode: 403,
      code: "FORBIDDEN_FILE_ACCESS",
    });
  }

  assertPreviewableTaskAlias(alias);
  const fileInfo = getAccessibleTaskFile(task, user, alias, "预览");

  if (getFileExtension(fileInfo.originalName) !== ".zip") {
    throw new AppError("当前压缩包格式暂不支持预览，当前仅支持 zip 预览。", {
      statusCode: 400,
      code: "UNSUPPORTED_PREVIEW_ARCHIVE_TYPE",
    });
  }

  return {
    absolutePath: await ensureStoredFileExists(fileInfo.storageKey),
    originalName: fileInfo.originalName,
  };
}

function parseOptionalTaskStatus(value: unknown): TaskStatus | undefined {
  const normalizedStatus = parseOptionalString(value, "status");

  if (!normalizedStatus) {
    return undefined;
  }

  if (TASK_STATUSES.includes(normalizedStatus as TaskStatus)) {
    return normalizedStatus as TaskStatus;
  }

  throw new AppError("status 查询参数无效。", {
    statusCode: 400,
    code: "INVALID_TASK_STATUS",
    details: {
      field: "status",
    },
  });
}

export const listTasksHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const pagination = parsePaginationQuery(req.query);
  const keyword = parseOptionalString(req.query.keyword, "keyword");
  const status = parseOptionalTaskStatus(req.query.status);
  const taskPage = await listTasksForUser(authUser, {
    ...pagination,
    keyword,
    status,
  });

  res.json({
    items: taskPage.items.map((task) => mapTaskSummary(task, authUser)),
    pagination: buildPaginationMeta(taskPage.page, taskPage.pageSize, taskPage.total),
    summary: taskPage.summary,
  });
};

export const listModelsHandler: RequestHandler = async (req, res) => {
  const pagination = parsePaginationQuery(req.query);
  const keyword = parseOptionalString(req.query.keyword, "keyword");
  const modelPage = await listModels({
    ...pagination,
    keyword,
  });

  res.json({
    items: modelPage.items.map(mapModelListItem),
    pagination: buildPaginationMeta(modelPage.page, modelPage.pageSize, modelPage.total),
  });
};

export const getTaskDetailHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const taskId = parsePositiveInteger(getSingleRouteParam(req.params.taskId, "taskId"), "taskId");
  const task = await findTaskById(taskId);

  if (!task) {
    throw new AppError("任务不存在。", {
      statusCode: 404,
      code: "TASK_NOT_FOUND",
    });
  }

  if (!canAccessTask(task, authUser)) {
    throw new AppError("当前用户无权查看该任务。", {
      statusCode: 403,
      code: "FORBIDDEN_TASK_ACCESS",
    });
  }

  res.json(mapTaskDetail(task, authUser));
};

export const createTaskHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const { title, description, cleanerId, annotatorId, trainerId, sourceFile } = req.body as {
    title?: string;
    description?: string;
    cleanerId?: number;
    annotatorId?: number;
    trainerId?: number;
    sourceFile?: unknown;
  };

  if (!title?.trim()) {
    throw new AppError("任务名称不能为空。", {
      statusCode: 400,
      code: "INVALID_TASK_TITLE",
    });
  }

  const cleanerUserId = Number(cleanerId);
  const annotatorUserId = Number(annotatorId);
  const trainerUserId = Number(trainerId);

  if (![cleanerUserId, annotatorUserId, trainerUserId].every(Number.isInteger)) {
    throw new AppError("任务负责人不能为空。", {
      statusCode: 400,
      code: "INVALID_TASK_ASSIGNEES",
    });
  }

  await validateTaskAssignees(cleanerUserId, annotatorUserId, trainerUserId);
  const uploadedSourceFile = parseUploadedFile(sourceFile);
  // 临时上传接口本身不感知业务角色，这里在正式创建任务前做最终格式校验。
  assertArchiveFileName(
    uploadedSourceFile.originalName,
    "初始文件仅允许上传 zip、rar、7z 压缩包。",
    "INVALID_SOURCE_FILE_TYPE",
  );

  const taskId = await createTask({
    title: title.trim(),
    description: description?.trim() ?? "",
    creatorId: authUser.id,
    cleanerId: cleanerUserId,
    annotatorId: annotatorUserId,
    trainerId: trainerUserId,
  });

  try {
    const storedSourceFile = await moveTempUploadToTask(uploadedSourceFile, taskId, "source");
    await attachSourceFile(taskId, storedSourceFile.storageKey, storedSourceFile.originalName);
  } catch (error) {
    await deleteTaskById(taskId);
    throw error;
  }

  const createdTask = await findTaskById(taskId);

  res.status(201).json({
    item: createdTask ? mapTaskDetail(createdTask, authUser) : null,
  });
};

export const deleteTaskHandler: RequestHandler = async (req, res) => {
  const taskId = parsePositiveInteger(getSingleRouteParam(req.params.taskId, "taskId"), "taskId");
  const task = await findTaskById(taskId);

  if (!task) {
    throw new AppError("任务不存在。", {
      statusCode: 404,
      code: "TASK_NOT_FOUND",
    });
  }

  // 当前需求仅删除数据库中的任务记录，不同步清理任务目录下的历史文件。
  // 这样可以避免误删产物；若后续需要回收文件，再补充显式清理策略。
  await deleteTaskById(taskId);

  res.status(204).send();
};

export const completeTaskStageHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const taskId = parsePositiveInteger(getSingleRouteParam(req.params.taskId, "taskId"), "taskId");
  const task = await findTaskById(taskId);

  if (!task) {
    throw new AppError("任务不存在。", {
      statusCode: 404,
      code: "TASK_NOT_FOUND",
    });
  }

  if (!canHandleCurrentStage(task, authUser)) {
    throw new AppError("当前任务不允许由你提交。", {
      statusCode: 403,
      code: "INVALID_STAGE_OPERATOR",
    });
  }

  if (task.status === "finished") {
    throw new AppError("已完成任务不可再次提交。", {
      statusCode: 400,
      code: "TASK_ALREADY_FINISHED",
    });
  }

  const { file, remark } = req.body as {
    file?: unknown;
    remark?: string;
  };
  const uploadedFile = parseUploadedFile(file);

  if (authUser.role === "cleaner" || authUser.role === "annotator") {
    // 清洗/标注阶段只允许压缩包，训练阶段则保留开放类型。
    assertArchiveFileName(
      uploadedFile.originalName,
      "当前阶段仅允许上传 zip、rar、7z 压缩包。",
      "INVALID_STAGE_FILE_TYPE",
    );
  }

  const normalizedRemark = remark?.trim() ?? "";
  const storedFile = await moveTempUploadToTask(
    uploadedFile,
    task.id,
    authUser.role === "cleaner"
      ? "cleaned"
      : authUser.role === "annotator"
        ? "annotated"
        : "model",
  );

  const nextStatus = getNextStatus(task.status);
  const updated = await completeTaskStage({
    taskId: task.id,
    currentStatus: task.status,
    nextStatus,
    fileColumn:
      authUser.role === "cleaner"
        ? "cleaned_file"
        : authUser.role === "annotator"
          ? "annotated_file"
          : "model_file",
    fileNameColumn:
      authUser.role === "cleaner"
        ? "cleaned_file_name"
        : authUser.role === "annotator"
          ? "annotated_file_name"
          : "model_file_name",
    remarkColumn:
      authUser.role === "cleaner"
        ? "cleaner_remark"
        : authUser.role === "annotator"
          ? "annotator_remark"
          : "trainer_remark",
    storageKey: storedFile.storageKey,
    originalName: storedFile.originalName,
    remark: normalizedRemark,
  });

  if (!updated) {
    throw new AppError("任务状态已变化，请刷新后重试。", {
      statusCode: 409,
      code: "TASK_STATUS_CONFLICT",
    });
  }

  const latestTask = await findTaskById(task.id);

  res.json({
    item: latestTask ? mapTaskDetail(latestTask, authUser) : null,
  });
};

export const downloadTaskFileHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const taskId = parsePositiveInteger(getSingleRouteParam(req.params.taskId, "taskId"), "taskId");
  const alias = getSingleRouteParam(req.params.fileAlias, "fileAlias") as TaskFileAlias;
  const task = await findTaskById(taskId);

  if (!task) {
    throw new AppError("任务不存在。", {
      statusCode: 404,
      code: "TASK_NOT_FOUND",
    });
  }

  if (!canAccessTask(task, authUser)) {
    throw new AppError("当前用户无权下载该文件。", {
      statusCode: 403,
      code: "FORBIDDEN_FILE_ACCESS",
    });
  }

  if (!isTaskFileAlias(alias)) {
    throw new AppError("不支持的文件类型。", {
      statusCode: 400,
      code: "INVALID_FILE_ALIAS",
    });
  }
  const fileInfo = getAccessibleTaskFile(task, authUser, alias, "下载");

  const absolutePath = await ensureStoredFileExists(fileInfo.storageKey);
  await streamStoredFileDownload(req, res, absolutePath, fileInfo.originalName);
};

export const createTaskFileDownloadLinkHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const taskId = parsePositiveInteger(getSingleRouteParam(req.params.taskId, "taskId"), "taskId");
  const alias = getSingleRouteParam(req.params.fileAlias, "fileAlias");
  const task = await findTaskById(taskId);

  if (!task) {
    throw new AppError("任务不存在。", {
      statusCode: 404,
      code: "TASK_NOT_FOUND",
    });
  }

  if (!isTaskFileAlias(alias)) {
    throw new AppError("不支持的文件类型。", {
      statusCode: 400,
      code: "INVALID_FILE_ALIAS",
    });
  }

  // 这里复用真实下载权限校验，避免复制链接绕过角色限制。
  getAccessibleTaskFile(task, authUser, alias, "下载");

  const env = req.app.get("envConfig") as {
    downloadLinkSecret: string;
    downloadLinkTtlMs: number;
  };
  const expiresAt = Date.now() + env.downloadLinkTtlMs;
  const signature = createDownloadLinkSignature(
    taskId,
    alias,
    expiresAt,
    env.downloadLinkSecret,
  );
  const url = buildAbsoluteUrl(
    req,
    `${DOWNLOAD_LINK_ROUTE}?taskId=${taskId}&fileAlias=${alias}&expiresAt=${expiresAt}&signature=${encodeURIComponent(signature)}`,
  );

  res.json({
    url,
    expiresAt: new Date(expiresAt).toISOString(),
  });
};

export const publicDownloadTaskFileHandler: RequestHandler = async (req, res) => {
  const taskIdRaw = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
  const fileAlias = typeof req.query.fileAlias === "string" ? req.query.fileAlias : undefined;
  const expiresAtRaw = typeof req.query.expiresAt === "string" ? req.query.expiresAt : undefined;
  const signature = typeof req.query.signature === "string" ? req.query.signature : undefined;

  if (!taskIdRaw) {
    throw new AppError("下载链接缺少任务编号。", {
      statusCode: 400,
      code: "INVALID_DOWNLOAD_LINK",
    });
  }

  const taskId = parsePositiveInteger(taskIdRaw, "taskId");

  if (!fileAlias || !isTaskFileAlias(fileAlias)) {
    throw new AppError("不支持的文件类型。", {
      statusCode: 400,
      code: "INVALID_FILE_ALIAS",
    });
  }

  if (!expiresAtRaw || !signature) {
    throw new AppError("下载链接缺少必要参数。", {
      statusCode: 400,
      code: "INVALID_DOWNLOAD_LINK",
    });
  }

  const expiresAt = Number(expiresAtRaw);

  if (!Number.isInteger(expiresAt)) {
    throw new AppError("下载链接参数不正确。", {
      statusCode: 400,
      code: "INVALID_DOWNLOAD_LINK",
    });
  }

  if (expiresAt <= Date.now()) {
    throw new AppError("下载链接已失效，请重新复制。", {
      statusCode: 410,
      code: "DOWNLOAD_LINK_EXPIRED",
    });
  }

  const env = req.app.get("envConfig") as {
    downloadLinkSecret: string;
  };
  const expectedSignature = createDownloadLinkSignature(
    taskId,
    fileAlias,
    expiresAt,
    env.downloadLinkSecret,
  );

  if (
    signature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  ) {
    throw new AppError("下载链接无效或已被篡改。", {
      statusCode: 403,
      code: "INVALID_DOWNLOAD_LINK",
    });
  }

  const task = await findTaskById(taskId);

  if (!task) {
    throw new AppError("任务不存在。", {
      statusCode: 404,
      code: "TASK_NOT_FOUND",
    });
  }

  const fileInfo = getTaskFileInfo(task, fileAlias);

  if (!fileInfo.storageKey || !fileInfo.originalName) {
    throw new AppError("任务文件不存在。", {
      statusCode: 404,
      code: "TASK_FILE_NOT_FOUND",
    });
  }

  const absolutePath = await ensureStoredFileExists(fileInfo.storageKey);
  await streamStoredFileDownload(req, res, absolutePath, fileInfo.originalName);
};

export const listTaskFilePreviewHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const taskId = parsePositiveInteger(getSingleRouteParam(req.params.taskId, "taskId"), "taskId");
  const alias = getSingleRouteParam(req.params.fileAlias, "fileAlias") as TaskFileAlias;
  const task = await findTaskById(taskId);

  if (!task) {
    throw new AppError("任务不存在。", {
      statusCode: 404,
      code: "TASK_NOT_FOUND",
    });
  }

  const { absolutePath } = await getPreviewableTaskFile(task, authUser, alias);
  const pagination = parsePaginationQuery(req.query, {
    page: 1,
    pageSize: 24,
  });
  const pageSize = Math.min(Math.max(pagination.pageSize, 1), 60);
  const items = await listZipPreviewItems(absolutePath, FILE_LABELS[alias]);
  const totalPages = items.length === 0 ? 0 : Math.ceil(items.length / pageSize);
  const page = totalPages > 0 ? Math.min(pagination.page, totalPages) : pagination.page;
  const startIndex = (page - 1) * pageSize;
  const pagedItems = items.slice(startIndex, startIndex + pageSize).map((item) => ({
    ...item,
    endpoint: `/api/v1/tasks/${task.id}/files/${alias}/preview/${item.id}`,
  }));

  res.json({
    items: pagedItems,
    pagination: buildPaginationMeta(page, pageSize, items.length),
  });
};

export const previewTaskFileImageHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const taskId = parsePositiveInteger(getSingleRouteParam(req.params.taskId, "taskId"), "taskId");
  const alias = getSingleRouteParam(req.params.fileAlias, "fileAlias") as TaskFileAlias;
  const entryId = getSingleRouteParam(req.params.entryId, "entryId");
  const task = await findTaskById(taskId);

  if (!task) {
    throw new AppError("任务不存在。", {
      statusCode: 404,
      code: "TASK_NOT_FOUND",
    });
  }

  const { absolutePath } = await getPreviewableTaskFile(task, authUser, alias);
  const previewFile = await openZipPreviewStream(absolutePath, entryId, FILE_LABELS[alias]);

  res.setHeader("Content-Type", previewFile.mimeType);
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(previewFile.fileName)}`,
  );
  res.setHeader("Cache-Control", "private, no-store");

  // 预览图片按条目流式输出，避免一次性把整张图读入内存。
  await pipeline(previewFile.stream, res);
};
