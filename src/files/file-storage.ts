import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { AppEnv } from "../config/env.js";
import type { UploadPurpose } from "./archive-utils.js";
import type { TaskFileAlias, UploadedFileRef } from "../types/domain.js";
import { AppError } from "../utils/app-error.js";

const TMP_DIR_NAME = "tmp";
const TASKS_DIR_NAME = "tasks";
const UPLOADS_DIR_NAME = path.posix.join(TMP_DIR_NAME, "uploads");
const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type UploadSessionStatus = "created" | "uploading" | "uploaded" | "finalized";

export type UploadSessionRecord = {
  id: string;
  storageKey: string;
  metadataStorageKey: string;
  originalName: string;
  mimeType: string;
  size: number;
  offset: number;
  purpose?: UploadPurpose;
  createdBy: number;
  createdAt: string;
  expiresAt: string;
  status: UploadSessionStatus;
  finalizedFile?: UploadedFileRef;
};

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

function getUploadSessionPaths(uploadId: string) {
  const baseStorageKey = normalizeStorageKey(path.posix.join(UPLOADS_DIR_NAME, uploadId));

  return {
    directoryStorageKey: baseStorageKey,
    dataStorageKey: normalizeStorageKey(path.posix.join(baseStorageKey, "blob.part")),
    metadataStorageKey: normalizeStorageKey(path.posix.join(baseStorageKey, "meta.json")),
  };
}

async function persistUploadSession(record: UploadSessionRecord): Promise<void> {
  const metadataPath = resolveStoragePath(record.metadataStorageKey);
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, JSON.stringify(record, null, 2), "utf8");
}

function assertUploadSessionOwner(record: UploadSessionRecord, userId: number): void {
  if (record.createdBy === userId) {
    return;
  }

  throw new AppError("当前上传会话无权访问。", {
    statusCode: 403,
    code: "FORBIDDEN_UPLOAD_SESSION",
  });
}

function assertUploadSessionNotExpired(record: UploadSessionRecord): void {
  if (Date.now() <= Date.parse(record.expiresAt)) {
    return;
  }

  throw new AppError("上传会话已过期，请重新上传。", {
    statusCode: 410,
    code: "UPLOAD_SESSION_EXPIRED",
  });
}

function assertUploadSessionState(
  record: UploadSessionRecord,
  expectedStates: UploadSessionStatus[],
): void {
  if (expectedStates.includes(record.status)) {
    return;
  }

  throw new AppError("上传会话状态不允许执行当前操作。", {
    statusCode: 409,
    code: "INVALID_UPLOAD_SESSION_STATE",
    details: {
      currentStatus: record.status,
      expectedStates,
    },
  });
}

async function removeExpiredUploadSessions(): Promise<void> {
  const uploadsDirectoryPath = resolveStoragePath(UPLOADS_DIR_NAME);

  try {
    const entries = await fs.readdir(uploadsDirectoryPath, { withFileTypes: true });

    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const { metadataStorageKey } = getUploadSessionPaths(entry.name);
          const metadataPath = resolveStoragePath(metadataStorageKey);

          try {
            const rawMetadata = await fs.readFile(metadataPath, "utf8");
            const record = JSON.parse(rawMetadata) as UploadSessionRecord;

            if (Date.now() <= Date.parse(record.expiresAt)) {
              return;
            }

            await fs.rm(resolveStoragePath(getUploadSessionPaths(entry.name).directoryStorageKey), {
              recursive: true,
              force: true,
            });
          } catch {
            // 清理是兜底逻辑，遇到损坏的元数据时不阻塞服务启动。
          }
        }),
    );
  } catch {
    // 目录首次初始化时可能还不存在，这里忽略即可。
  }
}

export async function initializeFileStorage(env: AppEnv): Promise<void> {
  storageRoot = env.fileStorageDir;
  await fs.mkdir(path.join(storageRoot, TMP_DIR_NAME), { recursive: true });
  await fs.mkdir(path.join(storageRoot, TASKS_DIR_NAME), { recursive: true });
  await fs.mkdir(resolveStoragePath(UPLOADS_DIR_NAME), { recursive: true });
  await removeExpiredUploadSessions();
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

export async function saveTempUploadFromPath(
  sourcePath: string,
  originalName: string,
  mimeType: string,
  size: number,
): Promise<UploadedFileRef> {
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

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.rename(sourcePath, absolutePath);

  return {
    storageKey,
    originalName: safeOriginalName,
    mimeType,
    size,
  };
}

export async function createUploadSession(input: {
  originalName: string;
  mimeType: string;
  size: number;
  purpose?: UploadPurpose;
  createdBy: number;
}): Promise<UploadSessionRecord> {
  const safeOriginalName = sanitizeFileName(input.originalName);

  if (!safeOriginalName) {
    throw new AppError("文件名不能为空。", {
      statusCode: 400,
      code: "INVALID_FILE_NAME",
    });
  }

  const uploadId = crypto.randomBytes(12).toString("hex");
  const paths = getUploadSessionPaths(uploadId);
  const filePath = resolveStoragePath(paths.dataStorageKey);
  const sessionDirectoryPath = path.dirname(filePath);
  const now = new Date();
  const record: UploadSessionRecord = {
    id: uploadId,
    storageKey: paths.dataStorageKey,
    metadataStorageKey: paths.metadataStorageKey,
    originalName: safeOriginalName,
    mimeType: input.mimeType || "application/octet-stream",
    size: input.size,
    offset: 0,
    purpose: input.purpose,
    createdBy: input.createdBy,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + UPLOAD_SESSION_TTL_MS).toISOString(),
    status: "created",
  };

  await fs.mkdir(sessionDirectoryPath, { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(0));
  await persistUploadSession(record);

  return record;
}

export async function getUploadSession(uploadId: string, userId: number): Promise<UploadSessionRecord> {
  const { metadataStorageKey } = getUploadSessionPaths(uploadId);
  const metadataPath = resolveStoragePath(metadataStorageKey);

  let rawMetadata = "";

  try {
    rawMetadata = await fs.readFile(metadataPath, "utf8");
  } catch {
    throw new AppError("上传会话不存在。", {
      statusCode: 404,
      code: "UPLOAD_SESSION_NOT_FOUND",
    });
  }

  const record = JSON.parse(rawMetadata) as UploadSessionRecord;
  assertUploadSessionOwner(record, userId);
  assertUploadSessionNotExpired(record);

  return record;
}

export async function appendUploadChunk(
  uploadId: string,
  userId: number,
  expectedOffset: number,
  chunk: Buffer,
): Promise<UploadSessionRecord> {
  const record = await getUploadSession(uploadId, userId);
  assertUploadSessionState(record, ["created", "uploading", "uploaded"]);

  if (record.status === "uploaded" && chunk.byteLength === 0 && expectedOffset === record.offset) {
    return record;
  }

  if (expectedOffset !== record.offset) {
    throw new AppError("上传偏移量不匹配。", {
      statusCode: 409,
      code: "UPLOAD_OFFSET_MISMATCH",
      details: {
        currentOffset: record.offset,
      },
    });
  }

  const nextOffset = expectedOffset + chunk.byteLength;

  if (nextOffset > record.size) {
    throw new AppError("上传分片超出声明的文件大小。", {
      statusCode: 400,
      code: "UPLOAD_CHUNK_TOO_LARGE",
    });
  }

  if (chunk.byteLength > 0) {
    const fileHandle = await fs.open(resolveStoragePath(record.storageKey), "r+");

    try {
      await fileHandle.write(chunk, 0, chunk.byteLength, expectedOffset);
    } finally {
      await fileHandle.close();
    }
  }

  record.offset = nextOffset;
  record.status = nextOffset === record.size ? "uploaded" : "uploading";
  await persistUploadSession(record);

  return record;
}

export async function finalizeUploadSession(
  uploadId: string,
  userId: number,
  validateUploadContent: (sourcePath: string, originalName: string, purpose: UploadPurpose | undefined) => Promise<void>,
): Promise<UploadedFileRef> {
  const record = await getUploadSession(uploadId, userId);

  if (record.status === "finalized" && record.finalizedFile) {
    return record.finalizedFile;
  }

  assertUploadSessionState(record, ["uploaded"]);

  if (record.offset !== record.size) {
    throw new AppError("文件尚未上传完成，不能提交。", {
      statusCode: 409,
      code: "UPLOAD_NOT_FINISHED",
    });
  }

  const sourcePath = resolveStoragePath(record.storageKey);
  await validateUploadContent(sourcePath, record.originalName, record.purpose);

  const uploadedFile = await saveTempUploadFromPath(
    sourcePath,
    record.originalName,
    record.mimeType,
    record.size,
  );

  record.status = "finalized";
  record.finalizedFile = uploadedFile;
  await persistUploadSession(record);

  return uploadedFile;
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
