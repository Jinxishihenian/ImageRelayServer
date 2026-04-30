import type { RequestHandler } from "express";

import { parseUploadPurpose, validateUploadContent } from "./archive-utils.js";
import { saveTempUpload } from "./file-storage.js";
import { AppError } from "../utils/app-error.js";

export const uploadFileHandler: RequestHandler = async (req, res) => {
  const fileNameHeader = req.headers["x-file-name"];
  const originalName =
    typeof fileNameHeader === "string"
      ? decodeURIComponent(fileNameHeader)
      : Array.isArray(fileNameHeader)
        ? decodeURIComponent(fileNameHeader[0])
        : "";

  if (!originalName) {
    throw new AppError("缺少文件名请求头 x-file-name。", {
      statusCode: 400,
      code: "MISSING_FILE_NAME",
    });
  }

  if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) {
    throw new AppError("上传文件内容不能为空。", {
      statusCode: 400,
      code: "EMPTY_FILE_BODY",
    });
  }

  const uploadPurpose = parseUploadPurpose(req.headers["x-upload-purpose"]);
  await validateUploadContent(req.body, originalName, uploadPurpose);

  const file = await saveTempUpload(req.body, originalName, req.headers["content-type"] || "application/octet-stream");

  res.status(201).json({
    item: file,
  });
};
