import type { RequestHandler } from "express";
import formidable, { type Fields, type Files, type File } from "formidable";

import { getAuthUser } from "../auth/auth.middleware.js";
import { parseUploadPurpose, validateUploadContent } from "./archive-utils.js";
import {
  appendUploadChunk,
  createUploadSession,
  finalizeUploadSession,
  getUploadSession,
  saveTempUploadFromPath,
} from "./file-storage.js";
import { AppError } from "../utils/app-error.js";

const TUS_VERSION = "1.0.0";
const TUS_EXTENSION = "creation,creation-with-upload";

function getFormidableValue(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0] ?? "";
  }

  return "";
}

function getUploadedFormFile(files: Files): File | null {
  const file = files.file;

  if (Array.isArray(file)) {
    return file[0] ?? null;
  }

  return file ?? null;
}

function getTusEnv(req: Parameters<RequestHandler>[0]) {
  return req.app.get("envConfig") as {
    fileStorageDir: string;
    maxUploadSizeBytes: number;
  };
}

function setTusCommonHeaders(res: Parameters<RequestHandler>[1]): void {
  res.setHeader("Tus-Resumable", TUS_VERSION);
  res.setHeader("Tus-Version", TUS_VERSION);
  res.setHeader("Tus-Extension", TUS_EXTENSION);
  res.setHeader("Cache-Control", "no-store");
}

function parseTusMetadata(headerValue: string | undefined): Record<string, string> {
  if (!headerValue) {
    return {};
  }

  return headerValue
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((result, segment) => {
      const [rawKey, rawValue = ""] = segment.split(" ");
      const key = rawKey?.trim();

      if (!key) {
        return result;
      }

      try {
        result[key] = Buffer.from(rawValue, "base64").toString("utf8");
      } catch {
        result[key] = "";
      }

      return result;
    }, {});
}

function parseUploadLength(rawValue: string | undefined, maxUploadSizeBytes: number): number {
  if (!rawValue) {
    throw new AppError("缺少 Tus 上传长度。", {
      statusCode: 400,
      code: "MISSING_UPLOAD_LENGTH",
    });
  }

  const size = Number(rawValue);

  if (!Number.isInteger(size) || size <= 0) {
    throw new AppError("Tus 上传长度不合法。", {
      statusCode: 400,
      code: "INVALID_UPLOAD_LENGTH",
    });
  }

  if (size > maxUploadSizeBytes) {
    throw new AppError("上传文件超过服务端限制。", {
      statusCode: 413,
      code: "UPLOAD_FILE_TOO_LARGE",
    });
  }

  return size;
}

function getUploadIdParam(req: Parameters<RequestHandler>[0]): string {
  const uploadId = typeof req.params.uploadId === "string" ? req.params.uploadId.trim() : "";

  if (!uploadId) {
    throw new AppError("缺少上传会话标识。", {
      statusCode: 400,
      code: "MISSING_UPLOAD_ID",
    });
  }

  return uploadId;
}

function getTusUploadLocation(req: Parameters<RequestHandler>[0], uploadId: string): string {
  const basePath = `${req.baseUrl}${req.path}`.replace(/\/+$/, "");
  return `${basePath}/${uploadId}`;
}

export const uploadFileHandler: RequestHandler = async (req, res) => {
  const env = getTusEnv(req);

  const form = formidable({
    uploadDir: env.fileStorageDir,
    maxFileSize: env.maxUploadSizeBytes,
    maxTotalFileSize: env.maxUploadSizeBytes,
    allowEmptyFiles: false,
    multiples: false,
    // 保留旧接口兼容，避免已有脚本或测试在分片切换时全部失效。
    filter: ({ name, originalFilename }) => {
      return name === "file" && Boolean(originalFilename);
    },
  });

  const [fields, files] = await new Promise<[Fields, Files]>((resolve, reject) => {
    form.parse(req, (error, parsedFields, parsedFiles) => {
      if (error) {
        reject(error);
        return;
      }

      resolve([parsedFields, parsedFiles]);
    });
  });

  const uploadedFile = getUploadedFormFile(files);

  if (!uploadedFile) {
    throw new AppError("上传文件内容不能为空。", {
      statusCode: 400,
      code: "EMPTY_FILE_BODY",
    });
  }

  const originalName = getFormidableValue(fields.originalName) || uploadedFile.originalFilename || "";

  if (!originalName) {
    throw new AppError("缺少文件名字段 originalName。", {
      statusCode: 400,
      code: "MISSING_FILE_NAME",
    });
  }

  const uploadPurpose = parseUploadPurpose(fields.purpose);

  await validateUploadContent(uploadedFile.filepath, originalName, uploadPurpose);

  const file = await saveTempUploadFromPath(
    uploadedFile.filepath,
    originalName,
    uploadedFile.mimetype || "application/octet-stream",
    uploadedFile.size,
  );

  res.status(201).json({
    item: file,
  });
};

export const createUploadSessionHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const env = getTusEnv(req);
  const { originalName, mimeType, size, purpose } = req.body as {
    originalName?: unknown;
    mimeType?: unknown;
    size?: unknown;
    purpose?: unknown;
  };

  if (typeof originalName !== "string" || !originalName.trim()) {
    throw new AppError("缺少文件名。", {
      statusCode: 400,
      code: "MISSING_FILE_NAME",
    });
  }

  if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
    throw new AppError("文件大小不合法。", {
      statusCode: 400,
      code: "INVALID_FILE_SIZE",
    });
  }

  if (size > env.maxUploadSizeBytes) {
    throw new AppError("上传文件超过服务端限制。", {
      statusCode: 413,
      code: "UPLOAD_FILE_TOO_LARGE",
    });
  }

  const uploadPurpose =
    typeof purpose === "string" ? parseUploadPurpose(purpose) : undefined;

  const session = await createUploadSession({
    originalName,
    mimeType: typeof mimeType === "string" && mimeType.trim() ? mimeType : "application/octet-stream",
    size,
    purpose: uploadPurpose,
    createdBy: authUser.id,
  });

  res.status(201).json({
    item: {
      uploadId: session.id,
      tusEndpoint: `/api/v1/files/tus`,
      uploadUrl: `/api/v1/files/tus/${session.id}`,
      createUrl: `/api/v1/files/tus/${session.id}`,
      expiresAt: session.expiresAt,
    },
  });
};

export const tusOptionsHandler: RequestHandler = async (_req, res) => {
  setTusCommonHeaders(res);
  res.setHeader("Access-Control-Allow-Methods", "POST,HEAD,PATCH,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization,Content-Type,Upload-Length,Upload-Offset,Tus-Resumable,Upload-Metadata",
  );
  res.status(204).end();
};

export const tusCreateHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const env = getTusEnv(req);
  setTusCommonHeaders(res);

  if (req.header("Tus-Resumable") !== TUS_VERSION) {
    throw new AppError("Tus 版本不匹配。", {
      statusCode: 412,
      code: "TUS_VERSION_MISMATCH",
    });
  }

  const uploadLength = parseUploadLength(req.header("Upload-Length"), env.maxUploadSizeBytes);
  const metadata = parseTusMetadata(req.header("Upload-Metadata") ?? undefined);

  if (!metadata.originalName) {
    throw new AppError("Tus 上传缺少 originalName 元数据。", {
      statusCode: 400,
      code: "MISSING_FILE_NAME",
    });
  }

  const uploadPurpose = metadata.purpose ? parseUploadPurpose(metadata.purpose) : undefined;
  const session = await createUploadSession({
    originalName: metadata.originalName,
    mimeType: metadata.mimeType || "application/octet-stream",
    size: uploadLength,
    purpose: uploadPurpose,
    createdBy: authUser.id,
  });

  res.setHeader("Location", getTusUploadLocation(req, session.id));
  res.setHeader("Upload-Offset", "0");
  res.status(201).end();
};

export const tusBindHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const env = getTusEnv(req);
  const uploadId = getUploadIdParam(req);
  setTusCommonHeaders(res);

  if (req.header("Tus-Resumable") !== TUS_VERSION) {
    throw new AppError("Tus 版本不匹配。", {
      statusCode: 412,
      code: "TUS_VERSION_MISMATCH",
    });
  }

  const session = await getUploadSession(uploadId, authUser.id);
  const uploadLength = parseUploadLength(req.header("Upload-Length"), env.maxUploadSizeBytes);
  const metadata = parseTusMetadata(req.header("Upload-Metadata") ?? undefined);

  if (uploadLength !== session.size) {
    throw new AppError("Tus 上传长度与预创建会话不一致。", {
      statusCode: 409,
      code: "UPLOAD_LENGTH_MISMATCH",
    });
  }

  if (metadata.originalName && metadata.originalName !== session.originalName) {
    throw new AppError("Tus 上传文件名与预创建会话不一致。", {
      statusCode: 409,
      code: "UPLOAD_NAME_MISMATCH",
    });
  }

  res.setHeader("Location", getTusUploadLocation(req, uploadId));
  res.setHeader("Upload-Offset", String(session.offset));
  res.status(201).end();
};

export const tusHeadHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const uploadId = getUploadIdParam(req);
  const session = await getUploadSession(uploadId, authUser.id);

  setTusCommonHeaders(res);
  res.setHeader("Upload-Length", String(session.size));
  res.setHeader("Upload-Offset", String(session.offset));
  res.status(200).end();
};

export const tusPatchHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const uploadId = getUploadIdParam(req);
  setTusCommonHeaders(res);

  if (req.header("Tus-Resumable") !== TUS_VERSION) {
    throw new AppError("Tus 版本不匹配。", {
      statusCode: 412,
      code: "TUS_VERSION_MISMATCH",
    });
  }

  if (req.header("Content-Type") !== "application/offset+octet-stream") {
    throw new AppError("Tus 分片 Content-Type 不正确。", {
      statusCode: 415,
      code: "INVALID_TUS_CONTENT_TYPE",
    });
  }

  const rawUploadOffset = req.header("Upload-Offset");

  if (!rawUploadOffset) {
    throw new AppError("缺少 Upload-Offset。", {
      statusCode: 400,
      code: "MISSING_UPLOAD_OFFSET",
    });
  }

  const expectedOffset = Number(rawUploadOffset);

  if (!Number.isInteger(expectedOffset) || expectedOffset < 0) {
    throw new AppError("Upload-Offset 不合法。", {
      statusCode: 400,
      code: "INVALID_UPLOAD_OFFSET",
    });
  }

  const chunks: Buffer[] = [];

  await new Promise<void>((resolve, reject) => {
    req.on("data", (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => resolve());
    req.on("error", reject);
  });

  const chunk = chunks.length > 0 ? Buffer.concat(chunks) : Buffer.alloc(0);
  const session = await appendUploadChunk(uploadId, authUser.id, expectedOffset, chunk);

  res.setHeader("Upload-Offset", String(session.offset));
  res.status(204).end();
};

export const completeUploadSessionHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const uploadId = getUploadIdParam(req);
  const file = await finalizeUploadSession(uploadId, authUser.id, validateUploadContent);

  res.status(201).json({
    item: file,
  });
};
