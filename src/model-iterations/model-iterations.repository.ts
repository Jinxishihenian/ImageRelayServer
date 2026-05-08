import type { ResultSetHeader, RowDataPacket } from "mysql2";

import { MODEL_ITERATION_STATUS_LABELS, REVIEW_STATUS_LABELS, STATUS_LABELS } from "../common/role-status.js";
import { toIsoString } from "../common/date.js";
import { execute, query } from "../database/mysql.js";
import type { ModelIterationStatus, TaskReviewStatus, TaskStatus } from "../types/domain.js";

export type ModelIterationRow = {
  id: number;
  name: string;
  description: string;
  baseModelName: string;
  goal: string;
  status: ModelIterationStatus;
  statusLabel: string;
  creatorId: number;
  creatorUsername: string;
  currentBestTaskId: number | null;
  latestTaskId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type ModelIterationListItem = ModelIterationRow & {
  taskCount: number;
  latestTaskAt: string | null;
};

export type ModelIterationTaskItem = {
  id: number;
  title: string;
  status: TaskStatus;
  statusLabel: string;
  reviewStatus: TaskReviewStatus;
  reviewStatusLabel: string;
  cleaner: {
    id: number;
    username: string;
  };
  annotator: {
    id: number;
    username: string;
  };
  trainer: {
    id: number;
    username: string;
  };
  createdAt: string;
  finishedAt: string | null;
};

export type ModelIterationResultItem = {
  taskId: number;
  taskTitle: string;
  modelFileName: string;
  trainerRemark: string | null;
  finishedAt: string;
  trainer: {
    id: number;
    username: string;
  };
};

type ModelIterationQueryRow = RowDataPacket & {
  id: number;
  name: string;
  description: string;
  base_model_name: string;
  goal: string;
  status: ModelIterationStatus;
  creator_id: number;
  creator_username: string;
  current_best_task_id: number | null;
  latest_task_id: number | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type ModelIterationListQueryRow = ModelIterationQueryRow & {
  task_count: number;
  latest_task_at: Date | string | null;
};

type ModelIterationTaskQueryRow = RowDataPacket & {
  id: number;
  title: string;
  status: TaskStatus;
  review_status: TaskReviewStatus;
  cleaner_id: number;
  cleaner_username: string;
  annotator_id: number;
  annotator_username: string;
  trainer_id: number;
  trainer_username: string;
  created_at: Date | string;
  finished_at: Date | string | null;
};

type ModelIterationResultQueryRow = RowDataPacket & {
  task_id: number;
  task_title: string;
  model_file_name: string;
  trainer_remark: string | null;
  finished_at: Date | string;
  trainer_id: number;
  trainer_username: string;
};

type CountRow = RowDataPacket & {
  total: number;
};

function getBaseModelIterationSelectSql(): string {
  return `
    SELECT
      mi.id,
      mi.name,
      mi.description,
      mi.base_model_name,
      mi.goal,
      mi.status,
      mi.creator_id,
      creator.username AS creator_username,
      mi.current_best_task_id,
      mi.latest_task_id,
      mi.created_at,
      mi.updated_at
    FROM model_iterations mi
    INNER JOIN users creator ON creator.id = mi.creator_id
  `;
}

function mapModelIterationRow(row: ModelIterationQueryRow): ModelIterationRow {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    baseModelName: row.base_model_name,
    goal: row.goal,
    status: row.status,
    statusLabel: MODEL_ITERATION_STATUS_LABELS[row.status],
    creatorId: row.creator_id,
    creatorUsername: row.creator_username,
    currentBestTaskId: row.current_best_task_id,
    latestTaskId: row.latest_task_id,
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function mapModelIterationListRow(row: ModelIterationListQueryRow): ModelIterationListItem {
  return {
    ...mapModelIterationRow(row),
    taskCount: Number(row.task_count ?? 0),
    latestTaskAt: row.latest_task_at ? toIsoString(row.latest_task_at) : null,
  };
}

function mapModelIterationTaskRow(row: ModelIterationTaskQueryRow): ModelIterationTaskItem {
  const displayStatusLabel =
    row.review_status === "pending_admin_review"
      ? "等待管理员复核"
      : row.review_status === "rejected"
        ? "已驳回待重新提交"
        : STATUS_LABELS[row.status];

  return {
    id: row.id,
    title: row.title,
    status: row.status,
    statusLabel: displayStatusLabel,
    reviewStatus: row.review_status,
    reviewStatusLabel: REVIEW_STATUS_LABELS[row.review_status],
    cleaner: {
      id: row.cleaner_id,
      username: row.cleaner_username,
    },
    annotator: {
      id: row.annotator_id,
      username: row.annotator_username,
    },
    trainer: {
      id: row.trainer_id,
      username: row.trainer_username,
    },
    createdAt: toIsoString(row.created_at),
    finishedAt: row.finished_at ? toIsoString(row.finished_at) : null,
  };
}

function mapModelIterationResultRow(row: ModelIterationResultQueryRow): ModelIterationResultItem {
  return {
    taskId: row.task_id,
    taskTitle: row.task_title,
    modelFileName: row.model_file_name,
    trainerRemark: row.trainer_remark,
    finishedAt: toIsoString(row.finished_at),
    trainer: {
      id: row.trainer_id,
      username: row.trainer_username,
    },
  };
}

function buildModelIterationFilter(keyword?: string): {
  whereClause: string;
  params: string[];
} {
  if (!keyword) {
    return {
      whereClause: "",
      params: [],
    };
  }

  return {
    whereClause: "WHERE mi.name LIKE ?",
    params: [`%${keyword}%`],
  };
}

export async function listModelIterations(input: {
  page: number;
  pageSize: number;
  keyword?: string;
}): Promise<{
  items: ModelIterationListItem[];
  page: number;
  pageSize: number;
  total: number;
}> {
  const filter = buildModelIterationFilter(input.keyword);
  const summaryRows = await query<CountRow[]>(
    `
      SELECT COUNT(*) AS total
      FROM model_iterations mi
      ${filter.whereClause}
    `,
    filter.params,
  );
  const total = Number(summaryRows[0]?.total ?? 0);
  const totalPages = total === 0 ? 0 : Math.ceil(total / input.pageSize);
  const page = totalPages > 0 ? Math.min(input.page, totalPages) : input.page;
  const offset = (page - 1) * input.pageSize;
  const rows = await query<ModelIterationListQueryRow[]>(
    `
      SELECT
        mi.id,
        mi.name,
        mi.description,
        mi.base_model_name,
        mi.goal,
        mi.status,
        mi.creator_id,
        creator.username AS creator_username,
        mi.current_best_task_id,
        mi.latest_task_id,
        mi.created_at,
        mi.updated_at,
        COUNT(t.id) AS task_count,
        MAX(t.created_at) AS latest_task_at
      FROM model_iterations mi
      INNER JOIN users creator ON creator.id = mi.creator_id
      LEFT JOIN tasks t ON t.model_iteration_id = mi.id
      ${filter.whereClause}
      GROUP BY mi.id
      ORDER BY mi.created_at DESC, mi.id DESC
      LIMIT ? OFFSET ?
    `,
    [...filter.params, input.pageSize, offset],
  );

  return {
    items: rows.map(mapModelIterationListRow),
    page,
    pageSize: input.pageSize,
    total,
  };
}

export async function listAllModelIterations(keyword?: string): Promise<ModelIterationListItem[]> {
  const filter = buildModelIterationFilter(keyword);
  const rows = await query<ModelIterationListQueryRow[]>(
    `
      SELECT
        mi.id,
        mi.name,
        mi.description,
        mi.base_model_name,
        mi.goal,
        mi.status,
        mi.creator_id,
        creator.username AS creator_username,
        mi.current_best_task_id,
        mi.latest_task_id,
        mi.created_at,
        mi.updated_at,
        COUNT(t.id) AS task_count,
        MAX(t.created_at) AS latest_task_at
      FROM model_iterations mi
      INNER JOIN users creator ON creator.id = mi.creator_id
      LEFT JOIN tasks t ON t.model_iteration_id = mi.id
      ${filter.whereClause}
      GROUP BY mi.id
      ORDER BY mi.created_at DESC, mi.id DESC
    `,
    filter.params,
  );

  return rows.map(mapModelIterationListRow);
}

export async function findModelIterationById(
  modelIterationId: number,
): Promise<ModelIterationRow | null> {
  const rows = await query<ModelIterationQueryRow[]>(
    `
      ${getBaseModelIterationSelectSql()}
      WHERE mi.id = ?
      LIMIT 1
    `,
    [modelIterationId],
  );

  const row = rows[0];
  return row ? mapModelIterationRow(row) : null;
}

export async function createModelIteration(input: {
  name: string;
  description: string;
  baseModelName: string;
  goal: string;
  creatorId: number;
}): Promise<number> {
  const result = await execute(
    `
      INSERT INTO model_iterations (
        name,
        description,
        base_model_name,
        goal,
        status,
        creator_id
      ) VALUES (?, ?, ?, ?, 'active', ?)
    `,
    [input.name, input.description, input.baseModelName, input.goal, input.creatorId],
  );

  return result.insertId;
}

export async function listTasksByModelIteration(
  modelIterationId: number,
): Promise<ModelIterationTaskItem[]> {
  const rows = await query<ModelIterationTaskQueryRow[]>(
    `
      SELECT
        t.id,
        t.title,
        t.status,
        t.review_status,
        cleaner.id AS cleaner_id,
        cleaner.username AS cleaner_username,
        annotator.id AS annotator_id,
        annotator.username AS annotator_username,
        trainer.id AS trainer_id,
        trainer.username AS trainer_username,
        t.created_at,
        t.finished_at
      FROM tasks t
      INNER JOIN users cleaner ON cleaner.id = t.cleaner_id
      INNER JOIN users annotator ON annotator.id = t.annotator_id
      INNER JOIN users trainer ON trainer.id = t.trainer_id
      WHERE t.model_iteration_id = ?
      ORDER BY t.created_at DESC, t.id DESC
    `,
    [modelIterationId],
  );

  return rows.map(mapModelIterationTaskRow);
}

export async function listModelResultsByModelIteration(
  modelIterationId: number,
): Promise<ModelIterationResultItem[]> {
  const rows = await query<ModelIterationResultQueryRow[]>(
    `
      SELECT
        t.id AS task_id,
        t.title AS task_title,
        t.model_file_name,
        t.trainer_remark,
        t.finished_at,
        trainer.id AS trainer_id,
        trainer.username AS trainer_username
      FROM tasks t
      INNER JOIN users trainer ON trainer.id = t.trainer_id
      WHERE
        t.model_iteration_id = ?
        AND t.status = 'finished'
        AND t.model_file IS NOT NULL
        AND t.model_file_name IS NOT NULL
        AND t.finished_at IS NOT NULL
      ORDER BY t.finished_at DESC, t.id DESC
    `,
    [modelIterationId],
  );

  return rows.map(mapModelIterationResultRow);
}

export async function findFinishedModelTaskInModelIteration(
  modelIterationId: number,
  taskId: number,
): Promise<ModelIterationResultItem | null> {
  const rows = await query<ModelIterationResultQueryRow[]>(
    `
      SELECT
        t.id AS task_id,
        t.title AS task_title,
        t.model_file_name,
        t.trainer_remark,
        t.finished_at,
        trainer.id AS trainer_id,
        trainer.username AS trainer_username
      FROM tasks t
      INNER JOIN users trainer ON trainer.id = t.trainer_id
      WHERE
        t.model_iteration_id = ?
        AND t.id = ?
        AND t.status = 'finished'
        AND t.model_file IS NOT NULL
        AND t.model_file_name IS NOT NULL
        AND t.finished_at IS NOT NULL
      LIMIT 1
    `,
    [modelIterationId, taskId],
  );

  const row = rows[0];
  return row ? mapModelIterationResultRow(row) : null;
}

export async function updateModelIterationCurrentBestTask(input: {
  modelIterationId: number;
  taskId: number;
}): Promise<boolean> {
  const result = await execute(
    `
      UPDATE model_iterations
      SET current_best_task_id = ?, updated_at = NOW()
      WHERE id = ?
    `,
    [input.taskId, input.modelIterationId],
  );

  return result.affectedRows > 0;
}

export async function updateModelIterationLatestTask(input: {
  modelIterationId: number;
  taskId: number;
}): Promise<boolean> {
  const result = await execute(
    `
      UPDATE model_iterations
      SET latest_task_id = ?, updated_at = NOW()
      WHERE id = ?
    `,
    [input.taskId, input.modelIterationId],
  );

  return result.affectedRows > 0;
}

export async function clearModelIterationTaskReferences(taskId: number): Promise<void> {
  await execute(
    `
      UPDATE model_iterations
      SET
        current_best_task_id = CASE WHEN current_best_task_id = ? THEN NULL ELSE current_best_task_id END,
        latest_task_id = CASE WHEN latest_task_id = ? THEN NULL ELSE latest_task_id END,
        updated_at = CASE
          WHEN current_best_task_id = ? OR latest_task_id = ? THEN NOW()
          ELSE updated_at
        END
      WHERE current_best_task_id = ? OR latest_task_id = ?
    `,
    [taskId, taskId, taskId, taskId, taskId, taskId],
  );
}
