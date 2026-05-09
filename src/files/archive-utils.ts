import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";

import yauzl, { type Entry, type ZipFile } from "yauzl";

import type { TaskFileAlias } from "../types/domain.js";
import { AppError } from "../utils/app-error.js";

export const ARCHIVE_EXTENSIONS = [".zip", ".rar", ".7z"] as const;
export const ZIP_EXTENSION = ".zip";
export const JSON_EXTENSION = ".json";

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
const ZIP_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE_METHOD = 0;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8LossyDecoder = new TextDecoder("utf-8");
const gbkDecoder = new TextDecoder("gbk");

export type UploadPurpose = "task_source" | "task_cleaned" | "task_annotated" | "task_model";

export type ArchivePreviewItem = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};

export type CleanedManifestSelection = {
  selectedPaths: string[];
  previewItems: ArchivePreviewItem[];
};

type ManifestResolutionFailure = {
  missingNames: string[];
  ambiguousNames: Array<{
    requestedName: string;
    candidatePaths: string[];
  }>;
};

type DecodedArchiveEntryId = {
  index: number;
  name: string;
};

type ZipEntryDownloadRecord = {
  fileName: string;
  crc32: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  lastModTime: number;
  lastModDate: number;
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

function decodeZipEntryFileName(entry: Entry): string {
  const rawFileName = entry.fileName as string | Buffer;

  if (typeof rawFileName === "string") {
    return rawFileName;
  }

  const isUtf8 = (entry.generalPurposeBitFlag & ZIP_UTF8_FLAG) !== 0;

  if (isUtf8) {
    return utf8LossyDecoder.decode(rawFileName);
  }

  try {
    // 有些压缩工具实际写的是 UTF-8，但没有正确打 UTF-8 标志位，这里先尝试严格 UTF-8。
    return utf8Decoder.decode(rawFileName);
  } catch {
    // Windows 中文环境下最常见的是 GBK/CP936；这里回退到 GBK，解决中文图片名匹配失败问题。
    return gbkDecoder.decode(rawFileName);
  }
}

function getNormalizedArchiveEntryName(entry: Entry): string {
  return normalizeArchiveEntryName(decodeZipEntryFileName(entry));
}

function isDirectoryEntry(fileName: string): boolean {
  return /\/$/.test(fileName);
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

function openZipFromFile(filePath: string, autoClose: boolean): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(filePath, { lazyEntries: true, decodeStrings: false, autoClose }, (error, zipFile) => {
      if (error || !zipFile) {
        reject(createArchiveReadError(error));
        return;
      }

      resolve(zipFile);
    });
  });
}

function openZipFromBuffer(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: false }, (error, zipFile) => {
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
      const normalizedName = getNormalizedArchiveEntryName(entry);

      if (isDirectoryEntry(normalizedName) || isIgnoredArchiveEntry(normalizedName)) {
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

function assertZipEntrySizeSupported(entry: Entry, fileName: string): void {
  if (entry.uncompressedSize > 0xffffffff) {
    throw new AppError(`图片 ${fileName} 超过 ZIP64 支持范围，当前暂不支持导出。`, {
      statusCode: 400,
      code: "ZIP64_NOT_SUPPORTED",
    });
  }
}

function toDosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hours = date.getHours();
  const minutes = date.getMinutes();
  const seconds = Math.floor(date.getSeconds() / 2);

  return {
    time: (hours << 11) | (minutes << 5) | seconds,
    date: ((year - 1980) << 9) | (month << 5) | day,
  };
}

function createLocalFileHeader(record: {
  fileNameBuffer: Buffer;
  crc32: number;
  uncompressedSize: number;
  lastModTime: number;
  lastModDate: number;
}): Buffer {
  const header = Buffer.alloc(30);

  header.writeUInt32LE(ZIP_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 6);
  header.writeUInt16LE(ZIP_STORE_METHOD, 8);
  header.writeUInt16LE(record.lastModTime, 10);
  header.writeUInt16LE(record.lastModDate, 12);
  header.writeUInt32LE(record.crc32 >>> 0, 14);
  header.writeUInt32LE(record.uncompressedSize, 18);
  header.writeUInt32LE(record.uncompressedSize, 22);
  header.writeUInt16LE(record.fileNameBuffer.byteLength, 26);
  header.writeUInt16LE(0, 28);

  return header;
}

function createCentralDirectoryHeader(record: ZipEntryDownloadRecord): Buffer {
  const fileNameBuffer = Buffer.from(record.fileName, "utf8");
  const header = Buffer.alloc(46);

  header.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_SIGNATURE, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(ZIP_UTF8_FLAG, 8);
  header.writeUInt16LE(ZIP_STORE_METHOD, 10);
  header.writeUInt16LE(record.lastModTime, 12);
  header.writeUInt16LE(record.lastModDate, 14);
  header.writeUInt32LE(record.crc32 >>> 0, 16);
  header.writeUInt32LE(record.uncompressedSize, 20);
  header.writeUInt32LE(record.uncompressedSize, 24);
  header.writeUInt16LE(fileNameBuffer.byteLength, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(record.localHeaderOffset, 42);

  return Buffer.concat([header, fileNameBuffer]);
}

function createEndOfCentralDirectoryRecord(entryCount: number, centralDirectorySize: number, centralDirectoryOffset: number): Buffer {
  const record = Buffer.alloc(22);

  record.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE, 0);
  record.writeUInt16LE(0, 4);
  record.writeUInt16LE(0, 6);
  record.writeUInt16LE(entryCount, 8);
  record.writeUInt16LE(entryCount, 10);
  record.writeUInt32LE(centralDirectorySize, 12);
  record.writeUInt32LE(centralDirectoryOffset, 16);
  record.writeUInt16LE(0, 20);

  return record;
}

async function writeBuffer(target: NodeJS.WritableStream, buffer: Buffer): Promise<void> {
  if (buffer.byteLength === 0) {
    return;
  }

  const writable = target as NodeJS.WritableStream & {
    writableEnded?: boolean;
    writableDestroyed?: boolean;
  };

  if (writable.writableEnded || writable.writableDestroyed) {
    throw new AppError("下载连接已中断。", {
      statusCode: 499,
      code: "DOWNLOAD_ABORTED",
    });
  }

  if (target.write(buffer)) {
    return;
  }

  await once(target, "drain");
}

async function openZipEntryReadStream(zipFile: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zipFile.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(createArchiveReadError(error));
        return;
      }

      resolve(stream);
    });
  });
}

async function pipeZipEntryToTarget(stream: NodeJS.ReadableStream, target: NodeJS.WritableStream): Promise<number> {
  let totalBytes = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    await writeBuffer(target, buffer);
  }

  return totalBytes;
}

function buildCleanedManifestError(message: string, details?: Record<string, unknown>): AppError {
  return new AppError(message, {
    statusCode: 400,
    code: "INVALID_CLEANED_MANIFEST",
    details,
  });
}

function normalizeManifestSelectedPath(rawValue: string, index: number): string {
  if (rawValue.length === 0 || rawValue.trim().length === 0) {
    throw buildCleanedManifestError(`清洗结果 JSON 第 ${index + 1} 项不能为空字符串。`, {
      index,
    });
  }

  if (rawValue !== rawValue.trim()) {
    throw buildCleanedManifestError(`清洗结果 JSON 第 ${index + 1} 项不能包含首尾空白。`, {
      index,
      value: rawValue,
    });
  }

  const normalizedValue = rawValue.replace(/\\/g, "/");

  if (normalizedValue.startsWith("/")) {
    throw buildCleanedManifestError(`清洗结果 JSON 第 ${index + 1} 项必须是相对路径。`, {
      index,
      value: rawValue,
    });
  }

  const segments = normalizedValue.split("/");

  if (segments.some((segment) => segment.length === 0)) {
    throw buildCleanedManifestError(`清洗结果 JSON 第 ${index + 1} 项路径格式不正确。`, {
      index,
      value: rawValue,
    });
  }

  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw buildCleanedManifestError(`清洗结果 JSON 第 ${index + 1} 项不能包含 . 或 .. 路径段。`, {
      index,
      value: rawValue,
    });
  }

  return normalizedValue;
}

async function readCleanedManifestRawText(source: Buffer | string): Promise<string> {
  if (typeof source === "string") {
    return fs.readFile(source, "utf8");
  }

  return source.toString("utf8");
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

export function isJsonFileName(fileName: string): boolean {
  return getFileExtension(fileName) === JSON_EXTENSION;
}

export function buildCleanedArchiveDownloadFileName(sourceOriginalName: string | null | undefined): string {
  const baseName = sourceOriginalName
    ? path.basename(sourceOriginalName, path.extname(sourceOriginalName))
    : "cleaned-result";

  return `${baseName || "cleaned-result"}-cleaned.zip`;
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

export async function parseCleanedManifest(source: Buffer | string): Promise<string[]> {
  let parsed: unknown;

  try {
    const rawText = (await readCleanedManifestRawText(source)).replace(/^\uFEFF/, "");
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw buildCleanedManifestError("清洗结果 JSON 解析失败，请确认文件内容是有效的 UTF-8 JSON 数组。", {
      message: error instanceof Error ? error.message : undefined,
    });
  }

  if (!Array.isArray(parsed)) {
    throw buildCleanedManifestError("清洗结果 JSON 顶层必须是字符串数组。");
  }

  const normalizedPaths: string[] = [];
  const seenPaths = new Set<string>();

  parsed.forEach((item, index) => {
    if (typeof item !== "string") {
      throw buildCleanedManifestError(`清洗结果 JSON 第 ${index + 1} 项必须是字符串。`, {
        index,
      });
    }

    const normalizedPath = normalizeManifestSelectedPath(item, index);

    if (seenPaths.has(normalizedPath)) {
      throw buildCleanedManifestError(`清洗结果 JSON 中存在重复路径：${normalizedPath}。`, {
        index,
        value: normalizedPath,
      });
    }

    seenPaths.add(normalizedPath);
    normalizedPaths.push(normalizedPath);
  });

  return normalizedPaths;
}

export async function validateUploadContent(
  source: Buffer | string,
  originalName: string,
  purpose: UploadPurpose | undefined,
): Promise<void> {
  if (!purpose || purpose === "task_model") {
    return;
  }

  const fileLabel = getUploadPurposeLabel(purpose);

  if (purpose === "task_cleaned") {
    if (!isJsonFileName(originalName)) {
      throw new AppError(`${fileLabel}仅允许上传 JSON 文件。`, {
        statusCode: 400,
        code: "INVALID_UPLOAD_FILE_TYPE",
      });
    }

    await parseCleanedManifest(source);
    return;
  }

  if (!isArchiveFileName(originalName)) {
    throw new AppError(`${fileLabel}仅允许上传 zip、rar、7z 压缩包。`, {
      statusCode: 400,
      code: "INVALID_UPLOAD_FILE_TYPE",
    });
  }

  // 只有 zip 能在当前后端内稳定做目录级深度校验；rar/7z 本次仍保留后缀上传能力。
  if ((purpose === "task_source" || purpose === "task_annotated") && getFileExtension(originalName) === ZIP_EXTENSION) {
    const zipFile = typeof source === "string" ? await openZipFromFile(source, false) : await openZipFromBuffer(source);
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
      const normalizedName = getNormalizedArchiveEntryName(entry);
      items.push({
        id: buildArchiveEntryId(index, normalizedName),
        name: normalizedName,
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

export async function resolveCleanedManifestSelection(input: {
  manifestSource: Buffer | string;
  sourceArchivePath: string;
  manifestLabel: string;
  sourceArchiveLabel: string;
}): Promise<CleanedManifestSelection> {
  const requestedNames = await parseCleanedManifest(input.manifestSource);
  const sourceItems = await listZipPreviewItems(input.sourceArchivePath, input.sourceArchiveLabel);
  const sourceItemMap = new Map(sourceItems.map((item) => [item.name, item]));
  const sourceItemBaseNameMap = new Map<string, ArchivePreviewItem[]>();

  for (const sourceItem of sourceItems) {
    const baseName = path.posix.basename(sourceItem.name);
    const matches = sourceItemBaseNameMap.get(baseName);

    if (matches) {
      matches.push(sourceItem);
    } else {
      sourceItemBaseNameMap.set(baseName, [sourceItem]);
    }
  }

  const missingNames: string[] = [];
  const ambiguousNames: ManifestResolutionFailure["ambiguousNames"] = [];
  const resolvedPaths: string[] = [];
  const resolvedPathSet = new Set<string>();

  for (const requestedName of requestedNames) {
    const exactMatch = sourceItemMap.get(requestedName);

    if (exactMatch) {
      if (!resolvedPathSet.has(exactMatch.name)) {
        resolvedPaths.push(exactMatch.name);
        resolvedPathSet.add(exactMatch.name);
      }
      continue;
    }

    const baseName = path.posix.basename(requestedName);
    const baseNameMatches = sourceItemBaseNameMap.get(baseName) ?? [];

    if (baseNameMatches.length === 1) {
      const resolvedItem = baseNameMatches[0];

      if (!resolvedPathSet.has(resolvedItem.name)) {
        resolvedPaths.push(resolvedItem.name);
        resolvedPathSet.add(resolvedItem.name);
      }
      continue;
    }

    if (baseNameMatches.length > 1) {
      ambiguousNames.push({
        requestedName,
        candidatePaths: baseNameMatches.map((item) => item.name),
      });
      continue;
    }

    missingNames.push(requestedName);
  }

  if (missingNames.length > 0 || ambiguousNames.length > 0) {
    const messageParts: string[] = [];

    if (missingNames.length > 0) {
      const previewNames = missingNames.slice(0, 5).join("、");
      const suffix = missingNames.length > 5 ? " 等" : "";
      messageParts.push(`初始压缩包内不存在这些路径或文件名：${previewNames}${suffix}`);
    }

    if (ambiguousNames.length > 0) {
      const previewNames = ambiguousNames
        .slice(0, 3)
        .map((item) => item.requestedName)
        .join("、");
      const suffix = ambiguousNames.length > 3 ? " 等" : "";
      messageParts.push(`这些文件名在初始压缩包内不唯一，请改用完整相对路径：${previewNames}${suffix}`);
    }

    throw buildCleanedManifestError(`${input.manifestLabel} 中存在无效条目：${messageParts.join("；")}。`, {
      missingPaths: missingNames,
      ambiguousPaths: ambiguousNames,
    });
  }

  const selectedSet = new Set(resolvedPaths);

  return {
    selectedPaths: resolvedPaths,
    // 预览和导出都按初始压缩包内原始顺序返回，避免不同端对 JSON 顺序有额外依赖。
    previewItems: sourceItems.filter((item) => selectedSet.has(item.name)),
  };
}

export async function streamSelectedEntriesAsZip(input: {
  sourceArchivePath: string;
  selectedPaths: string[];
  sourceArchiveLabel: string;
  target: NodeJS.WritableStream;
}): Promise<void> {
  const selectedSet = new Set(input.selectedPaths);
  const centralDirectoryRecords: ZipEntryDownloadRecord[] = [];
  const zipFile = await openZipFromFile(input.sourceArchivePath, false);
  let bytesWritten = 0;

  try {
    await inspectZipEntries(zipFile, {
      onImageEntry: async ({ entry }) => {
        const normalizedName = getNormalizedArchiveEntryName(entry);

        if (!selectedSet.has(normalizedName)) {
          return;
        }

        assertZipEntrySizeSupported(entry, normalizedName);
        const fileNameBuffer = Buffer.from(normalizedName, "utf8");
        const lastModifiedAt = entry.getLastModDate();
        const { time: lastModTime, date: lastModDate } = toDosDateTime(lastModifiedAt);
        const localHeaderOffset = bytesWritten;
        const headerBuffer = createLocalFileHeader({
          fileNameBuffer,
          crc32: entry.crc32,
          uncompressedSize: entry.uncompressedSize,
          lastModTime,
          lastModDate,
        });

        await writeBuffer(input.target, headerBuffer);
        bytesWritten += headerBuffer.byteLength;
        await writeBuffer(input.target, fileNameBuffer);
        bytesWritten += fileNameBuffer.byteLength;

        const entryStream = await openZipEntryReadStream(zipFile, entry);
        const entryByteLength = await pipeZipEntryToTarget(entryStream, input.target);

        if (entryByteLength !== entry.uncompressedSize) {
          throw new AppError(`图片 ${normalizedName} 解压后的大小与元数据不一致，无法导出。`, {
            statusCode: 400,
            code: "INVALID_ARCHIVE_ENTRY_SIZE",
          });
        }

        bytesWritten += entryByteLength;
        centralDirectoryRecords.push({
          fileName: normalizedName,
          crc32: entry.crc32,
          uncompressedSize: entry.uncompressedSize,
          localHeaderOffset,
          lastModTime,
          lastModDate,
        });
      },
    }, input.sourceArchiveLabel);

    const centralDirectoryOffset = bytesWritten;

    for (const record of centralDirectoryRecords) {
      const centralDirectoryHeader = createCentralDirectoryHeader(record);
      await writeBuffer(input.target, centralDirectoryHeader);
      bytesWritten += centralDirectoryHeader.byteLength;
    }

    const centralDirectorySize = bytesWritten - centralDirectoryOffset;
    const endOfCentralDirectoryRecord = createEndOfCentralDirectoryRecord(
      centralDirectoryRecords.length,
      centralDirectorySize,
      centralDirectoryOffset,
    );

    await writeBuffer(input.target, endOfCentralDirectoryRecord);
  } finally {
    zipFile.close();
  }
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
      const normalizedName = getNormalizedArchiveEntryName(entry);

      if (isDirectoryEntry(normalizedName) || isIgnoredArchiveEntry(normalizedName)) {
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
