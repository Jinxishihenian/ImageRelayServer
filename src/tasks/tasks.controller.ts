import type { RequestHandler } from "express";

import {
  buildPaginationMeta,
  parsePaginationQuery,
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
  listTasksForUser,
  type TaskRow,
} from "./tasks.repository.js";

const ARCHIVE_EXTENSIONS = [".zip", ".rar", ".7z"];

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
  if (user.role === "admin") {
    return true;
  }

  return [task.cleanerId, task.annotatorId, task.trainerId].includes(user.id);
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

function getFileExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf(".");

  if (lastDotIndex < 0) {
    return "";
  }

  return fileName.slice(lastDotIndex).toLowerCase();
}

function isArchiveFileName(fileName: string): boolean {
  return ARCHIVE_EXTENSIONS.includes(getFileExtension(fileName));
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

export const listTasksHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const pagination = parsePaginationQuery(req.query);
  const taskPage = await listTasksForUser(authUser, pagination);

  res.json({
    items: taskPage.items.map((task) => mapTaskSummary(task, authUser)),
    pagination: buildPaginationMeta(taskPage.page, taskPage.pageSize, taskPage.total),
    summary: taskPage.summary,
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

  if (!["source", "cleaned", "annotated", "model"].includes(alias)) {
    throw new AppError("不支持的文件类型。", {
      statusCode: 400,
      code: "INVALID_FILE_ALIAS",
    });
  }

  if (authUser.role !== "admin" && !getAllowedFileAliases(authUser.role).includes(alias)) {
    throw new AppError("当前角色无权下载该文件。", {
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

  const absolutePath = await ensureStoredFileExists(fileInfo.storageKey);

  res.download(absolutePath, fileInfo.originalName);
};
