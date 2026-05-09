import type { RequestHandler } from "express";

import {
  buildPaginationMeta,
  parseOptionalString,
  parsePaginationQuery,
  parsePositiveInteger,
} from "../common/http.js";
import {
  buildDownloadUrl,
  createSignedDownloadSignature,
  isValidSignedDownloadSignature,
  streamStoredFileDownload,
} from "../files/download-utils.js";
import { ensureStoredFileExists } from "../files/file-storage.js";
import { AppError } from "../utils/app-error.js";
import {
  findDatasetById,
  findDatasetVersionForDownload,
  listDatasets,
} from "./datasets.repository.js";

const DATASET_DOWNLOAD_LINK_ROUTE = "/api/v1/public/dataset-versions/download";

function getSingleRouteParam(value: string | string[] | undefined, fieldName: string): string {
  if (typeof value === "string") {
    return value;
  }

  throw new AppError(`缺少有效的路由参数 ${fieldName}。`, {
    statusCode: 400,
    code: "INVALID_ROUTE_PARAM",
  });
}

export const listDatasetsHandler: RequestHandler = async (req, res) => {
  const pagination = parsePaginationQuery(req.query);
  const keyword = parseOptionalString(req.query.keyword, "keyword");
  const page = await listDatasets({
    ...pagination,
    keyword,
  });

  res.json({
    items: page.items,
    pagination: buildPaginationMeta(page.page, page.pageSize, page.total),
  });
};

export const getDatasetDetailHandler: RequestHandler = async (req, res) => {
  const datasetId = parsePositiveInteger(
    getSingleRouteParam(req.params.datasetId, "datasetId"),
    "datasetId",
  );
  const dataset = await findDatasetById(datasetId);

  if (!dataset) {
    throw new AppError("数据集不存在。", {
      statusCode: 404,
      code: "DATASET_NOT_FOUND",
    });
  }

  res.json(dataset);
};

export const downloadDatasetVersionFileHandler: RequestHandler = async (req, res) => {
  const datasetId = parsePositiveInteger(
    getSingleRouteParam(req.params.datasetId, "datasetId"),
    "datasetId",
  );
  const versionId = parsePositiveInteger(
    getSingleRouteParam(req.params.versionId, "versionId"),
    "versionId",
  );
  const version = await findDatasetVersionForDownload(datasetId, versionId);

  if (!version) {
    throw new AppError("数据集版本不存在。", {
      statusCode: 404,
      code: "DATASET_VERSION_NOT_FOUND",
    });
  }

  const absolutePath = await ensureStoredFileExists(version.storageKey);
  await streamStoredFileDownload(req, res, absolutePath, version.fileName);
};

export const createDatasetVersionDownloadLinkHandler: RequestHandler = async (req, res) => {
  const datasetId = parsePositiveInteger(
    getSingleRouteParam(req.params.datasetId, "datasetId"),
    "datasetId",
  );
  const versionId = parsePositiveInteger(
    getSingleRouteParam(req.params.versionId, "versionId"),
    "versionId",
  );
  const version = await findDatasetVersionForDownload(datasetId, versionId);

  if (!version) {
    throw new AppError("数据集版本不存在。", {
      statusCode: 404,
      code: "DATASET_VERSION_NOT_FOUND",
    });
  }

  const env = req.app.get("envConfig") as {
    downloadLinkSecret: string;
    downloadLinkTtlMs: number;
    fileBaseUrl?: string;
  };
  const expiresAt = Date.now() + env.downloadLinkTtlMs;
  const signature = createSignedDownloadSignature(
    [datasetId, versionId],
    expiresAt,
    env.downloadLinkSecret,
  );
  const url = buildDownloadUrl(
    `${DATASET_DOWNLOAD_LINK_ROUTE}?datasetId=${datasetId}&versionId=${versionId}&expiresAt=${expiresAt}&signature=${encodeURIComponent(signature)}`,
    env.fileBaseUrl,
  );

  res.json({
    url,
    expiresAt: new Date(expiresAt).toISOString(),
  });
};

export const publicDownloadDatasetVersionFileHandler: RequestHandler = async (req, res) => {
  const datasetIdRaw = typeof req.query.datasetId === "string" ? req.query.datasetId : undefined;
  const versionIdRaw = typeof req.query.versionId === "string" ? req.query.versionId : undefined;
  const expiresAtRaw = typeof req.query.expiresAt === "string" ? req.query.expiresAt : undefined;
  const signature = typeof req.query.signature === "string" ? req.query.signature : undefined;

  if (!datasetIdRaw || !versionIdRaw) {
    throw new AppError("下载链接缺少数据集版本信息。", {
      statusCode: 400,
      code: "INVALID_DOWNLOAD_LINK",
    });
  }

  if (!expiresAtRaw || !signature) {
    throw new AppError("下载链接缺少必要参数。", {
      statusCode: 400,
      code: "INVALID_DOWNLOAD_LINK",
    });
  }

  const datasetId = parsePositiveInteger(datasetIdRaw, "datasetId");
  const versionId = parsePositiveInteger(versionIdRaw, "versionId");
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
      [datasetId, versionId],
      expiresAt,
      env.downloadLinkSecret,
    )
  ) {
    throw new AppError("下载链接无效或已被篡改。", {
      statusCode: 403,
      code: "INVALID_DOWNLOAD_LINK",
    });
  }

  const version = await findDatasetVersionForDownload(datasetId, versionId);

  if (!version) {
    throw new AppError("数据集版本不存在。", {
      statusCode: 404,
      code: "DATASET_VERSION_NOT_FOUND",
    });
  }

  const absolutePath = await ensureStoredFileExists(version.storageKey);
  await streamStoredFileDownload(req, res, absolutePath, version.fileName);
};
