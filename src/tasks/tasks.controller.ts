import fs from "node:fs";
import { pipeline } from "node:stream/promises";

import type { RequestHandler, Response } from "express";

import {
  buildCleanedArchiveDownloadFileName,
  canPreviewTaskArchive,
  getFileExtension,
  isArchiveFileName,
  isJsonFileName,
  listZipPreviewItems,
  openZipPreviewStream,
  resolveCleanedManifestSelection,
  streamSelectedEntriesAsZip,
  ZIP_EXTENSION,
} from "../files/archive-utils.js";
import {
  buildDownloadUrl,
  createSignedDownloadSignature,
  isValidSignedDownloadSignature,
  streamStoredFileDownload,
} from "../files/download-utils.js";
import {
  buildPaginationMeta,
  parsePaginationQuery,
  parseOptionalString,
  parsePositiveInteger,
} from "../common/http.js";
import {
  DATASET_STAGE_LABELS,
  FILE_LABELS,
  REVIEW_STAGE_LABELS,
  REVIEW_STATUS_LABELS,
  ROLE_LABELS,
  STATUS_LABELS,
  getAllowedFileAliases,
  getApprovalStages,
  getNextStatus,
  getReviewActionLabel,
  getStageReviewRequired,
  getStageByStatus,
  getStageRole,
} from "../common/role-status.js";
import { withTransaction } from "../database/mysql.js";
import {
  attachGeneratedDatasetVersion,
  attachTaskDatasetLinks,
} from "./tasks.repository.js";
import {
  createDataset,
  createDatasetVersion,
  findDatasetVersionsByTaskId,
  updateDatasetCurrentVersion,
  type DatasetVersionRow,
} from "../datasets/datasets.repository.js";
import {
  ensureStoredFileExists,
  getStoredFileSize,
  moveTempUploadToTask,
  resolveTaskUploadReference,
} from "../files/file-storage.js";
import {
  clearModelIterationTaskReferences,
  findModelIterationById,
  updateModelIterationLatestTask,
} from "../model-iterations/model-iterations.repository.js";
import type {
  AuthenticatedUser,
  DatasetStage,
  TaskFileAlias,
  TaskReviewStatus,
  TaskReviewStage,
  UploadedFileRef,
  UserRole,
} from "../types/domain.js";
import { AppError } from "../utils/app-error.js";
import { getAuthUser } from "../auth/auth.middleware.js";
import { findUsersByIds } from "../users/users.repository.js";
import {
  attachSourceFile,
  approveTaskReview,
  completeTaskStage,
  createTask,
  deleteTaskById,
  findTaskById,
  listModels,
  listTasksForUser,
  rejectTaskReview,
  saveTaskStageDraft,
  type ModelListItem,
  type TaskRow,
} from "./tasks.repository.js";
import {
  TASK_REVIEW_STATUSES,
  TASK_REVIEW_STAGES,
  TASK_STATUSES,
  type TaskStatus,
} from "../types/domain.js";
import { canUserAccessTask } from "./task-visibility.js";

const DOWNLOAD_LINK_ROUTE = "/api/v1/public/task-files/download";
const CURRENT_STAGE_DRAFT_DOWNLOAD_LINK_ROUTE = "/api/v1/public/task-stage-drafts/download";

type TaskStageDraftStage = Extract<TaskReviewStage, "clean" | "annotate" | "train">;

const STAGE_DRAFT_STAGE_ALIASES: Record<string, TaskStageDraftStage> = {
  clean: "clean",
  cleaned: "clean",
  annotate: "annotate",
  annotated: "annotate",
  train: "train",
  model: "train",
};

type StageDraftSnapshot = {
  stage: TaskStageDraftStage;
  storageKey: string;
  fileName: string;
  remark: string | null;
  savedAt: string | null;
  ready: boolean;
};

type TaskStageDraftView = StageDraftSnapshot & {
  size: number;
  canPreview: boolean;
  previewEndpoint: string | null;
  downloadEndpoint: string;
  downloadLinkEndpoint: string;
};

function buildDatasetVersionLabel(versionNo: number, stage: DatasetStage): string {
  return `v${versionNo}_${stage}`;
}

function getTaskDatasetVersionsByStage(versions: DatasetVersionRow[]) {
  return {
    raw: versions.find((version) => version.stage === "raw") ?? null,
    cleaned: versions.find((version) => version.stage === "cleaned") ?? null,
    annotated: versions.find((version) => version.stage === "annotated") ?? null,
  };
}

function getTaskFileDownloadName(task: Pick<TaskRow, "sourceFileName">, alias: TaskFileAlias, originalName: string): string {
  if (alias === "cleaned" && isJsonFileName(originalName)) {
    return buildCleanedArchiveDownloadFileName(task.sourceFileName);
  }

  return originalName;
}

function canPreviewTaskFile(task: Pick<TaskRow, "sourceFileName">, alias: TaskFileAlias, originalName: string): boolean {
  if (alias === "cleaned" && isJsonFileName(originalName)) {
    return getFileExtension(task.sourceFileName ?? "") === ZIP_EXTENSION;
  }

  return canPreviewTaskArchive(alias, originalName);
}

async function buildTaskDatasetSnapshot(task: TaskRow) {
  if (!task.datasetId || !task.datasetName) {
    return null;
  }

  const versions = await findDatasetVersionsByTaskId(task.id);
  const versionsByStage = getTaskDatasetVersionsByStage(versions);
  const currentVersion = versions[versions.length - 1] ?? null;

  return {
    id: task.datasetId,
    name: task.datasetName,
    currentVersion: currentVersion
      ? {
          id: currentVersion.id,
          versionNo: currentVersion.versionNo,
          stage: currentVersion.stage,
          stageLabel: currentVersion.stageLabel,
          label: buildDatasetVersionLabel(currentVersion.versionNo, currentVersion.stage),
        }
      : null,
    versions: versions.map((version) => ({
      id: version.id,
      versionNo: version.versionNo,
      stage: version.stage,
      stageLabel: version.stageLabel,
      label: buildDatasetVersionLabel(version.versionNo, version.stage),
      parentVersionId: version.parentVersionId,
      parentVersionLabel:
        version.parentVersionNo && version.parentVersionId
          ? buildDatasetVersionLabel(
              version.parentVersionNo,
              version.stage === "cleaned" ? "raw" : "cleaned",
            )
          : null,
      reviewBased: version.reviewBased,
      createdBy: version.createdBy,
      createdAt: version.createdAt,
      fileName: version.stage === "cleaned"
        ? getTaskFileDownloadName(task, "cleaned", version.fileName)
        : version.fileName,
      sourceTaskId: version.sourceTaskId,
    })),
    keyVersions: {
      raw: versionsByStage.raw
        ? {
            id: versionsByStage.raw.id,
            label: buildDatasetVersionLabel(versionsByStage.raw.versionNo, versionsByStage.raw.stage),
            stage: versionsByStage.raw.stage,
            stageLabel: versionsByStage.raw.stageLabel,
            createdAt: versionsByStage.raw.createdAt,
          }
        : null,
      cleaned: versionsByStage.cleaned
        ? {
            id: versionsByStage.cleaned.id,
            label: buildDatasetVersionLabel(
              versionsByStage.cleaned.versionNo,
              versionsByStage.cleaned.stage,
            ),
            stage: versionsByStage.cleaned.stage,
            stageLabel: versionsByStage.cleaned.stageLabel,
            createdAt: versionsByStage.cleaned.createdAt,
          }
        : null,
      annotated: versionsByStage.annotated
        ? {
            id: versionsByStage.annotated.id,
            label: buildDatasetVersionLabel(
              versionsByStage.annotated.versionNo,
              versionsByStage.annotated.stage,
            ),
            stage: versionsByStage.annotated.stage,
            stageLabel: versionsByStage.annotated.stageLabel,
            createdAt: versionsByStage.annotated.createdAt,
          }
        : null,
    },
  };
}

async function createRawDatasetForTask(input: {
  taskId: number;
  taskTitle: string;
  taskDescription: string;
  sourceFile: UploadedFileRef;
  creatorId: number;
}) {
  return withTransaction(async (connection) => {
    const datasetId = await createDataset(
      {
        taskId: input.taskId,
        name: `${input.taskTitle} 数据集`,
        description: input.taskDescription,
        modality: "image",
        taskType: "task_dataset_phase1",
        creatorId: input.creatorId,
      },
      connection,
    );

    const rawVersionId = await createDatasetVersion(
      {
        datasetId,
        versionNo: 1,
        stage: "raw",
        parentVersionId: null,
        sourceTaskId: input.taskId,
        storageKey: input.sourceFile.storageKey,
        fileName: input.sourceFile.originalName,
        reviewBased: false,
        createdBy: input.creatorId,
      },
      connection,
    );

    await updateDatasetCurrentVersion(datasetId, rawVersionId, connection);
    await attachTaskDatasetLinks(
      {
        taskId: input.taskId,
        datasetId,
        rawDatasetVersionId: rawVersionId,
      },
      connection,
    );
  });
}

async function generateTaskDatasetVersionIfNeeded(input: {
  task: TaskRow;
  stage: Extract<DatasetStage, "cleaned" | "annotated">;
  storageKey: string;
  fileName: string;
  reviewBased: boolean;
  createdBy: number;
}) {
  if (!input.task.datasetId) {
    return;
  }

  const existingVersions = await findDatasetVersionsByTaskId(input.task.id);
  const alreadyExists = existingVersions.some((version) => version.stage === input.stage);

  if (alreadyExists) {
    return;
  }

  const parentVersion =
    input.stage === "cleaned"
      ? existingVersions.find((version) => version.stage === "raw") ?? null
      : existingVersions.find((version) => version.stage === "cleaned") ?? null;

  if (!parentVersion) {
    return;
  }

  const nextVersionNo = existingVersions.length + 1;
  const versionId = await createDatasetVersion({
    datasetId: input.task.datasetId,
    versionNo: nextVersionNo,
    stage: input.stage,
    parentVersionId: parentVersion.id,
    sourceTaskId: input.task.id,
    storageKey: input.storageKey,
    fileName: input.fileName,
    reviewBased: input.reviewBased,
    createdBy: input.createdBy,
  });

  await updateDatasetCurrentVersion(input.task.datasetId, versionId);
  await attachGeneratedDatasetVersion({
    taskId: input.task.id,
    stage: input.stage,
    datasetVersionId: versionId,
  });
}

export function buildTaskFileDownloadUrl(routePath: string, fileBaseUrl?: string): string {
  return buildDownloadUrl(routePath, fileBaseUrl);
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

  // 当前阶段开启审批并进入待审核后，执行人不可重复提交；驳回后允许原负责人重新提交。
  if (task.reviewStatus === "pending_admin_review") {
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

function getTaskApprovalFlags(task: TaskRow) {
  return {
    needCleanReview: task.needCleanReview,
    needAnnotateReview: task.needAnnotateReview,
    needTrainReview: task.needTrainReview,
  };
}

function getCurrentStageNeedsReview(task: TaskRow): boolean {
  return getStageReviewRequired(task.status, getTaskApprovalFlags(task));
}

function canAdminReviewCurrentStage(task: TaskRow, user: AuthenticatedUser): boolean {
  return (
    user.role === "admin" &&
    getCurrentStageNeedsReview(task) &&
    task.reviewStatus === "pending_admin_review" &&
    task.reviewStage !== null
  );
}

function canResubmitCurrentStage(task: TaskRow, user: AuthenticatedUser): boolean {
  const stageRole = getStageRole(task.status);

  if (!stageRole || task.reviewStatus !== "rejected" || user.role !== stageRole) {
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

function getTaskOwnedResultAlias(
  task: TaskRow,
  user: AuthenticatedUser,
): TaskFileAlias | null {
  // 任务完成后，执行人仍应能回看自己在该任务中提交的阶段产物。
  // 这里单独补齐“本人提交结果”的可见性，避免只能按固定角色白名单看前序输入。
  if (user.role === "cleaner" && task.cleanerId === user.id) {
    return "cleaned";
  }

  if (user.role === "annotator" && task.annotatorId === user.id) {
    return "annotated";
  }

  if (user.role === "trainer" && task.trainerId === user.id) {
    return "model";
  }

  return null;
}

function getCurrentStageDraft(task: TaskRow): StageDraftSnapshot | null {
  switch (task.status) {
    case "pending_clean":
      return task.cleanedDraftFile && task.cleanedDraftFileName
        ? {
            stage: "clean",
            storageKey: task.cleanedDraftFile,
            fileName: task.cleanedDraftFileName,
            remark: task.cleanerDraftRemark,
            savedAt: task.cleanedDraftSavedAt,
            ready: task.cleanedDraftReady,
          }
        : null;
    case "pending_annotate":
      return task.annotatedDraftFile && task.annotatedDraftFileName
        ? {
            stage: "annotate",
            storageKey: task.annotatedDraftFile,
            fileName: task.annotatedDraftFileName,
            remark: task.annotatorDraftRemark,
            savedAt: task.annotatedDraftSavedAt,
            ready: task.annotatedDraftReady,
          }
        : null;
    case "pending_train":
      return task.modelDraftFile && task.modelDraftFileName
        ? {
            stage: "train",
            storageKey: task.modelDraftFile,
            fileName: task.modelDraftFileName,
            remark: task.trainerDraftRemark,
            savedAt: task.modelDraftSavedAt,
            ready: task.modelDraftReady,
          }
        : null;
    case "finished":
      return null;
  }
}

export function parseTaskStageDraftStage(value: unknown): TaskStageDraftStage {
  const normalizedStage = parseOptionalString(value, "stage")?.toLowerCase();
  const resolvedStage = normalizedStage ? STAGE_DRAFT_STAGE_ALIASES[normalizedStage] : undefined;

  if (resolvedStage) {
    return resolvedStage;
  }

  console.warn("Invalid stage draft stage query.", {
    rawStage: value,
    normalizedStage,
    acceptedStages: Object.keys(STAGE_DRAFT_STAGE_ALIASES),
  });

  if (normalizedStage === "clean" || normalizedStage === "annotate" || normalizedStage === "train") {
    return normalizedStage;
  }

  throw new AppError("当前阶段草稿参数无效。", {
    statusCode: 400,
    code: "INVALID_STAGE_DRAFT_STAGE",
  });
}

function buildCurrentStageDraftDownloadName(task: TaskRow, draft: StageDraftSnapshot): string {
  if (draft.stage === "clean") {
    return getTaskFileDownloadName(task, "cleaned", draft.fileName);
  }

  return draft.fileName;
}

function canPreviewCurrentStageDraft(task: TaskRow, draft: StageDraftSnapshot): boolean {
  if (draft.stage === "clean") {
    return canPreviewTaskFile(task, "cleaned", draft.fileName);
  }

  if (draft.stage === "annotate") {
    return canPreviewTaskFile(task, "annotated", draft.fileName);
  }

  return false;
}

async function buildCurrentStageDraftView(
  task: TaskRow,
  user: AuthenticatedUser,
): Promise<TaskStageDraftView | null> {
  if (!canViewCurrentStageDraft(task, user)) {
    return null;
  }

  const draft = getCurrentStageDraft(task);

  if (!draft) {
    return null;
  }

  const size = await getStoredFileSize(draft.storageKey);
  const canPreview = canPreviewCurrentStageDraft(task, draft);

  return {
    ...draft,
    size,
    canPreview,
    previewEndpoint: canPreview
      ? `/api/v1/tasks/${task.id}/stage-draft/preview?stage=${draft.stage}`
      : null,
    // 草稿下载保持独立路由，避免与正式产物 alias 复用后在任务流转时语义混淆。
    downloadEndpoint: `/api/v1/tasks/${task.id}/stage-draft/download?stage=${draft.stage}`,
    downloadLinkEndpoint: `/api/v1/tasks/${task.id}/stage-draft/download-link?stage=${draft.stage}`,
  };
}

function getStageDraftSnapshotByStage(task: TaskRow, stage: TaskStageDraftStage): StageDraftSnapshot | null {
  switch (stage) {
    case "clean":
      return task.cleanedDraftFile && task.cleanedDraftFileName
        ? {
            stage: "clean",
            storageKey: task.cleanedDraftFile,
            fileName: task.cleanedDraftFileName,
            remark: task.cleanerDraftRemark,
            savedAt: task.cleanedDraftSavedAt,
            ready: task.cleanedDraftReady,
          }
        : null;
    case "annotate":
      return task.annotatedDraftFile && task.annotatedDraftFileName
        ? {
            stage: "annotate",
            storageKey: task.annotatedDraftFile,
            fileName: task.annotatedDraftFileName,
            remark: task.annotatorDraftRemark,
            savedAt: task.annotatedDraftSavedAt,
            ready: task.annotatedDraftReady,
          }
        : null;
    case "train":
      return task.modelDraftFile && task.modelDraftFileName
        ? {
            stage: "train",
            storageKey: task.modelDraftFile,
            fileName: task.modelDraftFileName,
            remark: task.trainerDraftRemark,
            savedAt: task.modelDraftSavedAt,
            ready: task.modelDraftReady,
          }
        : null;
  }
}

function assertCanAccessStageDraft(task: TaskRow, user: AuthenticatedUser, stage: TaskStageDraftStage): StageDraftSnapshot {
  if (!canAccessTask(task, user)) {
    throw new AppError("当前用户无权访问该任务草稿。", {
      statusCode: 403,
      code: "FORBIDDEN_FILE_ACCESS",
    });
  }

  const draft = getStageDraftSnapshotByStage(task, stage);

  if (!draft) {
    throw new AppError("当前阶段草稿不存在。", {
      statusCode: 404,
      code: "TASK_STAGE_DRAFT_NOT_FOUND",
    });
  }

  const allowedRoles: UserRole[] = ["admin"];

  switch (stage) {
    case "clean":
      if (task.cleanerId === user.id) {
        allowedRoles.push("cleaner");
      }
      break;
    case "annotate":
      if (task.annotatorId === user.id) {
        allowedRoles.push("annotator");
      }
      break;
    case "train":
      if (task.trainerId === user.id) {
        allowedRoles.push("trainer");
      }
      break;
  }

  if (!allowedRoles.includes(user.role)) {
    throw new AppError("当前角色无权访问该阶段草稿。", {
      statusCode: 403,
      code: "FORBIDDEN_FILE_ACCESS",
    });
  }

  return draft;
}

async function getPreviewableStageDraftFile(
  task: TaskRow,
  user: AuthenticatedUser,
  stage: TaskStageDraftStage,
): Promise<
  | {
      mode: "archive";
      absolutePath: string;
      originalName: string;
      previewLabel: string;
    }
  | {
      mode: "manifest";
      sourceArchiveAbsolutePath: string;
      originalName: string;
      previewItems: Awaited<ReturnType<typeof resolveCleanedManifestSelection>>["previewItems"];
      previewLabel: string;
    }
> {
  const draft = assertCanAccessStageDraft(task, user, stage);

  if (!canPreviewCurrentStageDraft(task, draft)) {
    throw new AppError("当前阶段草稿暂不支持预览。", {
      statusCode: 400,
      code: "UNSUPPORTED_PREVIEW_ALIAS",
    });
  }

  if (stage === "clean" && isJsonFileName(draft.fileName)) {
    const manifestBackedFile = await resolveManifestBackedCleanedTaskFile(task, draft.storageKey);

    return {
      mode: "manifest",
      sourceArchiveAbsolutePath: manifestBackedFile.sourceArchiveAbsolutePath,
      originalName: draft.fileName,
      previewItems: manifestBackedFile.previewItems,
      previewLabel: FILE_LABELS.source,
    };
  }

  return {
    mode: "archive",
    absolutePath: await ensureStoredFileExists(draft.storageKey),
    originalName: draft.fileName,
    previewLabel: stage === "annotate" ? FILE_LABELS.annotated : FILE_LABELS.cleaned,
  };
}

async function streamStageDraftDownloadResponse(
  req: Parameters<RequestHandler>[0],
  res: Response,
  task: TaskRow,
  draft: StageDraftSnapshot,
): Promise<void> {
  if (draft.stage === "clean" && isJsonFileName(draft.fileName)) {
    const manifestBackedFile = await resolveManifestBackedCleanedTaskFile(task, draft.storageKey);

    if (req.headers.range) {
      throw new AppError("动态生成的清洗结果暂不支持断点续传下载。", {
        statusCode: 416,
        code: "UNSUPPORTED_DYNAMIC_RANGE_DOWNLOAD",
      });
    }

    await streamGeneratedArchiveDownload(
      res,
      buildCurrentStageDraftDownloadName(task, draft),
      async () => {
        await streamSelectedEntriesAsZip({
          sourceArchivePath: manifestBackedFile.sourceArchiveAbsolutePath,
          selectedPaths: manifestBackedFile.selectedPaths,
          sourceArchiveLabel: FILE_LABELS.source,
          target: res,
        });
      },
    );
    return;
  }

  const absolutePath = await ensureStoredFileExists(draft.storageKey);
  await streamStoredFileDownload(req, res, absolutePath, buildCurrentStageDraftDownloadName(task, draft));
}

function canViewCurrentStageDraft(task: TaskRow, user: AuthenticatedUser): boolean {
  if (!canHandleCurrentStage(task, user) && !canResubmitCurrentStage(task, user)) {
    return false;
  }

  return getCurrentStageDraft(task) !== null;
}

export function getAccessibleTaskFileAliases(
  task: TaskRow,
  user: AuthenticatedUser,
): TaskFileAlias[] {
  if (user.role === "admin") {
    return getAllowedFileAliases("admin");
  }

  const aliases = new Set<TaskFileAlias>(getAllowedFileAliases(user.role));
  const ownedResultAlias = getTaskOwnedResultAlias(task, user);

  if (ownedResultAlias) {
    aliases.add(ownedResultAlias);
  }

  return Array.from(aliases);
}

function getDownloadFields(task: TaskRow, user: AuthenticatedUser) {
  return getAccessibleTaskFileAliases(task, user)
    .map((alias) => {
      const file = getTaskFileInfo(task, alias);

      if (!file.storageKey || !file.originalName) {
        return null;
      }

      return {
        alias,
        label: FILE_LABELS[alias],
        fileName: getTaskFileDownloadName(task, alias, file.originalName),
        endpoint: `/api/v1/tasks/${task.id}/files/${alias}/download`,
        canPreview: canPreviewTaskFile(task, alias, file.originalName),
        previewEndpoint: canPreviewTaskFile(task, alias, file.originalName)
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

  if (!getAccessibleTaskFileAliases(task, user).includes(alias)) {
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

function buildAttachmentDisposition(fileName: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

async function streamGeneratedArchiveDownload(
  res: Response,
  fileName: string,
  streamArchive: () => Promise<void>,
): Promise<void> {
  // 动态生成的清洗结果并不存在磁盘成品文件，直接流式写出 zip，避免重复落盘。
  res.status(200);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", buildAttachmentDisposition(fileName));
  res.setHeader("Cache-Control", "private, no-store");

  await streamArchive();
  res.end();
}

async function streamTaskFileDownloadResponse(
  req: Parameters<RequestHandler>[0],
  res: Response,
  task: TaskRow,
  alias: TaskFileAlias,
  fileInfo: {
    storageKey: string;
    originalName: string;
  },
): Promise<void> {
  if (alias === "cleaned" && isJsonFileName(fileInfo.originalName)) {
    const manifestBackedFile = await resolveManifestBackedCleanedTaskFile(task, fileInfo.storageKey);

    if (req.headers.range) {
      throw new AppError("动态生成的清洗结果暂不支持断点续传下载。", {
        statusCode: 416,
        code: "UNSUPPORTED_DYNAMIC_RANGE_DOWNLOAD",
      });
    }

    await streamGeneratedArchiveDownload(
      res,
      buildCleanedArchiveDownloadFileName(task.sourceFileName),
      async () => {
        await streamSelectedEntriesAsZip({
          sourceArchivePath: manifestBackedFile.sourceArchiveAbsolutePath,
          selectedPaths: manifestBackedFile.selectedPaths,
          sourceArchiveLabel: FILE_LABELS.source,
          target: res,
        });
      },
    );
    return;
  }

  const absolutePath = await ensureStoredFileExists(fileInfo.storageKey);
  await streamStoredFileDownload(req, res, absolutePath, fileInfo.originalName);
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
  const reviewActionLabel = getReviewActionLabel(task.reviewStage);
  const isPendingAdminReview = task.reviewStatus === "pending_admin_review";
  const isRejected = task.reviewStatus === "rejected";
  const approvalStages = getApprovalStages(getTaskApprovalFlags(task));
  const currentStageNeedsReview = getCurrentStageNeedsReview(task);
  const displayStatusLabel = isPendingAdminReview
    ? "等待管理员复核"
    : isRejected
      ? "已驳回待重新提交"
      : STATUS_LABELS[task.status];

  return {
    id: task.id,
    title: task.title,
    description: task.description,
    status: task.status,
    statusLabel: displayStatusLabel,
    needCleanReview: task.needCleanReview,
    needAnnotateReview: task.needAnnotateReview,
    needTrainReview: task.needTrainReview,
    approvalStages,
    currentStageNeedsReview,
    reviewStatus: task.reviewStatus,
    reviewStatusLabel: REVIEW_STATUS_LABELS[task.reviewStatus],
    reviewStage: task.reviewStage,
    reviewStageLabel: task.reviewStage ? REVIEW_STAGE_LABELS[task.reviewStage] : null,
    reviewActionLabel,
    reviewComment: task.reviewComment,
    needsAdminReview: isPendingAdminReview,
    createdAt: task.createdAt,
    finishedAt: task.finishedAt,
    creator: {
      id: task.creatorId,
      username: task.creatorUsername,
    },
    modelIteration: {
      id: task.modelIterationId,
      name: task.modelIterationName,
      status: task.modelIterationStatus,
    },
    dataset: task.datasetId && task.datasetName
      ? {
          id: task.datasetId,
          name: task.datasetName,
          rawVersionId: task.rawDatasetVersionId,
          cleanedVersionId: task.cleanedDatasetVersionId,
          annotatedVersionId: task.annotatedDatasetVersionId,
        }
      : null,
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
    canReview: canAdminReviewCurrentStage(task, user),
    canResubmit: canResubmitCurrentStage(task, user),
  };
}

async function mapTaskDetail(task: TaskRow, user: AuthenticatedUser) {
  const stageRole = getStageRole(task.status);
  const dataset = await buildTaskDatasetSnapshot(task);
  const currentStageDraft = await buildCurrentStageDraftView(task, user);

  return {
    ...mapTaskSummary(task, user),
    remarks: {
      cleaner: task.cleanerRemark,
      annotator: task.annotatorRemark,
      trainer: task.trainerRemark,
    },
    downloads: getDownloadFields(task, user),
    currentStageDraft,
    hasCurrentStageDraft: Boolean(currentStageDraft?.ready),
    canSaveCurrentStageDraft: canHandleCurrentStage(task, user) || canResubmitCurrentStage(task, user),
    canSubmitCurrentStage: canHandleCurrentStage(task, user),
    canReviewCurrentStage: canAdminReviewCurrentStage(task, user),
    canResubmitCurrentStage: canResubmitCurrentStage(task, user),
    currentStage: {
      role: stageRole,
      label: stageRole ? ROLE_LABELS[stageRole] : "流程结束",
    },
    dataset,
  };
}

function parseReviewStage(value: unknown): TaskReviewStage {
  const normalizedStage = parseOptionalString(value, "reviewStage");

  if (!normalizedStage) {
    throw new AppError("缺少有效的复核阶段。", {
      statusCode: 400,
      code: "INVALID_REVIEW_STAGE",
    });
  }

  if (TASK_REVIEW_STAGES.includes(normalizedStage as TaskReviewStage)) {
    return normalizedStage as TaskReviewStage;
  }

  throw new AppError("复核阶段无效。", {
    statusCode: 400,
    code: "INVALID_REVIEW_STAGE",
  });
}

function mapModelListItem(item: ModelListItem) {
  return {
    taskId: item.taskId,
    taskTitle: item.taskTitle,
    modelFileName: item.modelFileName,
    trainerRemark: item.trainerRemark,
    finishedAt: item.finishedAt,
    modelIteration: item.modelIteration,
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

function getStagePersistenceConfig(role: UserRole) {
  switch (role) {
    case "cleaner":
      return {
        draftFileColumn: "cleaned_draft_file" as const,
        draftFileNameColumn: "cleaned_draft_file_name" as const,
        draftRemarkColumn: "cleaner_draft_remark" as const,
        draftSavedAtColumn: "cleaned_draft_saved_at" as const,
        draftReadyColumn: "cleaned_draft_ready" as const,
        finalFileColumn: "cleaned_file" as const,
        finalFileNameColumn: "cleaned_file_name" as const,
        finalRemarkColumn: "cleaner_remark" as const,
        uploadAlias: "cleaned" as const,
        datasetStage: "cleaned" as const,
      };
    case "annotator":
      return {
        draftFileColumn: "annotated_draft_file" as const,
        draftFileNameColumn: "annotated_draft_file_name" as const,
        draftRemarkColumn: "annotator_draft_remark" as const,
        draftSavedAtColumn: "annotated_draft_saved_at" as const,
        draftReadyColumn: "annotated_draft_ready" as const,
        finalFileColumn: "annotated_file" as const,
        finalFileNameColumn: "annotated_file_name" as const,
        finalRemarkColumn: "annotator_remark" as const,
        uploadAlias: "annotated" as const,
        datasetStage: "annotated" as const,
      };
    case "trainer":
      return {
        draftFileColumn: "model_draft_file" as const,
        draftFileNameColumn: "model_draft_file_name" as const,
        draftRemarkColumn: "trainer_draft_remark" as const,
        draftSavedAtColumn: "model_draft_saved_at" as const,
        draftReadyColumn: "model_draft_ready" as const,
        finalFileColumn: "model_file" as const,
        finalFileNameColumn: "model_file_name" as const,
        finalRemarkColumn: "trainer_remark" as const,
        uploadAlias: "model" as const,
        datasetStage: null,
      };
    case "admin":
      throw new AppError("管理员没有阶段草稿配置。", {
        statusCode: 400,
        code: "INVALID_STAGE_OPERATOR",
      });
  }
}

function getDraftSnapshotByRole(task: TaskRow, role: Extract<UserRole, "cleaner" | "annotator" | "trainer">) {
  switch (role) {
    case "cleaner":
      return {
        storageKey: task.cleanedDraftFile,
        originalName: task.cleanedDraftFileName,
        remark: task.cleanerDraftRemark,
        ready: task.cleanedDraftReady,
      };
    case "annotator":
      return {
        storageKey: task.annotatedDraftFile,
        originalName: task.annotatedDraftFileName,
        remark: task.annotatorDraftRemark,
        ready: task.annotatedDraftReady,
      };
    case "trainer":
      return {
        storageKey: task.modelDraftFile,
        originalName: task.modelDraftFileName,
        remark: task.trainerDraftRemark,
        ready: task.modelDraftReady,
      };
  }
}

function buildUploadedFileRefFromDraftSnapshot(draft: ReturnType<typeof getDraftSnapshotByRole>): UploadedFileRef | null {
  if (!draft.ready || !draft.storageKey || !draft.originalName) {
    return null;
  }

  return {
    storageKey: draft.storageKey,
    originalName: draft.originalName,
    mimeType: "application/octet-stream",
    size: 0,
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

async function assertStageDraftFileReferenceAvailable(uploadedFile: UploadedFileRef): Promise<void> {
  try {
    await ensureStoredFileExists(uploadedFile.storageKey);
  } catch (error) {
    if (error instanceof AppError && error.code === "FILE_NOT_FOUND") {
      // 这里单独把“上传引用失效”翻译成业务错误，避免前端把它误解为
      // 清洗 JSON 内容错误，尤其是在重名文件场景下更容易误判问题根因。
      throw new AppError("上传文件不存在或已失效，请重新上传。", {
        statusCode: 400,
        code: uploadedFile.storageKey.startsWith("tmp/")
          ? "UPLOAD_NOT_FOUND"
          : "STAGE_DRAFT_FILE_NOT_FOUND",
        details: {
          storageKey: uploadedFile.storageKey,
        },
      });
    }

    throw error;
  }
}

export async function resolveStageDraftFileReferenceForSave(input: {
  uploadedFile: UploadedFileRef;
  existingDraft: ReturnType<typeof getDraftSnapshotByRole>;
  taskId: number;
  alias: TaskFileAlias;
}): Promise<UploadedFileRef> {
  try {
    return await resolveTaskUploadReference(input.uploadedFile, input.taskId, input.alias);
  } catch (error) {
    const existingDraftFile = buildUploadedFileRefFromDraftSnapshot(input.existingDraft);
    const canFallbackToExistingDraft =
      error instanceof AppError &&
      error.code === "UPLOAD_NOT_FOUND" &&
      input.uploadedFile.storageKey.startsWith("tmp/") &&
      existingDraftFile &&
      existingDraftFile.originalName === input.uploadedFile.originalName;

    if (!canFallbackToExistingDraft || !existingDraftFile) {
      throw error;
    }

    try {
      // 这里仅在“同名临时上传引用失效，但当前任务已经保存过可用草稿”时兜底。
      // 这样可以兼容前端重复提交旧 tmp 引用或只改备注再次保存的场景，
      // 同时避免把一个明确不同文件名的新上传悄悄回退成旧草稿。
      await assertStageDraftFileReferenceAvailable(existingDraftFile);
      return existingDraftFile;
    } catch {
      throw error;
    }
  }
}

async function resolveManifestBackedCleanedTaskFile(
  task: TaskRow,
  manifestStorageKey: string,
): Promise<{
  manifestAbsolutePath: string;
  sourceArchiveAbsolutePath: string;
  previewItems: Awaited<ReturnType<typeof resolveCleanedManifestSelection>>["previewItems"];
  selectedPaths: string[];
}> {
  if (!task.sourceFile || !task.sourceFileName) {
    throw new AppError("当前任务缺少初始文件，无法生成清洗结果。", {
      statusCode: 400,
      code: "TASK_SOURCE_FILE_MISSING",
    });
  }

  if (getFileExtension(task.sourceFileName) !== ZIP_EXTENSION) {
    throw new AppError("当前任务的初始文件不是 zip，暂不支持基于 JSON 清单生成清洗结果。", {
      statusCode: 400,
      code: "UNSUPPORTED_SOURCE_ARCHIVE_TYPE",
    });
  }

  const manifestAbsolutePath = await ensureStoredFileExists(manifestStorageKey);
  const sourceArchiveAbsolutePath = await ensureStoredFileExists(task.sourceFile);
  const selection = await resolveCleanedManifestSelection({
    manifestSource: manifestAbsolutePath,
    sourceArchivePath: sourceArchiveAbsolutePath,
    manifestLabel: FILE_LABELS.cleaned,
    sourceArchiveLabel: FILE_LABELS.source,
  });

  return {
    manifestAbsolutePath,
    sourceArchiveAbsolutePath,
    previewItems: selection.previewItems,
    selectedPaths: selection.selectedPaths,
  };
}

async function getPreviewableTaskFile(
  task: TaskRow,
  user: AuthenticatedUser,
  alias: TaskFileAlias,
): Promise<
  | {
      mode: "archive";
      absolutePath: string;
      originalName: string;
    }
  | {
      mode: "manifest";
      sourceArchiveAbsolutePath: string;
      originalName: string;
      previewItems: Awaited<ReturnType<typeof resolveCleanedManifestSelection>>["previewItems"];
    }
> {
  if (!canAccessTask(task, user)) {
    throw new AppError("当前用户无权预览该文件。", {
      statusCode: 403,
      code: "FORBIDDEN_FILE_ACCESS",
    });
  }

  assertPreviewableTaskAlias(alias);
  const fileInfo = getAccessibleTaskFile(task, user, alias, "预览");

  if (alias === "cleaned" && isJsonFileName(fileInfo.originalName)) {
    const manifestBackedFile = await resolveManifestBackedCleanedTaskFile(task, fileInfo.storageKey);

    return {
      mode: "manifest",
      sourceArchiveAbsolutePath: manifestBackedFile.sourceArchiveAbsolutePath,
      originalName: fileInfo.originalName,
      previewItems: manifestBackedFile.previewItems,
    };
  }

  if (getFileExtension(fileInfo.originalName) !== ".zip") {
    throw new AppError("当前压缩包格式暂不支持预览，当前仅支持 zip 预览。", {
      statusCode: 400,
      code: "UNSUPPORTED_PREVIEW_ARCHIVE_TYPE",
    });
  }

  return {
    mode: "archive",
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

function parseOptionalTaskReviewStatus(value: unknown): TaskReviewStatus | undefined {
  const normalizedReviewStatus = parseOptionalString(value, "reviewStatus");

  if (!normalizedReviewStatus) {
    return undefined;
  }

  if (TASK_REVIEW_STATUSES.includes(normalizedReviewStatus as TaskReviewStatus)) {
    return normalizedReviewStatus as TaskReviewStatus;
  }

  throw new AppError("reviewStatus 查询参数无效。", {
    statusCode: 400,
    code: "INVALID_TASK_REVIEW_STATUS",
    details: {
      field: "reviewStatus",
    },
  });
}

export const listTasksHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const pagination = parsePaginationQuery(req.query);
  const keyword = parseOptionalString(req.query.keyword, "keyword");
  const status = parseOptionalTaskStatus(req.query.status);
  const reviewStatus = parseOptionalTaskReviewStatus(req.query.reviewStatus);
  const taskPage = await listTasksForUser(authUser, {
    ...pagination,
    keyword,
    status,
    reviewStatus,
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
  const modelIterationIdRaw = parseOptionalString(req.query.modelIterationId, "modelIterationId");
  const modelIterationId = modelIterationIdRaw
    ? parsePositiveInteger(modelIterationIdRaw, "modelIterationId")
    : undefined;
  const modelPage = await listModels({
    ...pagination,
    keyword,
    modelIterationId,
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

  res.json(await mapTaskDetail(task, authUser));
};

export const createTaskHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const {
    title,
    description,
    needCleanReview,
    needAnnotateReview,
    needTrainReview,
    cleanerId,
    annotatorId,
    trainerId,
    modelIterationId,
    sourceFile,
  } = req.body as {
    title?: string;
    description?: string;
    needCleanReview?: boolean;
    needAnnotateReview?: boolean;
    needTrainReview?: boolean;
    cleanerId?: number;
    annotatorId?: number;
    trainerId?: number;
    modelIterationId?: number;
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
  const normalizedModelIterationId = Number(modelIterationId);

  if (![cleanerUserId, annotatorUserId, trainerUserId, normalizedModelIterationId].every(Number.isInteger)) {
    throw new AppError("任务负责人不能为空。", {
      statusCode: 400,
      code: "INVALID_TASK_ASSIGNEES",
    });
  }

  const modelIteration = await findModelIterationById(normalizedModelIterationId);

  if (!modelIteration) {
    throw new AppError("所选模型迭代不存在。", {
      statusCode: 400,
      code: "INVALID_MODEL_ITERATION",
    });
  }

  if (modelIteration.status !== "active") {
    throw new AppError("仅进行中的模型迭代可用于创建任务。", {
      statusCode: 400,
      code: "INACTIVE_MODEL_ITERATION",
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
    modelIterationId: normalizedModelIterationId,
    title: title.trim(),
    description: description?.trim() ?? "",
    needCleanReview: Boolean(needCleanReview),
    needAnnotateReview: Boolean(needAnnotateReview),
    needTrainReview: Boolean(needTrainReview),
    creatorId: authUser.id,
    cleanerId: cleanerUserId,
    annotatorId: annotatorUserId,
    trainerId: trainerUserId,
  });

  try {
    const storedSourceFile = await moveTempUploadToTask(uploadedSourceFile, taskId, "source");
    await attachSourceFile(taskId, storedSourceFile.storageKey, storedSourceFile.originalName);
    await createRawDatasetForTask({
      taskId,
      taskTitle: title.trim(),
      taskDescription: description?.trim() ?? "",
      sourceFile: storedSourceFile,
      creatorId: authUser.id,
    });
  } catch (error) {
    await deleteTaskById(taskId);
    throw error;
  }

  const createdTask = await findTaskById(taskId);

  res.status(201).json({
    item: createdTask ? await mapTaskDetail(createdTask, authUser) : null,
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
  await clearModelIterationTaskReferences(taskId);
  await deleteTaskById(taskId);

  res.status(204).send();
};

export const saveTaskStageDraftHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const taskId = parsePositiveInteger(getSingleRouteParam(req.params.taskId, "taskId"), "taskId");
  const task = await findTaskById(taskId);

  if (!task) {
    throw new AppError("任务不存在。", {
      statusCode: 404,
      code: "TASK_NOT_FOUND",
    });
  }

  if (!canHandleCurrentStage(task, authUser) && !canResubmitCurrentStage(task, authUser)) {
    throw new AppError("当前任务不允许由你保存草稿。", {
      statusCode: 403,
      code: "INVALID_STAGE_OPERATOR",
    });
  }

  if (task.status === "finished") {
    throw new AppError("已完成任务不可保存阶段草稿。", {
      statusCode: 400,
      code: "TASK_ALREADY_FINISHED",
    });
  }

  const role = authUser.role;

  if (role === "admin") {
    throw new AppError("管理员不能保存阶段草稿。", {
      statusCode: 403,
      code: "INVALID_STAGE_OPERATOR",
    });
  }

  const { file, remark } = req.body as {
    file?: unknown;
    remark?: string;
  };

  const normalizedRemark = remark?.trim() ?? "";
  const stageConfig = getStagePersistenceConfig(role);
  const existingDraft = getDraftSnapshotByRole(task, role);
  let uploadedFile = file ? parseUploadedFile(file) : null;

  if (!uploadedFile && existingDraft.storageKey && existingDraft.originalName) {
    uploadedFile = buildUploadedFileRefFromDraftSnapshot(existingDraft);
  }

  if (!uploadedFile) {
    throw new AppError("请先上传阶段结果文件。", {
      statusCode: 400,
      code: "INVALID_FILE_REFERENCE",
    });
  }

  uploadedFile = await resolveStageDraftFileReferenceForSave({
    uploadedFile,
    existingDraft,
    taskId: task.id,
    alias: stageConfig.uploadAlias,
  });
  await assertStageDraftFileReferenceAvailable(uploadedFile);

  if (role === "cleaner") {
    if (!isJsonFileName(uploadedFile.originalName)) {
      throw new AppError("清洗阶段仅允许上传 JSON 清单文件。", {
        statusCode: 400,
        code: "INVALID_STAGE_FILE_TYPE",
      });
    }

    await resolveManifestBackedCleanedTaskFile(task, uploadedFile.storageKey);
  } else if (role === "annotator") {
    assertArchiveFileName(
      uploadedFile.originalName,
      "标注阶段仅允许上传 zip、rar、7z 压缩包。",
      "INVALID_STAGE_FILE_TYPE",
    );
  }

  const storedFile = uploadedFile.storageKey.startsWith("tmp/")
    ? await moveTempUploadToTask(uploadedFile, task.id, stageConfig.uploadAlias)
    : uploadedFile;

  const updated = await saveTaskStageDraft({
    taskId: task.id,
    currentStatus: task.status,
    draftFileColumn: stageConfig.draftFileColumn,
    draftFileNameColumn: stageConfig.draftFileNameColumn,
    draftRemarkColumn: stageConfig.draftRemarkColumn,
    draftSavedAtColumn: stageConfig.draftSavedAtColumn,
    draftReadyColumn: stageConfig.draftReadyColumn,
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
    item: latestTask ? await mapTaskDetail(latestTask, authUser) : null,
  });
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

  if (authUser.role === "admin") {
    throw new AppError("管理员不能确认提交阶段结果。", {
      statusCode: 403,
      code: "INVALID_STAGE_OPERATOR",
    });
  }

  const stageConfig = getStagePersistenceConfig(authUser.role);
  const currentDraft = getDraftSnapshotByRole(task, authUser.role);

  if (!currentDraft.ready || !currentDraft.storageKey || !currentDraft.originalName) {
    throw new AppError("请先点击完成当前阶段，保存草稿后再确认提交。", {
      statusCode: 400,
      code: "TASK_STAGE_DRAFT_REQUIRED",
    });
  }

  const reviewStage = getStageByStatus(task.status);

  if (!reviewStage) {
    throw new AppError("当前任务不处于可提交阶段。", {
      statusCode: 400,
      code: "INVALID_REVIEW_STAGE",
    });
  }

  const nextStatus = getNextStatus(task.status);
  const updated = await completeTaskStage({
    taskId: task.id,
    requiresReview: getCurrentStageNeedsReview(task),
    reviewStage,
    currentStatus: task.status,
    nextStatus,
    draftFileColumn: stageConfig.draftFileColumn,
    draftFileNameColumn: stageConfig.draftFileNameColumn,
    draftRemarkColumn: stageConfig.draftRemarkColumn,
    draftReadyColumn: stageConfig.draftReadyColumn,
    fileColumn: stageConfig.finalFileColumn,
    fileNameColumn: stageConfig.finalFileNameColumn,
    remarkColumn: stageConfig.finalRemarkColumn,
  });

  if (!updated) {
    throw new AppError("任务状态已变化，请刷新后重试。", {
      statusCode: 409,
      code: "TASK_STATUS_CONFLICT",
    });
  }

  if (!getCurrentStageNeedsReview(task) && stageConfig.datasetStage) {
    await generateTaskDatasetVersionIfNeeded({
      task,
      stage: stageConfig.datasetStage,
      storageKey: currentDraft.storageKey,
      fileName: currentDraft.originalName,
      reviewBased: false,
      createdBy: authUser.id,
    });
  }

  const latestTask = await findTaskById(task.id);

  if (latestTask?.status === "finished") {
    await updateModelIterationLatestTask({
      modelIterationId: latestTask.modelIterationId,
      taskId: latestTask.id,
    });
  }

  res.json({
    item: latestTask ? await mapTaskDetail(latestTask, authUser) : null,
  });
};

export const reviewTaskStageHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const taskId = parsePositiveInteger(getSingleRouteParam(req.params.taskId, "taskId"), "taskId");
  const task = await findTaskById(taskId);

  if (!task) {
    throw new AppError("任务不存在。", {
      statusCode: 404,
      code: "TASK_NOT_FOUND",
    });
  }

  if (!canAdminReviewCurrentStage(task, authUser)) {
    throw new AppError("当前任务暂无可复核内容。", {
      statusCode: 403,
      code: "INVALID_REVIEW_OPERATOR",
    });
  }

  const { action, reviewComment, reviewStage } = req.body as {
    action?: "approve" | "reject";
    reviewComment?: string;
    reviewStage?: TaskReviewStage;
  };
  const normalizedReviewStage = parseReviewStage(reviewStage);

  if (normalizedReviewStage !== task.reviewStage) {
    throw new AppError("当前复核阶段已变化，请刷新后重试。", {
      statusCode: 409,
      code: "TASK_REVIEW_CONFLICT",
    });
  }

  if (action !== "approve" && action !== "reject") {
    throw new AppError("复核动作无效。", {
      statusCode: 400,
      code: "INVALID_REVIEW_ACTION",
    });
  }

  let updated = false;

  if (action === "approve") {
    updated = await approveTaskReview({
      taskId: task.id,
      currentStatus: task.status,
      nextStatus: getNextStatus(task.status),
      reviewStage: normalizedReviewStage,
      reviewerId: authUser.id,
    });
  } else {
    const normalizedComment = reviewComment?.trim() ?? "";

    if (!normalizedComment) {
      throw new AppError("驳回时必须填写审核意见。", {
        statusCode: 400,
        code: "INVALID_REVIEW_COMMENT",
      });
    }

    updated = await rejectTaskReview({
      taskId: task.id,
      currentStatus: task.status,
      reviewStage: normalizedReviewStage,
      reviewerId: authUser.id,
      reviewComment: normalizedComment,
    });
  }

  if (!updated) {
    throw new AppError("任务复核状态已变化，请刷新后重试。", {
      statusCode: 409,
      code: "TASK_REVIEW_CONFLICT",
    });
  }

  if (action === "approve") {
    const reviewStageToDatasetStage =
      normalizedReviewStage === "clean"
        ? "cleaned"
        : normalizedReviewStage === "annotate"
          ? "annotated"
          : null;

    if (reviewStageToDatasetStage) {
      const storageKey =
        normalizedReviewStage === "clean" ? task.cleanedFile : task.annotatedFile;
      const fileName =
        normalizedReviewStage === "clean" ? task.cleanedFileName : task.annotatedFileName;

      if (storageKey && fileName) {
        await generateTaskDatasetVersionIfNeeded({
          task,
          stage: reviewStageToDatasetStage,
          storageKey,
          fileName,
          reviewBased: true,
          createdBy: authUser.id,
        });
      }
    }
  }

  const latestTask = await findTaskById(task.id);

  if (latestTask?.status === "finished") {
    await updateModelIterationLatestTask({
      modelIterationId: latestTask.modelIterationId,
      taskId: latestTask.id,
    });
  }

  res.json({
    item: latestTask ? await mapTaskDetail(latestTask, authUser) : null,
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
  await streamTaskFileDownloadResponse(req, res, task, alias, fileInfo);
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
    fileBaseUrl?: string;
  };
  const expiresAt = Date.now() + env.downloadLinkTtlMs;
  const signature = createSignedDownloadSignature(
    [taskId, alias],
    expiresAt,
    env.downloadLinkSecret,
  );
  const url = buildTaskFileDownloadUrl(
    `${DOWNLOAD_LINK_ROUTE}?taskId=${taskId}&fileAlias=${alias}&expiresAt=${expiresAt}&signature=${encodeURIComponent(signature)}`,
    env.fileBaseUrl,
  );

  res.json({
    url,
    expiresAt: new Date(expiresAt).toISOString(),
  });
};

export const downloadCurrentStageDraftHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const taskId = parsePositiveInteger(getSingleRouteParam(req.params.taskId, "taskId"), "taskId");
  const stage = parseTaskStageDraftStage(req.query.stage);
  const task = await findTaskById(taskId);

  if (!task) {
    throw new AppError("任务不存在。", {
      statusCode: 404,
      code: "TASK_NOT_FOUND",
    });
  }

  const draft = assertCanAccessStageDraft(task, authUser, stage);
  await streamStageDraftDownloadResponse(req, res, task, draft);
};

export const createCurrentStageDraftDownloadLinkHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const taskId = parsePositiveInteger(getSingleRouteParam(req.params.taskId, "taskId"), "taskId");
  const stage = parseTaskStageDraftStage(req.query.stage);
  const task = await findTaskById(taskId);

  if (!task) {
    throw new AppError("任务不存在。", {
      statusCode: 404,
      code: "TASK_NOT_FOUND",
    });
  }

  assertCanAccessStageDraft(task, authUser, stage);

  const env = req.app.get("envConfig") as {
    downloadLinkSecret: string;
    downloadLinkTtlMs: number;
    fileBaseUrl?: string;
  };
  const expiresAt = Date.now() + env.downloadLinkTtlMs;
  const signature = createSignedDownloadSignature(
    [taskId, stage],
    expiresAt,
    env.downloadLinkSecret,
  );
  const url = buildTaskFileDownloadUrl(
    `${CURRENT_STAGE_DRAFT_DOWNLOAD_LINK_ROUTE}?taskId=${taskId}&stage=${stage}&expiresAt=${expiresAt}&signature=${encodeURIComponent(signature)}`,
    env.fileBaseUrl,
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
  if (
    !isValidSignedDownloadSignature(
      signature,
      [taskId, fileAlias],
      expiresAt,
      env.downloadLinkSecret,
    )
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
  await streamTaskFileDownloadResponse(req, res, task, fileAlias, {
    storageKey: fileInfo.storageKey,
    originalName: fileInfo.originalName,
  });
};

export const publicDownloadCurrentStageDraftHandler: RequestHandler = async (req, res) => {
  const taskIdRaw = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
  const stageRaw = typeof req.query.stage === "string" ? req.query.stage : undefined;
  const expiresAtRaw = typeof req.query.expiresAt === "string" ? req.query.expiresAt : undefined;
  const signature = typeof req.query.signature === "string" ? req.query.signature : undefined;

  if (!taskIdRaw || !stageRaw || !expiresAtRaw || !signature) {
    throw new AppError("下载链接缺少必要参数。", {
      statusCode: 400,
      code: "INVALID_DOWNLOAD_LINK",
    });
  }

  const taskId = parsePositiveInteger(taskIdRaw, "taskId");
  const stage = parseTaskStageDraftStage(stageRaw);
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

  if (
    !isValidSignedDownloadSignature(
      signature,
      [taskId, stage],
      expiresAt,
      env.downloadLinkSecret,
    )
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

  const draft = getStageDraftSnapshotByStage(task, stage);

  if (!draft) {
    throw new AppError("当前阶段草稿不存在。", {
      statusCode: 404,
      code: "TASK_STAGE_DRAFT_NOT_FOUND",
    });
  }

  await streamStageDraftDownloadResponse(req, res, task, draft);
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

  const previewableFile = await getPreviewableTaskFile(task, authUser, alias);
  const pagination = parsePaginationQuery(req.query, {
    page: 1,
    pageSize: 24,
  });
  const pageSize = Math.min(Math.max(pagination.pageSize, 1), 60);
  const items = previewableFile.mode === "manifest"
    ? previewableFile.previewItems
    : await listZipPreviewItems(previewableFile.absolutePath, FILE_LABELS[alias]);
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

export const listCurrentStageDraftPreviewHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const taskId = parsePositiveInteger(getSingleRouteParam(req.params.taskId, "taskId"), "taskId");
  const stage = parseTaskStageDraftStage(req.query.stage);
  const task = await findTaskById(taskId);

  if (!task) {
    throw new AppError("任务不存在。", {
      statusCode: 404,
      code: "TASK_NOT_FOUND",
    });
  }

  const previewableFile = await getPreviewableStageDraftFile(task, authUser, stage);
  const pagination = parsePaginationQuery(req.query, {
    page: 1,
    pageSize: 24,
  });
  const pageSize = Math.min(Math.max(pagination.pageSize, 1), 60);
  const items = previewableFile.mode === "manifest"
    ? previewableFile.previewItems
    : await listZipPreviewItems(previewableFile.absolutePath, previewableFile.previewLabel);
  const totalPages = items.length === 0 ? 0 : Math.ceil(items.length / pageSize);
  const page = totalPages > 0 ? Math.min(pagination.page, totalPages) : pagination.page;
  const startIndex = (page - 1) * pageSize;
  const pagedItems = items.slice(startIndex, startIndex + pageSize).map((item) => ({
    ...item,
    endpoint: `/api/v1/tasks/${task.id}/stage-draft/preview/${item.id}?stage=${stage}`,
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

  const previewableFile = await getPreviewableTaskFile(task, authUser, alias);

  if (previewableFile.mode === "manifest" && !previewableFile.previewItems.some((item) => item.id === entryId)) {
    throw new AppError("预览图片不存在。", {
      statusCode: 404,
      code: "PREVIEW_ENTRY_NOT_FOUND",
    });
  }

  const previewFile = await openZipPreviewStream(
    previewableFile.mode === "manifest" ? previewableFile.sourceArchiveAbsolutePath : previewableFile.absolutePath,
    entryId,
    previewableFile.mode === "manifest" ? FILE_LABELS.source : FILE_LABELS[alias],
  );

  res.setHeader("Content-Type", previewFile.mimeType);
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(previewFile.fileName)}`,
  );
  res.setHeader("Cache-Control", "private, no-store");

  // 预览图片按条目流式输出，避免一次性把整张图读入内存。
  await pipeline(previewFile.stream, res);
};

export const previewCurrentStageDraftImageHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const taskId = parsePositiveInteger(getSingleRouteParam(req.params.taskId, "taskId"), "taskId");
  const stage = parseTaskStageDraftStage(req.query.stage);
  const entryId = getSingleRouteParam(req.params.entryId, "entryId");
  const task = await findTaskById(taskId);

  if (!task) {
    throw new AppError("任务不存在。", {
      statusCode: 404,
      code: "TASK_NOT_FOUND",
    });
  }

  const previewableFile = await getPreviewableStageDraftFile(task, authUser, stage);

  if (previewableFile.mode === "manifest" && !previewableFile.previewItems.some((item) => item.id === entryId)) {
    throw new AppError("预览图片不存在。", {
      statusCode: 404,
      code: "PREVIEW_ENTRY_NOT_FOUND",
    });
  }

  const previewFile = await openZipPreviewStream(
    previewableFile.mode === "manifest" ? previewableFile.sourceArchiveAbsolutePath : previewableFile.absolutePath,
    entryId,
    previewableFile.previewLabel,
  );

  res.setHeader("Content-Type", previewFile.mimeType);
  res.setHeader(
    "Content-Disposition",
    `inline; filename*=UTF-8''${encodeURIComponent(previewFile.fileName)}`,
  );
  res.setHeader("Cache-Control", "private, no-store");

  await pipeline(previewFile.stream, res);
};
