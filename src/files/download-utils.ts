import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type { RequestHandler, Response } from "express";

import { AppError } from "../utils/app-error.js";

const RANGE_HEADER_PREFIX = "bytes=";
const DEFAULT_DOWNLOAD_MIME_TYPE = "application/octet-stream";

export function createSignedDownloadSignature(
  parts: Array<string | number>,
  expiresAt: number,
  secret: string,
): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${parts.join(":")}:${expiresAt}`)
    .digest("base64url");
}

export function buildDownloadUrl(routePath: string, fileBaseUrl?: string): string {
  const baseUrl = fileBaseUrl?.trim();

  if (baseUrl) {
    return new URL(routePath, `${baseUrl.replace(/\/+$/, "")}/`).toString();
  }

  // 未显式配置对外下载基址时，返回相对地址而不是猜测当前 Host。
  // 这样可以避免局域网访问、反向代理或本机开发场景下，把 127.0.0.1
  // 之类仅服务端本机可见的地址错误地下发给客户端。
  return routePath;
}

export function isValidSignedDownloadSignature(
  signature: string,
  parts: Array<string | number>,
  expiresAt: number,
  secret: string,
): boolean {
  const expectedSignature = createSignedDownloadSignature(parts, expiresAt, secret);

  return (
    signature.length === expectedSignature.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  );
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

export async function streamStoredFileDownload(
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
  const rangeHeader = req.headers.range;

  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", DEFAULT_DOWNLOAD_MIME_TYPE);
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
