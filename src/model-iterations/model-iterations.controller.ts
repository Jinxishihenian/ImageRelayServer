import type { RequestHandler } from "express";

import { getAuthUser } from "../auth/auth.middleware.js";
import { MODEL_ITERATION_STATUS_LABELS, FILE_LABELS } from "../common/role-status.js";
import {
  buildPaginationMeta,
  parseOptionalBoolean,
  parseOptionalString,
  parsePaginationQuery,
  parsePositiveInteger,
} from "../common/http.js";
import { listDatasetsByModelIteration } from "../datasets/datasets.repository.js";
import { AppError } from "../utils/app-error.js";
import {
  createModelIteration,
  findFinishedModelTaskInModelIteration,
  findModelIterationById,
  listAllModelIterations,
  listModelIterations,
  listModelResultsByModelIteration,
  listTasksByModelIteration,
  updateModelIterationCurrentBestTask,
  type ModelIterationResultItem,
  type ModelIterationRow,
} from "./model-iterations.repository.js";

function getSingleRouteParam(value: string | string[] | undefined, fieldName: string): string {
  if (typeof value === "string") {
    return value;
  }

  throw new AppError(`缺少有效的路由参数 ${fieldName}。`, {
    statusCode: 400,
    code: "INVALID_ROUTE_PARAM",
  });
}

function mapModelIterationResultItem(item: ModelIterationResultItem) {
  return {
    taskId: item.taskId,
    taskTitle: item.taskTitle,
    modelFileName: item.modelFileName,
    trainerRemark: item.trainerRemark,
    finishedAt: item.finishedAt,
    trainer: item.trainer,
    download: {
      alias: "model" as const,
      label: FILE_LABELS.model,
      fileName: item.modelFileName,
      endpoint: `/api/v1/tasks/${item.taskId}/files/model/download`,
    },
  };
}

async function buildModelIterationDetail(modelIteration: ModelIterationRow) {
  const [tasks, results, datasets] = await Promise.all([
    listTasksByModelIteration(modelIteration.id),
    listModelResultsByModelIteration(modelIteration.id),
    listDatasetsByModelIteration(modelIteration.id),
  ]);

  const latestModelResult = modelIteration.latestTaskId
    ? await findFinishedModelTaskInModelIteration(modelIteration.id, modelIteration.latestTaskId)
    : results[0] ?? null;
  const currentBestResult = modelIteration.currentBestTaskId
    ? await findFinishedModelTaskInModelIteration(modelIteration.id, modelIteration.currentBestTaskId)
    : null;

  return {
    id: modelIteration.id,
    name: modelIteration.name,
    description: modelIteration.description,
    baseModelName: modelIteration.baseModelName,
    goal: modelIteration.goal,
    status: modelIteration.status,
    statusLabel: MODEL_ITERATION_STATUS_LABELS[modelIteration.status],
    creator: {
      id: modelIteration.creatorId,
      username: modelIteration.creatorUsername,
    },
    currentBestTaskId: modelIteration.currentBestTaskId,
    latestTaskId: modelIteration.latestTaskId,
    createdAt: modelIteration.createdAt,
    updatedAt: modelIteration.updatedAt,
    tasks,
    results: results.map(mapModelIterationResultItem),
    datasets,
    latestModelResult: latestModelResult ? mapModelIterationResultItem(latestModelResult) : null,
    currentBestResult: currentBestResult ? mapModelIterationResultItem(currentBestResult) : null,
  };
}

export const listModelIterationsHandler: RequestHandler = async (req, res) => {
  const all = parseOptionalBoolean(req.query.all, "all");
  const keyword = parseOptionalString(req.query.keyword, "keyword");

  if (all) {
    const items = await listAllModelIterations(keyword);

    res.json({
      items,
      pagination: buildPaginationMeta(1, items.length === 0 ? 10 : items.length, items.length),
    });
    return;
  }

  const pagination = parsePaginationQuery(req.query);
  const page = await listModelIterations({
    ...pagination,
    keyword,
  });

  res.json({
    items: page.items,
    pagination: buildPaginationMeta(page.page, page.pageSize, page.total),
  });
};

export const getModelIterationDetailHandler: RequestHandler = async (req, res) => {
  const modelIterationId = parsePositiveInteger(
    getSingleRouteParam(req.params.modelIterationId, "modelIterationId"),
    "modelIterationId",
  );
  const modelIteration = await findModelIterationById(modelIterationId);

  if (!modelIteration) {
    throw new AppError("模型迭代不存在。", {
      statusCode: 404,
      code: "MODEL_ITERATION_NOT_FOUND",
    });
  }

  res.json(await buildModelIterationDetail(modelIteration));
};

export const createModelIterationHandler: RequestHandler = async (req, res) => {
  const authUser = getAuthUser(req);
  const {
    name,
    description,
    baseModelName,
    goal,
  } = req.body as {
    name?: string;
    description?: string;
    baseModelName?: string;
    goal?: string;
  };

  if (!name?.trim()) {
    throw new AppError("模型迭代名称不能为空。", {
      statusCode: 400,
      code: "INVALID_MODEL_ITERATION_NAME",
    });
  }

  if (!baseModelName?.trim()) {
    throw new AppError("基线模型名称或来源说明不能为空。", {
      statusCode: 400,
      code: "INVALID_MODEL_ITERATION_BASE_MODEL",
    });
  }

  if (!goal?.trim()) {
    throw new AppError("本轮迭代目标不能为空。", {
      statusCode: 400,
      code: "INVALID_MODEL_ITERATION_GOAL",
    });
  }

  const modelIterationId = await createModelIteration({
    name: name.trim(),
    description: description?.trim() ?? "",
    baseModelName: baseModelName.trim(),
    goal: goal.trim(),
    creatorId: authUser.id,
  });
  const created = await findModelIterationById(modelIterationId);

  res.status(201).json({
    item: created,
  });
};

export const markCurrentBestModelResultHandler: RequestHandler = async (req, res) => {
  const modelIterationId = parsePositiveInteger(
    getSingleRouteParam(req.params.modelIterationId, "modelIterationId"),
    "modelIterationId",
  );
  const { taskId } = req.body as {
    taskId?: number;
  };
  const normalizedTaskId = Number(taskId);

  if (!Number.isInteger(normalizedTaskId) || normalizedTaskId <= 0) {
    throw new AppError("taskId 必须是正整数。", {
      statusCode: 400,
      code: "INVALID_TASK_ID",
    });
  }

  const modelIteration = await findModelIterationById(modelIterationId);

  if (!modelIteration) {
    throw new AppError("模型迭代不存在。", {
      statusCode: 404,
      code: "MODEL_ITERATION_NOT_FOUND",
    });
  }

  const task = await findFinishedModelTaskInModelIteration(modelIterationId, normalizedTaskId);

  if (!task) {
    throw new AppError("只能将当前模型迭代下已完成且存在模型文件的任务标记为最佳结果。", {
      statusCode: 400,
      code: "INVALID_MODEL_ITERATION_BEST_TASK",
    });
  }

  await updateModelIterationCurrentBestTask({
    modelIterationId,
    taskId: normalizedTaskId,
  });

  const updated = await findModelIterationById(modelIterationId);

  res.json({
    item: updated ? await buildModelIterationDetail(updated) : null,
  });
};
