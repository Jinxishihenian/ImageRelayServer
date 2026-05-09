import type { PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";

import { DATASET_STAGE_LABELS } from "../common/role-status.js";
import { toIsoString } from "../common/date.js";
import { execute, query } from "../database/mysql.js";
import type { DatasetStage } from "../types/domain.js";

type Executor = {
  executeResult: (sql: string, params?: any[]) => Promise<ResultSetHeader>;
  queryRows: <T>(sql: string, params?: any[]) => Promise<T>;
};

export type DatasetVersionRow = {
  id: number;
  datasetId: number;
  versionNo: number;
  stage: DatasetStage;
  stageLabel: string;
  parentVersionId: number | null;
  parentVersionNo: number | null;
  sourceTaskId: number;
  storageKey: string;
  fileName: string;
  reviewBased: boolean;
  createdBy: {
    id: number;
    username: string;
  };
  createdAt: string;
};

export type DatasetSummaryRow = {
  id: number;
  taskId: number;
  projectId: number | null;
  projectName: string | null;
  name: string;
  description: string;
  modality: string;
  taskType: string;
  creator: {
    id: number;
    username: string;
  };
  currentVersionId: number | null;
  currentVersionLabel: string | null;
  currentVersionNo: number | null;
  currentVersionStage: DatasetStage | null;
  currentVersionStageLabel: string | null;
  versionCount: number;
  createdAt: string;
  updatedAt: string;
};

export type DatasetDetailRow = DatasetSummaryRow & {
  taskTitle: string;
  versions: DatasetVersionRow[];
};

export type DatasetVersionDownloadRow = {
  id: number;
  datasetId: number;
  storageKey: string;
  fileName: string;
};

type DatasetListQueryRow = RowDataPacket & {
  id: number;
  task_id: number;
  model_iteration_id: number | null;
  model_iteration_name: string | null;
  name: string;
  description: string;
  modality: string;
  task_type: string;
  creator_id: number;
  creator_username: string;
  current_version_id: number | null;
  current_version_no: number | null;
  current_version_stage: DatasetStage | null;
  version_count: number;
  created_at: Date | string;
  updated_at: Date | string;
};

type DatasetDetailQueryRow = DatasetListQueryRow & {
  task_title: string;
};

type DatasetVersionQueryRow = RowDataPacket & {
  id: number;
  dataset_id: number;
  version_no: number;
  stage: DatasetStage;
  parent_version_id: number | null;
  parent_version_no: number | null;
  source_task_id: number;
  storage_key: string;
  file_name: string;
  review_based: number;
  created_by: number;
  created_by_username: string;
  created_at: Date | string;
};

type CountRow = RowDataPacket & {
  total: number;
};

function getExecutor(connection?: PoolConnection): Executor {
  if (connection) {
    return {
      executeResult: async (sql: string, params?: any[]) => {
        const [result] = await connection.execute<ResultSetHeader>(sql, params ?? []);
        return result;
      },
      queryRows: async <T>(sql: string, params?: any[]) => {
        const [rows] = await connection.query(sql, params ?? []);
        return rows as T;
      },
    };
  }

  return {
    executeResult: async (sql: string, params?: any[]) => execute(sql, params ?? []),
    queryRows: async <T>(sql: string, params?: any[]) => query<T>(sql, params ?? []),
  } satisfies Executor;
}

function mapDatasetVersionRow(row: DatasetVersionQueryRow): DatasetVersionRow {
  return {
    id: row.id,
    datasetId: row.dataset_id,
    versionNo: row.version_no,
    stage: row.stage,
    stageLabel: DATASET_STAGE_LABELS[row.stage],
    parentVersionId: row.parent_version_id,
    parentVersionNo: row.parent_version_no,
    sourceTaskId: row.source_task_id,
    storageKey: row.storage_key,
    fileName: row.file_name,
    reviewBased: row.review_based === 1,
    createdBy: {
      id: row.created_by,
      username: row.created_by_username,
    },
    createdAt: toIsoString(row.created_at),
  };
}

function buildVersionLabel(versionNo: number | null, stage: DatasetStage | null): string | null {
  if (!versionNo || !stage) {
    return null;
  }

  return `v${versionNo}_${stage}`;
}

function buildVersionNoLabel(versionNo: number | null): string | null {
  if (!versionNo) {
    return null;
  }

  return `v${versionNo}`;
}

function mapDatasetSummaryRow(row: DatasetListQueryRow): DatasetSummaryRow {
  const currentVersionLabel = buildVersionLabel(row.current_version_no, row.current_version_stage);

  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.model_iteration_id,
    projectName: row.model_iteration_name,
    name: row.name,
    description: row.description,
    modality: row.modality,
    taskType: row.task_type,
    creator: {
      id: row.creator_id,
      username: row.creator_username,
    },
    currentVersionId: row.current_version_id,
    currentVersionLabel,
    currentVersionNo: row.current_version_no,
    currentVersionStage: row.current_version_stage,
    currentVersionStageLabel: row.current_version_stage
      ? DATASET_STAGE_LABELS[row.current_version_stage]
      : null,
    versionCount: Number(row.version_count ?? 0),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

function buildDatasetFilter(keyword?: string): {
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
    whereClause: "WHERE d.name LIKE ?",
    params: [`%${keyword}%`],
  };
}

export async function createDataset(input: {
  taskId: number;
  name: string;
  description: string;
  modality: string;
  taskType: string;
  creatorId: number;
}, connection?: PoolConnection): Promise<number> {
  const executor = getExecutor(connection);
  const result = await executor.executeResult(
    `
      INSERT INTO datasets (
        task_id,
        name,
        description,
        modality,
        task_type,
        creator_id,
        current_version_id
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
    `,
    [
      input.taskId,
      input.name,
      input.description,
      input.modality,
      input.taskType,
      input.creatorId,
    ],
  );

  return result.insertId;
}

export async function createDatasetVersion(input: {
  datasetId: number;
  versionNo: number;
  stage: DatasetStage;
  parentVersionId: number | null;
  sourceTaskId: number;
  storageKey: string;
  fileName: string;
  reviewBased: boolean;
  createdBy: number;
}, connection?: PoolConnection): Promise<number> {
  const executor = getExecutor(connection);
  const result = await executor.executeResult(
    `
      INSERT INTO dataset_versions (
        dataset_id,
        version_no,
        stage,
        parent_version_id,
        source_task_id,
        storage_key,
        file_name,
        review_based,
        created_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      input.datasetId,
      input.versionNo,
      input.stage,
      input.parentVersionId,
      input.sourceTaskId,
      input.storageKey,
      input.fileName,
      input.reviewBased ? 1 : 0,
      input.createdBy,
    ],
  );

  return result.insertId;
}

export async function updateDatasetCurrentVersion(
  datasetId: number,
  versionId: number,
  connection?: PoolConnection,
): Promise<void> {
  const executor = getExecutor(connection);
  await executor.executeResult(
    `
      UPDATE datasets
      SET current_version_id = ?, updated_at = NOW()
      WHERE id = ?
    `,
    [versionId, datasetId],
  );
}

export async function listDatasets(input: {
  page: number;
  pageSize: number;
  keyword?: string;
}): Promise<{
  items: DatasetSummaryRow[];
  page: number;
  pageSize: number;
  total: number;
}> {
  const filter = buildDatasetFilter(input.keyword);
  const summaryRows = await query<CountRow[]>(
    `
      SELECT COUNT(*) AS total
      FROM datasets d
      ${filter.whereClause}
    `,
    filter.params,
  );
  const total = Number(summaryRows[0]?.total ?? 0);
  const totalPages = total === 0 ? 0 : Math.ceil(total / input.pageSize);
  const page = totalPages > 0 ? Math.min(input.page, totalPages) : input.page;
  const offset = (page - 1) * input.pageSize;
  const rows = await query<DatasetListQueryRow[]>(
    `
      SELECT
        d.id,
        d.task_id,
        t.model_iteration_id,
        mi.name AS model_iteration_name,
        d.name,
        d.description,
        d.modality,
        d.task_type,
        d.creator_id,
        creator.username AS creator_username,
        d.current_version_id,
        current_version.version_no AS current_version_no,
        current_version.stage AS current_version_stage,
        COUNT(dv.id) AS version_count,
        d.created_at,
        d.updated_at
      FROM datasets d
      INNER JOIN tasks t ON t.id = d.task_id
      LEFT JOIN model_iterations mi ON mi.id = t.model_iteration_id
      INNER JOIN users creator ON creator.id = d.creator_id
      LEFT JOIN dataset_versions current_version ON current_version.id = d.current_version_id
      LEFT JOIN dataset_versions dv ON dv.dataset_id = d.id
      ${filter.whereClause}
      GROUP BY d.id
      ORDER BY d.created_at DESC, d.id DESC
      LIMIT ? OFFSET ?
    `,
    [...filter.params, input.pageSize, offset],
  );

  return {
    items: rows.map(mapDatasetSummaryRow),
    page,
    pageSize: input.pageSize,
    total,
  };
}

export async function findDatasetById(datasetId: number): Promise<DatasetDetailRow | null> {
  const rows = await query<DatasetDetailQueryRow[]>(
    `
      SELECT
        d.id,
        d.task_id,
        t.model_iteration_id,
        mi.name AS model_iteration_name,
        t.title AS task_title,
        d.name,
        d.description,
        d.modality,
        d.task_type,
        d.creator_id,
        creator.username AS creator_username,
        d.current_version_id,
        current_version.version_no AS current_version_no,
        current_version.stage AS current_version_stage,
        version_counter.version_count,
        d.created_at,
        d.updated_at
      FROM datasets d
      INNER JOIN tasks t ON t.id = d.task_id
      LEFT JOIN model_iterations mi ON mi.id = t.model_iteration_id
      INNER JOIN users creator ON creator.id = d.creator_id
      LEFT JOIN dataset_versions current_version ON current_version.id = d.current_version_id
      LEFT JOIN (
        SELECT dataset_id, COUNT(*) AS version_count
        FROM dataset_versions
        GROUP BY dataset_id
      ) version_counter ON version_counter.dataset_id = d.id
      WHERE d.id = ?
      LIMIT 1
    `,
    [datasetId],
  );

  const row = rows[0];

  if (!row) {
    return null;
  }

  const versions = await query<DatasetVersionQueryRow[]>(
    `
      SELECT
        dv.id,
        dv.dataset_id,
        dv.version_no,
        dv.stage,
        dv.parent_version_id,
        parent.version_no AS parent_version_no,
        dv.source_task_id,
        dv.storage_key,
        dv.file_name,
        dv.review_based,
        dv.created_by,
        creator.username AS created_by_username,
        dv.created_at
      FROM dataset_versions dv
      LEFT JOIN dataset_versions parent ON parent.id = dv.parent_version_id
      INNER JOIN users creator ON creator.id = dv.created_by
      WHERE dv.dataset_id = ?
      ORDER BY dv.created_at DESC, dv.id DESC
    `,
    [datasetId],
  );

  const mappedSummary = mapDatasetSummaryRow(row);
  const latestVersion = versions[0] ? mapDatasetVersionRow(versions[0]) : null;

  return {
    ...mappedSummary,
    currentVersionId: mappedSummary.currentVersionId ?? latestVersion?.id ?? null,
    currentVersionLabel:
      mappedSummary.currentVersionLabel ?? buildVersionNoLabel(latestVersion?.versionNo ?? null),
    currentVersionNo: mappedSummary.currentVersionNo ?? latestVersion?.versionNo ?? null,
    currentVersionStage: mappedSummary.currentVersionStage ?? latestVersion?.stage ?? null,
    currentVersionStageLabel:
      mappedSummary.currentVersionStageLabel ?? latestVersion?.stageLabel ?? null,
    taskTitle: row.task_title,
    versions: versions.map(mapDatasetVersionRow),
  };
}

export async function findDatasetVersionsByTaskId(taskId: number): Promise<DatasetVersionRow[]> {
  const rows = await query<DatasetVersionQueryRow[]>(
    `
      SELECT
        dv.id,
        dv.dataset_id,
        dv.version_no,
        dv.stage,
        dv.parent_version_id,
        parent.version_no AS parent_version_no,
        dv.source_task_id,
        dv.storage_key,
        dv.file_name,
        dv.review_based,
        dv.created_by,
        creator.username AS created_by_username,
        dv.created_at
      FROM dataset_versions dv
      INNER JOIN datasets d ON d.id = dv.dataset_id
      LEFT JOIN dataset_versions parent ON parent.id = dv.parent_version_id
      INNER JOIN users creator ON creator.id = dv.created_by
      WHERE d.task_id = ?
      ORDER BY dv.version_no ASC, dv.id ASC
    `,
    [taskId],
  );

  return rows.map(mapDatasetVersionRow);
}

export async function findDatasetVersionForDownload(
  datasetId: number,
  versionId: number,
): Promise<DatasetVersionDownloadRow | null> {
  const rows = await query<DatasetVersionQueryRow[]>(
    `
      SELECT
        dv.id,
        dv.dataset_id,
        dv.version_no,
        dv.stage,
        dv.parent_version_id,
        parent.version_no AS parent_version_no,
        dv.source_task_id,
        dv.storage_key,
        dv.file_name,
        dv.review_based,
        dv.created_by,
        creator.username AS created_by_username,
        dv.created_at
      FROM dataset_versions dv
      LEFT JOIN dataset_versions parent ON parent.id = dv.parent_version_id
      INNER JOIN users creator ON creator.id = dv.created_by
      WHERE dv.dataset_id = ? AND dv.id = ?
      LIMIT 1
    `,
    [datasetId, versionId],
  );

  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    datasetId: row.dataset_id,
    storageKey: row.storage_key,
    fileName: row.file_name,
  };
}

export async function listDatasetsByModelIteration(
  modelIterationId: number,
): Promise<DatasetSummaryRow[]> {
  const rows = await query<DatasetListQueryRow[]>(
    `
      SELECT
        d.id,
        d.task_id,
        t.model_iteration_id,
        mi.name AS model_iteration_name,
        d.name,
        d.description,
        d.modality,
        d.task_type,
        d.creator_id,
        creator.username AS creator_username,
        d.current_version_id,
        current_version.version_no AS current_version_no,
        current_version.stage AS current_version_stage,
        COUNT(dv.id) AS version_count,
        d.created_at,
        d.updated_at
      FROM datasets d
      INNER JOIN tasks t ON t.id = d.task_id
      INNER JOIN model_iterations mi ON mi.id = t.model_iteration_id
      INNER JOIN users creator ON creator.id = d.creator_id
      LEFT JOIN dataset_versions current_version ON current_version.id = d.current_version_id
      LEFT JOIN dataset_versions dv ON dv.dataset_id = d.id
      WHERE t.model_iteration_id = ?
      GROUP BY d.id
      ORDER BY d.created_at DESC, d.id DESC
    `,
    [modelIterationId],
  );

  return rows.map(mapDatasetSummaryRow);
}
