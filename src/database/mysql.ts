import { type RowDataPacket } from "mysql2";
import mysql, {
  type Pool,
  type PoolConnection,
  type ResultSetHeader,
} from "mysql2/promise";

import type { AppEnv } from "../config/env.js";
import { AppError } from "../utils/app-error.js";

export type DatabaseHealthStatus = {
  status: "up" | "down";
  message?: string;
};

let pool: Pool | null = null;
let lastDatabaseError: string | null = null;

type ColumnSchemaRow = RowDataPacket & {
  COLUMN_NAME: string;
};

const REQUIRED_TASK_COLUMNS = [
  "model_iteration_id",
  "dataset_id",
  "raw_dataset_version_id",
  "cleaned_dataset_version_id",
  "annotated_dataset_version_id",
  "flow_mode",
  "need_clean_review",
  "need_annotate_review",
  "need_train_review",
  "review_status",
  "review_stage",
  "review_comment",
  "reviewed_by",
  "reviewed_at",
  "cleaned_draft_file",
  "cleaned_draft_file_name",
  "cleaner_draft_remark",
  "cleaned_draft_saved_at",
  "cleaned_draft_ready",
  "annotated_draft_file",
  "annotated_draft_file_name",
  "annotator_draft_remark",
  "annotated_draft_saved_at",
  "annotated_draft_ready",
  "model_draft_file",
  "model_draft_file_name",
  "trainer_draft_remark",
  "model_draft_saved_at",
  "model_draft_ready",
] as const;

const REQUIRED_MODEL_ITERATION_COLUMNS = [
  "name",
  "description",
  "base_model_name",
  "goal",
  "status",
  "creator_id",
  "current_best_task_id",
  "latest_task_id",
  "created_at",
  "updated_at",
] as const;

const REQUIRED_DATASET_COLUMNS = [
  "task_id",
  "name",
  "description",
  "modality",
  "task_type",
  "creator_id",
  "current_version_id",
  "created_at",
  "updated_at",
] as const;

const REQUIRED_DATASET_VERSION_COLUMNS = [
  "dataset_id",
  "version_no",
  "stage",
  "parent_version_id",
  "source_task_id",
  "storage_key",
  "file_name",
  "review_based",
  "created_by",
  "created_at",
] as const;

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "未知数据库错误";
}

function ensurePool(): Pool {
  if (!pool) {
    throw new AppError("数据库连接池尚未初始化。", {
      statusCode: 500,
      code: "DATABASE_NOT_INITIALIZED",
      expose: false,
    });
  }

  return pool;
}

export async function initializeDatabase(env: AppEnv): Promise<void> {
  if (pool) {
    return;
  }

  pool = mysql.createPool({
    host: env.dbHost,
    port: env.dbPort,
    user: env.dbUser,
    password: env.dbPassword,
    database: env.dbName,
    charset: "utf8mb4",
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
  });

  try {
    // 启动阶段先做一次轻量查询，避免服务端口先起来、数据库却不可用。
    await pool.query("SELECT 1");
    await validateTaskSchema(pool, env.dbName);
    await validateModelIterationSchema(pool, env.dbName);
    await validateDatasetSchema(pool, env.dbName);
    await validateDatasetVersionSchema(pool, env.dbName);
    lastDatabaseError = null;
  } catch (error) {
    lastDatabaseError = getErrorMessage(error);

    const currentPool = pool;
    pool = null;

    await currentPool.end().catch(() => undefined);

    throw new Error(`数据库连接失败: ${lastDatabaseError}`);
  }
}

async function validateTaskSchema(currentPool: Pool, databaseName: string): Promise<void> {
  const [rows] = await currentPool.query<ColumnSchemaRow[]>(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tasks'
    `,
    [databaseName],
  );

  const existingColumns = new Set(rows.map((row) => row.COLUMN_NAME));
  const missingColumns = REQUIRED_TASK_COLUMNS.filter((columnName) => !existingColumns.has(columnName));

  if (missingColumns.length === 0) {
    return;
  }

  // 启动阶段就明确指出缺失列，避免服务看似启动成功、实际接口运行时才在 SQL 里报 500。
  throw new Error(
    `数据库表 tasks 缺少字段: ${missingColumns.join(", ")}。请先执行 pnpm db:upgrade-task-schema 补齐表结构。`,
  );
}

async function validateModelIterationSchema(currentPool: Pool, databaseName: string): Promise<void> {
  const [rows] = await currentPool.query<ColumnSchemaRow[]>(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'model_iterations'
    `,
    [databaseName],
  );

  const existingColumns = new Set(rows.map((row) => row.COLUMN_NAME));
  const missingColumns = REQUIRED_MODEL_ITERATION_COLUMNS.filter(
    (columnName) => !existingColumns.has(columnName),
  );

  if (missingColumns.length === 0) {
    return;
  }

  throw new Error(
    `数据库表 model_iterations 缺少字段: ${missingColumns.join(", ")}。请先执行最新 SQL 脚本补齐表结构。`,
  );
}

async function validateDatasetSchema(currentPool: Pool, databaseName: string): Promise<void> {
  const [rows] = await currentPool.query<ColumnSchemaRow[]>(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'datasets'
    `,
    [databaseName],
  );

  const existingColumns = new Set(rows.map((row) => row.COLUMN_NAME));
  const missingColumns = REQUIRED_DATASET_COLUMNS.filter(
    (columnName) => !existingColumns.has(columnName),
  );

  if (missingColumns.length === 0) {
    return;
  }

  throw new Error(
    `数据库表 datasets 缺少字段: ${missingColumns.join(", ")}。请先执行最新 SQL 脚本补齐表结构。`,
  );
}

async function validateDatasetVersionSchema(currentPool: Pool, databaseName: string): Promise<void> {
  const [rows] = await currentPool.query<ColumnSchemaRow[]>(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'dataset_versions'
    `,
    [databaseName],
  );

  const existingColumns = new Set(rows.map((row) => row.COLUMN_NAME));
  const missingColumns = REQUIRED_DATASET_VERSION_COLUMNS.filter(
    (columnName) => !existingColumns.has(columnName),
  );

  if (missingColumns.length === 0) {
    return;
  }

  throw new Error(
    `数据库表 dataset_versions 缺少字段: ${missingColumns.join(", ")}。请先执行最新 SQL 脚本补齐表结构。`,
  );
}

export function getDatabasePool(): Pool {
  return ensurePool();
}

export async function withTransaction<T>(
  handler: (connection: PoolConnection) => Promise<T>,
): Promise<T> {
  const connection = await ensurePool().getConnection();

  try {
    await connection.beginTransaction();
    const result = await handler(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}

export async function query<T>(sql: string, params: any[] = []): Promise<T> {
  const [rows] = await ensurePool().query(sql, params);
  return rows as T;
}

export async function execute(sql: string, params: any[] = []): Promise<ResultSetHeader> {
  const [result] = await ensurePool().execute<ResultSetHeader>(sql, params);
  return result;
}

export async function getDatabaseHealthStatus(): Promise<DatabaseHealthStatus> {
  if (!pool) {
    return {
      status: "down",
      message: lastDatabaseError ?? "数据库连接池尚未初始化。",
    };
  }

  try {
    await pool.query("SELECT 1");
    lastDatabaseError = null;

    return {
      status: "up",
    };
  } catch (error) {
    lastDatabaseError = getErrorMessage(error);

    return {
      status: "down",
      message: lastDatabaseError,
    };
  }
}

export async function closeDatabase(): Promise<void> {
  if (!pool) {
    return;
  }

  const currentPool = pool;
  pool = null;

  await currentPool.end();
}
