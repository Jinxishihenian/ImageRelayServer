import type { ResultSetHeader, RowDataPacket } from "mysql2";
import type { PoolConnection } from "mysql2/promise";

import { execute, query } from "../database/mysql.js";
import type { DatasetStage } from "../types/domain.js";
import type {
  ModelIterationStatus,
  TaskReviewStage,
  TaskReviewStatus,
  TaskStatus,
  UserRole,
} from "../types/domain.js";
import { toIsoString } from "../common/date.js";
import { buildTaskActionPrioritySql, buildTaskVisibilitySql } from "./task-visibility.js";

export type TaskRow = {
  id: number;
  modelIterationId: number;
  modelIterationName: string;
  modelIterationStatus: ModelIterationStatus;
  datasetId: number | null;
  datasetName: string | null;
  rawDatasetVersionId: number | null;
  cleanedDatasetVersionId: number | null;
  annotatedDatasetVersionId: number | null;
  title: string;
  description: string;
  status: TaskStatus;
  needCleanReview: boolean;
  needAnnotateReview: boolean;
  needTrainReview: boolean;
  reviewStatus: TaskReviewStatus;
  reviewStage: TaskReviewStage | null;
  reviewComment: string | null;
  reviewedBy: number | null;
  reviewedAt: string | null;
  cleanedDraftFile: string | null;
  cleanedDraftFileName: string | null;
  cleanerDraftRemark: string | null;
  cleanedDraftSavedAt: string | null;
  cleanedDraftReady: boolean;
  annotatedDraftFile: string | null;
  annotatedDraftFileName: string | null;
  annotatorDraftRemark: string | null;
  annotatedDraftSavedAt: string | null;
  annotatedDraftReady: boolean;
  modelDraftFile: string | null;
  modelDraftFileName: string | null;
  trainerDraftRemark: string | null;
  modelDraftSavedAt: string | null;
  modelDraftReady: boolean;
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
  model_iteration_id: number;
  model_iteration_name: string;
  model_iteration_status: ModelIterationStatus;
  dataset_id: number | null;
  dataset_name: string | null;
  raw_dataset_version_id: number | null;
  cleaned_dataset_version_id: number | null;
  annotated_dataset_version_id: number | null;
  title: string;
  description: string;
  status: TaskStatus;
  need_clean_review: number;
  need_annotate_review: number;
  need_train_review: number;
  review_status: TaskReviewStatus;
  review_stage: TaskReviewStage | null;
  review_comment: string | null;
  reviewed_by: number | null;
  reviewed_at: Date | string | null;
  cleaned_draft_file: string | null;
  cleaned_draft_file_name: string | null;
  cleaner_draft_remark: string | null;
  cleaned_draft_saved_at: Date | string | null;
  cleaned_draft_ready: number;
  annotated_draft_file: string | null;
  annotated_draft_file_name: string | null;
  annotator_draft_remark: string | null;
  annotated_draft_saved_at: Date | string | null;
  annotated_draft_ready: number;
  model_draft_file: string | null;
  model_draft_file_name: string | null;
  trainer_draft_remark: string | null;
  model_draft_saved_at: Date | string | null;
  model_draft_ready: number;
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
  reviewStatus?: TaskReviewStatus;
};

type ModelListFilters = {
  keyword?: string;
  modelIterationId?: number;
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
  modelIteration: {
    id: number;
    name: string;
    status: ModelIterationStatus;
  };
  trainer: {
    id: number;
    username: string;
  };
};

export type TaskDatasetLinkUpdateInput = {
  taskId: number;
  datasetId: number;
  rawDatasetVersionId: number;
};

export type TaskGeneratedDatasetVersionInput = {
  taskId: number;
  stage: Exclude<DatasetStage, "raw">;
  datasetVersionId: number;
};

export type PaginatedModelsResult = {
  items: ModelListItem[];
  page: number;
  pageSize: number;
  total: number;
};

type CreateTaskInput = {
  modelIterationId: number;
  title: string;
  description: string;
  needCleanReview: boolean;
  needAnnotateReview: boolean;
  needTrainReview: boolean;
  creatorId: number;
  cleanerId: number;
  annotatorId: number;
  trainerId: number;
};

type Executor = {
  executeResult: (sql: string, params?: any[]) => Promise<ResultSetHeader>;
};

type StageCompletionInput = {
  taskId: number;
  requiresReview: boolean;
  reviewStage: TaskReviewStage;
  currentStatus: TaskStatus;
  nextStatus: TaskStatus;
  draftFileColumn: "cleaned_draft_file" | "annotated_draft_file" | "model_draft_file";
  draftFileNameColumn:
    | "cleaned_draft_file_name"
    | "annotated_draft_file_name"
    | "model_draft_file_name";
  draftRemarkColumn:
    | "cleaner_draft_remark"
    | "annotator_draft_remark"
    | "trainer_draft_remark";
  draftReadyColumn: "cleaned_draft_ready" | "annotated_draft_ready" | "model_draft_ready";
  fileColumn: "cleaned_file" | "annotated_file" | "model_file";
  fileNameColumn: "cleaned_file_name" | "annotated_file_name" | "model_file_name";
  remarkColumn: "cleaner_remark" | "annotator_remark" | "trainer_remark";
};

type StageDraftSaveInput = {
  taskId: number;
  currentStatus: TaskStatus;
  draftFileColumn: "cleaned_draft_file" | "annotated_draft_file" | "model_draft_file";
  draftFileNameColumn:
    | "cleaned_draft_file_name"
    | "annotated_draft_file_name"
    | "model_draft_file_name";
  draftRemarkColumn:
    | "cleaner_draft_remark"
    | "annotator_draft_remark"
    | "trainer_draft_remark";
  draftSavedAtColumn:
    | "cleaned_draft_saved_at"
    | "annotated_draft_saved_at"
    | "model_draft_saved_at";
  draftReadyColumn: "cleaned_draft_ready" | "annotated_draft_ready" | "model_draft_ready";
  storageKey: string;
  originalName: string;
  remark: string;
};

type ReviewApprovalInput = {
  taskId: number;
  currentStatus: TaskStatus;
  nextStatus: TaskStatus;
  reviewStage: TaskReviewStage;
  reviewerId: number;
};

type ReviewRejectionInput = {
  taskId: number;
  currentStatus: TaskStatus;
  reviewStage: TaskReviewStage;
  reviewerId: number;
  reviewComment: string;
};

function mapTaskRow(row: TaskQueryRow): TaskRow {
  return {
    id: row.id,
    modelIterationId: row.model_iteration_id,
    modelIterationName: row.model_iteration_name,
    modelIterationStatus: row.model_iteration_status,
    datasetId: row.dataset_id,
    datasetName: row.dataset_name,
    rawDatasetVersionId: row.raw_dataset_version_id,
    cleanedDatasetVersionId: row.cleaned_dataset_version_id,
    annotatedDatasetVersionId: row.annotated_dataset_version_id,
    title: row.title,
    description: row.description,
    status: row.status,
    needCleanReview: row.need_clean_review === 1,
    needAnnotateReview: row.need_annotate_review === 1,
    needTrainReview: row.need_train_review === 1,
    reviewStatus: row.review_status,
    reviewStage: row.review_stage,
    reviewComment: row.review_comment,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at ? toIsoString(row.reviewed_at) : null,
    cleanedDraftFile: row.cleaned_draft_file,
    cleanedDraftFileName: row.cleaned_draft_file_name,
    cleanerDraftRemark: row.cleaner_draft_remark,
    cleanedDraftSavedAt: row.cleaned_draft_saved_at ? toIsoString(row.cleaned_draft_saved_at) : null,
    cleanedDraftReady: row.cleaned_draft_ready === 1,
    annotatedDraftFile: row.annotated_draft_file,
    annotatedDraftFileName: row.annotated_draft_file_name,
    annotatorDraftRemark: row.annotator_draft_remark,
    annotatedDraftSavedAt: row.annotated_draft_saved_at ? toIsoString(row.annotated_draft_saved_at) : null,
    annotatedDraftReady: row.annotated_draft_ready === 1,
    modelDraftFile: row.model_draft_file,
    modelDraftFileName: row.model_draft_file_name,
    trainerDraftRemark: row.trainer_draft_remark,
    modelDraftSavedAt: row.model_draft_saved_at ? toIsoString(row.model_draft_saved_at) : null,
    modelDraftReady: row.model_draft_ready === 1,
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

function getExecutor(connection?: PoolConnection): Executor {
  if (connection) {
    return {
      executeResult: async (sql: string, params?: any[]) => {
        const [result] = await connection.execute<ResultSetHeader>(sql, params ?? []);
        return result;
      },
    };
  }

  return {
    executeResult: async (sql: string, params?: any[]) => execute(sql, params ?? []),
  } satisfies Executor;
}

function getBaseTaskSelectSql(): string {
  return `
    SELECT
      t.id,
      t.model_iteration_id,
      mi.name AS model_iteration_name,
      mi.status AS model_iteration_status,
      t.dataset_id,
      d.name AS dataset_name,
      t.raw_dataset_version_id,
      t.cleaned_dataset_version_id,
      t.annotated_dataset_version_id,
      t.title,
      t.description,
      t.status,
      t.need_clean_review,
      t.need_annotate_review,
      t.need_train_review,
      t.review_status,
      t.review_stage,
      t.review_comment,
      t.reviewed_by,
      t.reviewed_at,
      t.cleaned_draft_file,
      t.cleaned_draft_file_name,
      t.cleaner_draft_remark,
      t.cleaned_draft_saved_at,
      t.cleaned_draft_ready,
      t.annotated_draft_file,
      t.annotated_draft_file_name,
      t.annotator_draft_remark,
      t.annotated_draft_saved_at,
      t.annotated_draft_ready,
      t.model_draft_file,
      t.model_draft_file_name,
      t.trainer_draft_remark,
      t.model_draft_saved_at,
      t.model_draft_ready,
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
    INNER JOIN model_iterations mi ON mi.id = t.model_iteration_id
    LEFT JOIN datasets d ON d.id = t.dataset_id
    INNER JOIN users creator ON creator.id = t.creator_id
    INNER JOIN users cleaner ON cleaner.id = t.cleaner_id
    INNER JOIN users annotator ON annotator.id = t.annotator_id
    INNER JOIN users trainer ON trainer.id = t.trainer_id
  `;
}

function buildTaskListFilter(scope: TaskListScope, filters?: TaskListFilters): {
  whereClause: string;
  params: Array<number | string>;
} {
  const conditions: string[] = [];
  const params: Array<number | string> = [];
  const visibilitySql = buildTaskVisibilitySql(scope, "t");

  if (visibilitySql.condition) {
    conditions.push(visibilitySql.condition);
    params.push(...visibilitySql.params);
  }

  if (filters?.keyword) {
    conditions.push("t.title LIKE ?");
    params.push(`%${filters.keyword}%`);
  }

  if (filters?.status) {
    conditions.push("t.status = ?");
    params.push(filters.status);
  }

  if (filters?.reviewStatus) {
    conditions.push("t.review_status = ?");
    params.push(filters.reviewStatus);
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
        sql: `
          SUM(
            CASE
              WHEN t.review_status = 'pending_admin_review' THEN 1
              ELSE 0
            END
          ) AS actionable_count
        `,
        params: [],
      };
    case "cleaner":
      return {
        sql: `
          SUM(
            CASE
              WHEN t.status = 'pending_clean' AND t.cleaner_id = ? AND t.review_status <> 'pending_admin_review'
              THEN 1
              ELSE 0
            END
          )
          AS actionable_count
        `,
        params: [scope.id],
      };
    case "annotator":
      return {
        sql: `
          SUM(
            CASE
              WHEN t.status = 'pending_annotate' AND t.annotator_id = ? AND t.review_status <> 'pending_admin_review'
              THEN 1
              ELSE 0
            END
          )
          AS actionable_count
        `,
        params: [scope.id],
      };
    case "trainer":
      return {
        sql: `
          SUM(
            CASE
              WHEN t.status = 'pending_train' AND t.trainer_id = ? AND t.review_status <> 'pending_admin_review'
              THEN 1
              ELSE 0
            END
          )
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
  model_iteration_id: number;
  model_iteration_name: string;
  model_iteration_status: ModelIterationStatus;
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

  if (filters?.modelIterationId) {
    conditions.push("t.model_iteration_id = ?");
    params.push(filters.modelIterationId);
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
    modelIteration: {
      id: row.model_iteration_id,
      name: row.model_iteration_name,
      status: row.model_iteration_status,
    },
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
    reviewStatus?: TaskReviewStatus;
  },
): Promise<PaginatedTasksResult> {
  const listFilter = buildTaskListFilter(scope, {
    keyword: input.keyword,
    status: input.status,
    reviewStatus: input.reviewStatus,
  });
  const taskPriority = buildTaskActionPrioritySql(scope, "t");
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
        ${taskPriority.expression} ASC,
        t.created_at DESC,
        -- 创建时间可能精确到秒，使用主键倒序兜底，保证分页顺序稳定。
        t.id DESC
      LIMIT ? OFFSET ?
    `,
    [...taskPriority.params, ...listFilter.params, input.pageSize, offset],
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
  modelIterationId?: number;
}): Promise<PaginatedModelsResult> {
  const listFilter = buildModelListFilter({
    keyword: input.keyword,
    modelIterationId: input.modelIterationId,
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
        mi.id AS model_iteration_id,
        mi.name AS model_iteration_name,
        mi.status AS model_iteration_status,
        trainer.id AS trainer_id,
        trainer.username AS trainer_username
      FROM tasks t
      INNER JOIN model_iterations mi ON mi.id = t.model_iteration_id
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

export async function createTask(input: CreateTaskInput, connection?: PoolConnection): Promise<number> {
  const executor = getExecutor(connection);
  const result = await executor.executeResult(
    `
      INSERT INTO tasks (
        model_iteration_id,
        title,
        description,
        status,
        flow_mode,
        need_clean_review,
        need_annotate_review,
        need_train_review,
        creator_id,
        cleaner_id,
        annotator_id,
        trainer_id
      ) VALUES (?, ?, ?, 'pending_clean', 'auto', ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.modelIterationId,
      input.title,
      input.description,
      input.needCleanReview ? 1 : 0,
      input.needAnnotateReview ? 1 : 0,
      input.needTrainReview ? 1 : 0,
      input.creatorId,
      input.cleanerId,
      input.annotatorId,
      input.trainerId,
    ],
  );

  return result.insertId;
}

export async function deleteTaskById(taskId: number, connection?: PoolConnection): Promise<void> {
  const executor = getExecutor(connection);
  await executor.executeResult("DELETE FROM tasks WHERE id = ?", [taskId]);
}

export async function attachSourceFile(
  taskId: number,
  storageKey: string,
  originalName: string,
  connection?: PoolConnection,
): Promise<void> {
  const executor = getExecutor(connection);
  await executor.executeResult(
    `
      UPDATE tasks
      SET source_file = ?, source_file_name = ?
      WHERE id = ?
    `,
    [storageKey, originalName, taskId],
  );
}

export async function attachTaskDatasetLinks(
  input: TaskDatasetLinkUpdateInput,
  connection?: PoolConnection,
): Promise<void> {
  const executor = getExecutor(connection);
  await executor.executeResult(
    `
      UPDATE tasks
      SET dataset_id = ?, raw_dataset_version_id = ?
      WHERE id = ?
    `,
    [input.datasetId, input.rawDatasetVersionId, input.taskId],
  );
}

export async function attachGeneratedDatasetVersion(
  input: TaskGeneratedDatasetVersionInput,
  connection?: PoolConnection,
): Promise<void> {
  const column = input.stage === "cleaned" ? "cleaned_dataset_version_id" : "annotated_dataset_version_id";
  const executor = getExecutor(connection);

  await executor.executeResult(
    `
      UPDATE tasks
      SET ${column} = ?
      WHERE id = ?
    `,
    [input.datasetVersionId, input.taskId],
  );
}

export async function saveTaskStageDraft(input: StageDraftSaveInput): Promise<boolean> {
  const executor = getExecutor();
  const result = await executor.executeResult(
    `
      UPDATE tasks
      SET
        ${input.draftFileColumn} = ?,
        ${input.draftFileNameColumn} = ?,
        ${input.draftRemarkColumn} = ?,
        ${input.draftSavedAtColumn} = NOW(),
        ${input.draftReadyColumn} = 1
      WHERE id = ? AND status = ?
    `,
    [
      input.storageKey,
      input.originalName,
      input.remark,
      input.taskId,
      input.currentStatus,
    ],
  );

  return result.affectedRows > 0;
}

export async function completeTaskStage(input: StageCompletionInput): Promise<boolean> {
  const executor = getExecutor();
  const shouldAutoAdvance = !input.requiresReview;
  const finishedAtValue = shouldAutoAdvance && input.nextStatus === "finished" ? new Date() : null;
  const result = await executor.executeResult(
    `
      UPDATE tasks
      SET
        ${input.fileColumn} = ${input.draftFileColumn},
        ${input.fileNameColumn} = ${input.draftFileNameColumn},
        ${input.remarkColumn} = ${input.draftRemarkColumn},
        status = ?,
        review_status = ?,
        review_stage = ?,
        review_comment = NULL,
        reviewed_by = NULL,
        reviewed_at = NULL,
        finished_at = ?,
        ${input.draftReadyColumn} = 0
      WHERE id = ?
        AND status = ?
        AND ${input.draftReadyColumn} = 1
        AND ${input.draftFileColumn} IS NOT NULL
        AND ${input.draftFileNameColumn} IS NOT NULL
    `,
    [
      shouldAutoAdvance ? input.nextStatus : input.currentStatus,
      shouldAutoAdvance ? "none" : "pending_admin_review",
      shouldAutoAdvance ? null : input.reviewStage,
      finishedAtValue,
      input.taskId,
      input.currentStatus,
    ],
  );

  return result.affectedRows > 0;
}

export async function approveTaskReview(input: ReviewApprovalInput): Promise<boolean> {
  const executor = getExecutor();
  const finishedAtValue = input.nextStatus === "finished" ? new Date() : null;
  const result = await executor.executeResult(
    `
      UPDATE tasks
      SET
        status = ?,
        review_status = 'none',
        review_stage = NULL,
        review_comment = NULL,
        reviewed_by = ?,
        reviewed_at = NOW(),
        finished_at = ?
      WHERE
        id = ?
        AND status = ?
        AND review_status = 'pending_admin_review'
        AND review_stage = ?
    `,
    [
      input.nextStatus,
      input.reviewerId,
      finishedAtValue,
      input.taskId,
      input.currentStatus,
      input.reviewStage,
    ],
  );

  return result.affectedRows > 0;
}

export async function rejectTaskReview(input: ReviewRejectionInput): Promise<boolean> {
  const executor = getExecutor();
  const result = await executor.executeResult(
    `
      UPDATE tasks
      SET
        review_status = 'rejected',
        review_stage = ?,
        review_comment = ?,
        reviewed_by = ?,
        reviewed_at = NOW()
      WHERE
        id = ?
        AND status = ?
        AND review_status = 'pending_admin_review'
        AND review_stage = ?
    `,
    [
      input.reviewStage,
      input.reviewComment,
      input.reviewerId,
      input.taskId,
      input.currentStatus,
      input.reviewStage,
    ],
  );

  return result.affectedRows > 0;
}
