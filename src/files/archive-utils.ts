import path from "node:path";

import yauzl, { type Entry, type ZipFile } from "yauzl";

import type { TaskFileAlias } from "../types/domain.js";
import { AppError } from "../utils/app-error.js";

export const ARCHIVE_EXTENSIONS = [".zip", ".rar", ".7z"] as const;
export const ZIP_EXTENSION = ".zip";

const PREVIEWABLE_TASK_FILE_ALIASES = ["source", "cleaned"] as const satisfies readonly TaskFileAlias[];
const IMAGE_MIME_TYPE_MAP: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};
const IGNORED_ARCHIVE_FILE_NAMES = new Set([".ds_store", "thumbs.db"]);

export type UploadPurpose = "task_source" | "task_cleaned" | "task_annotated" | "task_model";

export type ArchivePreviewItem = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};

type DecodedArchiveEntryId = {
  index: number;
  name: string;
};

function getUploadPurposeLabel(purpose: UploadPurpose): string {
  switch (purpose) {
    case "task_source":
      return "初始文件";
    case "task_cleaned":
      return "清洗结果文件";
    case "task_annotated":
      return "标注结果文件";
    case "task_model":
      return "模型结果文件";
  }
}

function normalizeArchiveEntryName(fileName: string): string {
  return fileName.replace(/\\/g, "/");
}

function isDirectoryEntry(entry: Entry): boolean {
  return /\/$/.test(entry.fileName);
}

function isIgnoredArchiveEntry(fileName: string): boolean {
  const normalizedName = normalizeArchiveEntryName(fileName);
  const baseName = path.posix.basename(normalizedName).toLowerCase();

  if (normalizedName.startsWith("__MACOSX/")) {
    return true;
  }

  return IGNORED_ARCHIVE_FILE_NAMES.has(baseName);
}

function getImageMimeType(fileName: string): string | null {
  const extension = getFileExtension(fileName);
  return IMAGE_MIME_TYPE_MAP[extension] ?? null;
}

function createInvalidArchiveContentError(fileLabel: string, entryName: string): AppError {
  return new AppError(
    `${fileLabel}压缩包中包含非图片文件：${entryName}。当前仅允许上传图片文件。`,
    {
      statusCode: 400,
      code: "INVALID_ARCHIVE_CONTENT",
    },
  );
}

function createArchiveReadError(error: unknown): AppError {
  return new AppError("压缩包读取失败，请确认文件未损坏且格式正确。", {
    statusCode: 400,
    code: "INVALID_ARCHIVE_FILE",
    details: error instanceof Error ? { message: error.message } : undefined,
  });
}

function openZipFromBuffer(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(createArchiveReadError(error));
        return;
      }

      resolve(zipFile);
    });
  });
}

function openZipFromFile(filePath: string, autoClose: boolean): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, decodeStrings: true, autoClose }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(createArchiveReadError(error));
        return;
      }

      resolve(zipFile);
    });
  });
}

function buildArchiveEntryId(index: number, name: string): string {
  return Buffer.from(JSON.stringify({ index, name }), "utf8").toString("base64url");
}

function decodeArchiveEntryId(entryId: string): DecodedArchiveEntryId {
  try {
    const parsed = JSON.parse(Buffer.from(entryId, "base64url").toString("utf8")) as Partial<DecodedArchiveEntryId>;
    const rawIndex = parsed.index;

    if (typeof rawIndex !== "number" || !Number.isInteger(rawIndex) || rawIndex < 0 || typeof parsed.name !== "string" || !parsed.name) {
      throw new Error("Invalid archive entry id.");
    }

    return {
      index: rawIndex,
      name: parsed.name,
    };
  } catch {
    throw new AppError("无效的预览图片标识。", {
      statusCode: 400,
      code: "INVALID_PREVIEW_ENTRY_ID",
    });
  }
}

async function inspectZipEntries(
  zipFile: ZipFile,
  handlers: {
    onImageEntry?: (payload: { entry: Entry; index: number; mimeType: string }) => void | Promise<void>;
  },
  fileLabel: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let imageIndex = 0;

    const finishWithError = (error: unknown) => {
      zipFile.close();
      reject(error);
    };

    zipFile.on("error", (error) => {
      finishWithError(createArchiveReadError(error));
    });

    zipFile.on("entry", (entry) => {
      const normalizedName = normalizeArchiveEntryName(entry.fileName);

      if (isDirectoryEntry(entry) || isIgnoredArchiveEntry(normalizedName)) {
        zipFile.readEntry();
        return;
      }

      const mimeType = getImageMimeType(normalizedName);

      if (!mimeType) {
        finishWithError(createInvalidArchiveContentError(fileLabel, normalizedName));
        return;
      }

      Promise.resolve(handlers.onImageEntry?.({ entry, index: imageIndex, mimeType }))
        .then(() => {
          imageIndex += 1;
          zipFile.readEntry();
        })
        .catch((error) => {
          finishWithError(error);
        });
    });

    zipFile.on("end", () => {
      resolve();
    });

    zipFile.readEntry();
  });
}

export function getFileExtension(fileName: string): string {
  const lastDotIndex = fileName.lastIndexOf(".");

  if (lastDotIndex < 0) {
    return "";
  }

  return fileName.slice(lastDotIndex).toLowerCase();
}

export function isArchiveFileName(fileName: string): boolean {
  return ARCHIVE_EXTENSIONS.includes(getFileExtension(fileName) as (typeof ARCHIVE_EXTENSIONS)[number]);
}

export function parseUploadPurpose(value: string | string[] | undefined): UploadPurpose | undefined {
  const normalizedValue = typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;

  if (!normalizedValue) {
    return undefined;
  }

  if (
    normalizedValue === "task_source" ||
    normalizedValue === "task_cleaned" ||
    normalizedValue === "task_annotated" ||
    normalizedValue === "task_model"
  ) {
    return normalizedValue;
  }

  throw new AppError("不支持的上传用途。", {
    statusCode: 400,
    code: "INVALID_UPLOAD_PURPOSE",
  });
}

export async function validateUploadContent(
  buffer: Buffer,
  originalName: string,
  purpose: UploadPurpose | undefined,
): Promise<void> {
  if (!purpose || purpose === "task_model") {
    return;
  }

  const fileLabel = getUploadPurposeLabel(purpose);

  if (!isArchiveFileName(originalName)) {
    throw new AppError(`${fileLabel}仅允许上传 zip、rar、7z 压缩包。`, {
      statusCode: 400,
      code: "INVALID_UPLOAD_FILE_TYPE",
    });
  }

  // 只有 zip 能在当前后端内稳定做目录级深度校验；rar/7z 本次仍保留后缀上传能力。
  if ((purpose === "task_source" || purpose === "task_cleaned") && getFileExtension(originalName) === ZIP_EXTENSION) {
    const zipFile = await openZipFromBuffer(buffer);
    let imageCount = 0;

    try {
      await inspectZipEntries(zipFile, {
        onImageEntry: () => {
          imageCount += 1;
        },
      }, fileLabel);
    } finally {
      zipFile.close();
    }

    if (imageCount === 0) {
      throw new AppError(`${fileLabel}压缩包中未找到可用图片文件。`, {
        statusCode: 400,
        code: "EMPTY_ARCHIVE_IMAGES",
      });
    }
  }
}

export function canPreviewTaskArchive(alias: TaskFileAlias, originalName: string): boolean {
  return PREVIEWABLE_TASK_FILE_ALIASES.includes(alias as (typeof PREVIEWABLE_TASK_FILE_ALIASES)[number])
    && getFileExtension(originalName) === ZIP_EXTENSION;
}

export async function listZipPreviewItems(filePath: string, fileLabel: string): Promise<ArchivePreviewItem[]> {
  const zipFile = await openZipFromFile(filePath, true);
  const items: ArchivePreviewItem[] = [];

  await inspectZipEntries(zipFile, {
    onImageEntry: ({ entry, index, mimeType }) => {
      items.push({
        id: buildArchiveEntryId(index, normalizeArchiveEntryName(entry.fileName)),
        name: normalizeArchiveEntryName(entry.fileName),
        mimeType,
        size: entry.uncompressedSize,
      });
    },
  }, fileLabel);

  if (items.length === 0) {
    throw new AppError(`${fileLabel}压缩包中未找到可预览的图片文件。`, {
      statusCode: 400,
      code: "EMPTY_ARCHIVE_IMAGES",
    });
  }

  return items;
}

export async function openZipPreviewStream(
  filePath: string,
  entryId: string,
  fileLabel: string,
): Promise<{
  fileName: string;
  mimeType: string;
  stream: NodeJS.ReadableStream;
}> {
  const expectedEntry = decodeArchiveEntryId(entryId);
  const zipFile = await openZipFromFile(filePath, false);

  return new Promise((resolve, reject) => {
    let imageIndex = 0;
    let settled = false;

    const rejectAndClose = (error: unknown) => {
      if (!settled) {
        settled = true;
        zipFile.close();
        reject(error);
      }
    };

    zipFile.on("error", (error) => {
      rejectAndClose(createArchiveReadError(error));
    });

    zipFile.on("entry", (entry) => {
      const normalizedName = normalizeArchiveEntryName(entry.fileName);

      if (isDirectoryEntry(entry) || isIgnoredArchiveEntry(normalizedName)) {
        zipFile.readEntry();
        return;
      }

      const mimeType = getImageMimeType(normalizedName);

      if (!mimeType) {
        rejectAndClose(createInvalidArchiveContentError(fileLabel, normalizedName));
        return;
      }

      const currentIndex = imageIndex;
      imageIndex += 1;

      if (currentIndex !== expectedEntry.index || normalizedName !== expectedEntry.name) {
        zipFile.readEntry();
        return;
      }

      zipFile.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          rejectAndClose(createArchiveReadError(error));
          return;
        }

        settled = true;
        stream.on("end", () => {
          zipFile.close();
        });
        stream.on("error", () => {
          zipFile.close();
        });

        resolve({
          fileName: path.posix.basename(normalizedName),
          mimeType,
          stream,
        });
      });
    });

    zipFile.on("end", () => {
      if (!settled) {
        rejectAndClose(
          new AppError("预览图片不存在。", {
            statusCode: 404,
            code: "PREVIEW_ENTRY_NOT_FOUND",
          }),
        );
      }
    });

    zipFile.readEntry();
  });
}
