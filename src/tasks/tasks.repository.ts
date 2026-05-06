import type { ResultSetHeader, RowDataPacket } from "mysql2";

import { execute, query } from "../database/mysql.js";
import type { TaskStatus, UserRole } from "../types/domain.js";
import { toIsoString } from "../common/date.js";

export type TaskRow = {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  creatorId: number;
  cleanerId: number;
  annotatorId: number;
  trainerId: number;
  sourceFile: string | null;
  sourceFileName: string | null;
  cleanedFile: string | null;
  cleanedFileName: string | null;
  annotatedFile: string | null;
  annotatedFileName: string | null;
  modelFile: string | null;
  modelFileName: string | null;
  cleanerRemark: string | null;
  annotatorRemark: string | null;
  trainerRemark: string | null;
  createdAt: string;
  finishedAt: string | null;
  creatorUsername: string;
  cleanerUsername: string;
  annotatorUsername: string;
  trainerUsername: string;
};

type TaskQueryRow = RowDataPacket & {
  id: number;
  title: string;
  description: string;
  status: TaskStatus;
  creator_id: number;
  cleaner_id: number;
  annotator_id: number;
  trainer_id: number;
  source_file: string | null;
  source_file_name: string | null;
  cleaned_file: string | null;
  cleaned_file_name: string | null;
  annotated_file: string | null;
  annotated_file_name: string | null;
  model_file: string | null;
  model_file_name: string | null;
  cleaner_remark: string | null;
  annotator_remark: string | null;
  trainer_remark: string | null;
  created_at: Date | string;
  finished_at: Date | string | null;
  creator_username: string;
  cleaner_username: string;
  annotator_username: string;
  trainer_username: string;
};

type TaskListScope = {
  id: number;
  role: UserRole;
};

type TaskListFilters = {
  keyword?: string;
  status?: TaskStatus;
};

type ModelListFilters = {
  keyword?: string;
};

export type TaskListSummary = {
  total: number;
  actionableCount: number;
  finishedCount: number;
};

export type PaginatedTasksResult = {
  items: TaskRow[];
  page: number;
  pageSize: number;
  total: number;
  summary: TaskListSummary;
};

export type ModelListItem = {
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

export type PaginatedModelsResult = {
  items: ModelListItem[];
  page: number;
  pageSize: number;
  total: number;
};

type CreateTaskInput = {
  title: string;
  description: string;
  creatorId: number;
  cleanerId: number;
  annotatorId: number;
  trainerId: number;
};

type StageCompletionInput = {
  taskId: number;
  currentStatus: TaskStatus;
  nextStatus: TaskStatus;
  fileColumn: "cleaned_file" | "annotated_file" | "model_file";
  fileNameColumn: "cleaned_file_name" | "annotated_file_name" | "model_file_name";
  remarkColumn: "cleaner_remark" | "annotator_remark" | "trainer_remark";
  storageKey: string;
  originalName: string;
  remark: string;
};

function mapTaskRow(row: TaskQueryRow): TaskRow {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    creatorId: row.creator_id,
    cleanerId: row.cleaner_id,
    annotatorId: row.annotator_id,
    trainerId: row.trainer_id,
    sourceFile: row.source_file,
    sourceFileName: row.source_file_name,
    cleanedFile: row.cleaned_file,
    cleanedFileName: row.cleaned_file_name,
    annotatedFile: row.annotated_file,
    annotatedFileName: row.annotated_file_name,
    modelFile: row.model_file,
    modelFileName: row.model_file_name,
    cleanerRemark: row.cleaner_remark,
    annotatorRemark: row.annotator_remark,
    trainerRemark: row.trainer_remark,
    createdAt: toIsoString(row.created_at),
    finishedAt: row.finished_at ? toIsoString(row.finished_at) : null,
    creatorUsername: row.creator_username,
    cleanerUsername: row.cleaner_username,
    annotatorUsername: row.annotator_username,
    trainerUsername: row.trainer_username,
  };
}

function getBaseTaskSelectSql(): string {
  return `
    SELECT
      t.id,
      t.title,
      t.description,
      t.status,
      t.creator_id,
      t.cleaner_id,
      t.annotator_id,
      t.trainer_id,
      t.source_file,
      t.source_file_name,
      t.cleaned_file,
      t.cleaned_file_name,
      t.annotated_file,
      t.annotated_file_name,
      t.model_file,
      t.model_file_name,
      t.cleaner_remark,
      t.annotator_remark,
      t.trainer_remark,
      t.created_at,
      t.finished_at,
      creator.username AS creator_username,
      cleaner.username AS cleaner_username,
      annotator.username AS annotator_username,
      trainer.username AS trainer_username
    FROM tasks t
    INNER JOIN users creator ON creator.id = t.creator_id
    INNER JOIN users cleaner ON cleaner.id = t.cleaner_id
    INNER JOIN users annotator ON annotator.id = t.annotator_id
    INNER JOIN users trainer ON trainer.id = t.trainer_id
  `;
}

function getTaskScopeFilter(scope: TaskListScope): {
  whereClause: string;
  params: number[];
} {
  if (scope.role === "admin") {
    return {
      whereClause: "",
      params: [],
    };
  }

  return {
    whereClause: `
      WHERE t.cleaner_id = ? OR t.annotator_id = ? OR t.trainer_id = ?
    `,
    params: [scope.id, scope.id, scope.id],
  };
}

function buildTaskListFilter(scope: TaskListScope, filters?: TaskListFilters): {
  whereClause: string;
  params: Array<number | string>;
} {
  const conditions: string[] = [];
  const params: Array<number | string> = [];

  if (scope.role !== "admin") {
    conditions.push("(t.cleaner_id = ? OR t.annotator_id = ? OR t.trainer_id = ?)");
    params.push(scope.id, scope.id, scope.id);
  }

  if (filters?.keyword) {
    conditions.push("t.title LIKE ?");
    params.push(`%${filters.keyword}%`);
  }

  if (filters?.status) {
    conditions.push("t.status = ?");
    params.push(filters.status);
  }

  return {
    whereClause: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}

function getActionableSummarySql(scope: TaskListScope): {
  sql: string;
  params: number[];
} {
  switch (scope.role) {
    case "admin":
      return {
        sql: "0 AS actionable_count",
        params: [],
      };
    case "cleaner":
      return {
        sql: `
          SUM(CASE WHEN t.status = 'pending_clean' AND t.cleaner_id = ? THEN 1 ELSE 0 END)
          AS actionable_count
        `,
        params: [scope.id],
      };
    case "annotator":
      return {
        sql: `
          SUM(CASE WHEN t.status = 'pending_annotate' AND t.annotator_id = ? THEN 1 ELSE 0 END)
          AS actionable_count
        `,
        params: [scope.id],
      };
    case "trainer":
      return {
        sql: `
          SUM(CASE WHEN t.status = 'pending_train' AND t.trainer_id = ? THEN 1 ELSE 0 END)
          AS actionable_count
        `,
        params: [scope.id],
      };
  }
}

type TaskSummaryRow = RowDataPacket & {
  total: number;
  actionable_count: number | null;
  finished_count: number | null;
};

type ModelListRow = RowDataPacket & {
  task_id: number;
  task_title: string;
  model_file_name: string;
  trainer_remark: string | null;
  finished_at: Date | string;
  trainer_id: number;
  trainer_username: string;
};

type ModelSummaryRow = RowDataPacket & {
  total: number;
};

function buildModelListFilter(filters?: ModelListFilters): {
  whereClause: string;
  params: Array<number | string>;
} {
  const conditions = [
    "t.status = 'finished'",
    "t.model_file IS NOT NULL",
    "t.model_file_name IS NOT NULL",
  ];
  const params: Array<number | string> = [];

  if (filters?.keyword) {
    // 模型列表按任务名与模型文件名做模糊搜索，避免额外扩展不必要的查询范围。
    conditions.push("(t.title LIKE ? OR t.model_file_name LIKE ?)");
    params.push(`%${filters.keyword}%`, `%${filters.keyword}%`);
  }

  return {
    whereClause: `WHERE ${conditions.join(" AND ")}`,
    params,
  };
}

function mapModelListRow(row: ModelListRow): ModelListItem {
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

export async function listTasksForUser(
  scope: TaskListScope,
  input: {
    page: number;
    pageSize: number;
    keyword?: string;
    status?: TaskStatus;
  },
): Promise<PaginatedTasksResult> {
  const listFilter = buildTaskListFilter(scope, {
    keyword: input.keyword,
    status: input.status,
  });
  const actionableSummary = getActionableSummarySql(scope);
  const summaryRows = await query<TaskSummaryRow[]>(
    `
      SELECT
        COUNT(*) AS total,
        ${actionableSummary.sql},
        SUM(CASE WHEN t.status = 'finished' THEN 1 ELSE 0 END) AS finished_count
      FROM tasks t
      ${listFilter.whereClause}
    `,
    [...actionableSummary.params, ...listFilter.params],
  );
  const summaryRow = summaryRows[0];
  const summary: TaskListSummary = {
    total: Number(summaryRow?.total ?? 0),
    actionableCount: Number(summaryRow?.actionable_count ?? 0),
    finishedCount: Number(summaryRow?.finished_count ?? 0),
  };
  const totalPages = summary.total === 0 ? 0 : Math.ceil(summary.total / input.pageSize);
  const page = totalPages > 0 ? Math.min(input.page, totalPages) : input.page;
  const offset = (page - 1) * input.pageSize;
  const rows = await query<TaskQueryRow[]>(
    `
      ${getBaseTaskSelectSql()}
      ${listFilter.whereClause}
      ORDER BY
        t.created_at DESC,
        -- 创建时间可能精确到秒，使用主键倒序兜底，保证分页顺序稳定。
        t.id DESC
      LIMIT ? OFFSET ?
    `,
    [...listFilter.params, input.pageSize, offset],
  );

  return {
    items: rows.map(mapTaskRow),
    page,
    pageSize: input.pageSize,
    total: summary.total,
    summary,
  };
}

export async function listModels(input: {
  page: number;
  pageSize: number;
  keyword?: string;
}): Promise<PaginatedModelsResult> {
  const listFilter = buildModelListFilter({
    keyword: input.keyword,
  });
  const summaryRows = await query<ModelSummaryRow[]>(
    `
      SELECT COUNT(*) AS total
      FROM tasks t
      ${listFilter.whereClause}
    `,
    listFilter.params,
  );
  const total = Number(summaryRows[0]?.total ?? 0);
  const totalPages = total === 0 ? 0 : Math.ceil(total / input.pageSize);
  const page = totalPages > 0 ? Math.min(input.page, totalPages) : input.page;
  const offset = (page - 1) * input.pageSize;
  const rows = await query<ModelListRow[]>(
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
      ${listFilter.whereClause}
      ORDER BY t.finished_at DESC, t.id DESC
      LIMIT ? OFFSET ?
    `,
    [...listFilter.params, input.pageSize, offset],
  );

  return {
    items: rows.map(mapModelListRow),
    page,
    pageSize: input.pageSize,
    total,
  };
}

export async function findTaskById(taskId: number): Promise<TaskRow | null> {
  const rows = await query<TaskQueryRow[]>(
    `
      ${getBaseTaskSelectSql()}
      WHERE t.id = ?
      LIMIT 1
    `,
    [taskId],
  );

  const row = rows[0];
  return row ? mapTaskRow(row) : null;
}

export async function createTask(input: CreateTaskInput): Promise<number> {
  const result = await execute(
    `
      INSERT INTO tasks (
        title,
        description,
        status,
        creator_id,
        cleaner_id,
        annotator_id,
        trainer_id
      ) VALUES (?, ?, 'pending_clean', ?, ?, ?, ?)
    `,
    [
      input.title,
      input.description,
      input.creatorId,
      input.cleanerId,
      input.annotatorId,
      input.trainerId,
    ],
  );

  return result.insertId;
}

export async function deleteTaskById(taskId: number): Promise<void> {
  await execute("DELETE FROM tasks WHERE id = ?", [taskId]);
}

export async function attachSourceFile(
  taskId: number,
  storageKey: string,
  originalName: string,
): Promise<void> {
  await execute(
    `
      UPDATE tasks
      SET source_file = ?, source_file_name = ?
      WHERE id = ?
    `,
    [storageKey, originalName, taskId],
  );
}

export async function completeTaskStage(input: StageCompletionInput): Promise<boolean> {
  const finishedAtValue = input.nextStatus === "finished" ? new Date() : null;
  const result = await execute(
    `
      UPDATE tasks
      SET
        ${input.fileColumn} = ?,
        ${input.fileNameColumn} = ?,
        ${input.remarkColumn} = ?,
        status = ?,
        finished_at = ?
      WHERE id = ? AND status = ?
    `,
    [
      input.storageKey,
      input.originalName,
      input.remark,
      input.nextStatus,
      finishedAtValue,
      input.taskId,
      input.currentStatus,
    ],
  );

  return result.affectedRows > 0;
}
