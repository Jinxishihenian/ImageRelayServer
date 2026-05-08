import type { RequestHandler } from "express";

import {
  buildPaginationMeta,
  parseOptionalString,
  parsePaginationQuery,
  parsePositiveInteger,
} from "../common/http.js";
import { AppError } from "../utils/app-error.js";
import { findDatasetById, listDatasets } from "./datasets.repository.js";

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

