import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { AppEnv } from "../config/env.js";
import type { TaskFileAlias, UploadedFileRef } from "../types/domain.js";
import { AppError } from "../utils/app-error.js";

const TMP_DIR_NAME = "tmp";
const TASKS_DIR_NAME = "tasks";

let storageRoot = "";

function ensureStorageRoot(): string {
  if (!storageRoot) {
    throw new AppError("文件存储目录尚未初始化。", {
      statusCode: 500,
      code: "FILE_STORAGE_NOT_INITIALIZED",
      expose: false,
    });
  }

  return storageRoot;
}

function normalizeStorageKey(storageKey: string): string {
  return storageKey.replace(/\\/g, "/");
}

function resolveStoragePath(storageKey: string): string {
  const root = ensureStorageRoot();
  const resolvedPath = path.resolve(root, storageKey);
  const relativePath = path.relative(root, resolvedPath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new AppError("非法文件路径。", {
      statusCode: 400,
      code: "INVALID_FILE_PATH",
    });
  }

  return resolvedPath;
}

function sanitizeFileName(fileName: string): string {
  const baseName = path.basename(fileName.trim());
  return baseName.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
}

function getTaskFileName(alias: TaskFileAlias, originalName: string): string {
  const extension = path.extname(originalName);
  const randomSuffix = crypto.randomBytes(4).toString("hex");
  return `${alias}-${Date.now()}-${randomSuffix}${extension}`;
}

export async function initializeFileStorage(env: AppEnv): Promise<void> {
  storageRoot = env.fileStorageDir;
  await fs.mkdir(path.join(storageRoot, TMP_DIR_NAME), { recursive: true });
  await fs.mkdir(path.join(storageRoot, TASKS_DIR_NAME), { recursive: true });
}

export async function saveTempUpload(buffer: Buffer, originalName: string, mimeType: string): Promise<UploadedFileRef> {
  const safeOriginalName = sanitizeFileName(originalName);

  if (!safeOriginalName) {
    throw new AppError("文件名不能为空。", {
      statusCode: 400,
      code: "INVALID_FILE_NAME",
    });
  }

  const extension = path.extname(safeOriginalName);
  const tempFileName = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}${extension}`;
  const storageKey = normalizeStorageKey(path.posix.join(TMP_DIR_NAME, tempFileName));
  const absolutePath = resolveStoragePath(storageKey);

  await fs.writeFile(absolutePath, buffer);

  return {
    storageKey,
    originalName: safeOriginalName,
    mimeType,
    size: buffer.byteLength,
  };
}

export async function moveTempUploadToTask(
  upload: UploadedFileRef,
  taskId: number,
  alias: TaskFileAlias,
): Promise<UploadedFileRef> {
  if (!upload.storageKey.startsWith(`${TMP_DIR_NAME}/`)) {
    throw new AppError("当前文件不是可提交的临时上传文件。", {
      statusCode: 400,
      code: "INVALID_UPLOAD_REFERENCE",
    });
  }

  const sourcePath = resolveStoragePath(upload.storageKey);
  const taskDir = path.join(ensureStorageRoot(), TASKS_DIR_NAME, `task-${taskId}`);
  const targetFileName = getTaskFileName(alias, upload.originalName);
  const targetStorageKey = normalizeStorageKey(path.posix.join(TASKS_DIR_NAME, `task-${taskId}`, targetFileName));
  const targetPath = resolveStoragePath(targetStorageKey);

  await fs.mkdir(taskDir, { recursive: true });

  try {
    await fs.access(sourcePath);
  } catch {
    throw new AppError("上传文件不存在或已失效，请重新上传。", {
      statusCode: 400,
      code: "UPLOAD_NOT_FOUND",
    });
  }

  await fs.rename(sourcePath, targetPath);

  return {
    ...upload,
    storageKey: targetStorageKey,
  };
}

export async function ensureStoredFileExists(storageKey: string): Promise<string> {
  const absolutePath = resolveStoragePath(storageKey);

  try {
    await fs.access(absolutePath);
  } catch {
    throw new AppError("文件不存在。", {
      statusCode: 404,
      code: "FILE_NOT_FOUND",
    });
  }

  return absolutePath;
}
