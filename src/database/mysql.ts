import mysql, { type Pool, type ResultSetHeader } from "mysql2/promise";

import type { AppEnv } from "../config/env.js";
import { AppError } from "../utils/app-error.js";

export type DatabaseHealthStatus = {
  status: "up" | "down";
  message?: string;
};

let pool: Pool | null = null;
let lastDatabaseError: string | null = null;

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
    lastDatabaseError = null;
  } catch (error) {
    lastDatabaseError = getErrorMessage(error);

    const currentPool = pool;
    pool = null;

    await currentPool.end().catch(() => undefined);

    throw new Error(`数据库连接失败: ${lastDatabaseError}`);
  }
}

export function getDatabasePool(): Pool {
  return ensurePool();
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
