import path from "node:path";

import dotenv from "dotenv";

dotenv.config();

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 3000;
const DEFAULT_DB_HOST = "127.0.0.1";
const DEFAULT_DB_PORT = 3306;
const DEFAULT_DB_USER = "root";
const DEFAULT_DB_NAME = "wss_image_relay";
const DEFAULT_AUTH_TOKEN_SECRET = "image-relay-dev-secret";
const DEFAULT_DOWNLOAD_LINK_SECRET = "image-relay-download-link-secret";
// 上传接口按 MiB 读取环境变量，这里改成 10 GiB，避免生产环境未显式配置时仍落回 50 MiB。
const DEFAULT_MAX_UPLOAD_SIZE_MB = 10 * 1024;
const VALID_NODE_ENVS = new Set(["development", "test", "production"]);
const DOWNLOAD_LINK_TTL_MS = 60 * 60 * 1000;

export type AppEnv = {
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  corsOrigins: string[];
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
  authTokenSecret: string;
  downloadLinkSecret: string;
  downloadLinkTtlMs: number;
  fileStorageDir: string;
  fileBaseUrl: string;
  maxUploadSizeBytes: number;
};

function parsePort(
  rawPort: string | undefined,
  envName: string,
  defaultPort: number,
): number {
  if (!rawPort) {
    return defaultPort;
  }

  const parsedPort = Number(rawPort);

  if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
    throw new Error(`环境变量 ${envName} 必须是 1 到 65535 之间的整数。`);
  }

  return parsedPort;
}

function parseNodeEnv(rawNodeEnv: string | undefined): AppEnv["nodeEnv"] {
  const nodeEnv = rawNodeEnv ?? "development";

  if (!VALID_NODE_ENVS.has(nodeEnv)) {
    throw new Error("环境变量 NODE_ENV 只能是 development、test 或 production。");
  }

  return nodeEnv as AppEnv["nodeEnv"];
}

function parseCorsOrigins(rawCorsOrigins: string | undefined): string[] {
  if (!rawCorsOrigins) {
    return [];
  }

  return rawCorsOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function parseRequiredString(
  rawValue: string | undefined,
  envName: string,
  defaultValue?: string,
): string {
  const value = rawValue?.trim() || defaultValue;

  if (!value) {
    throw new Error(`环境变量 ${envName} 不能为空。`);
  }

  return value;
}

function parseRequiredPassword(rawValue: string | undefined): string {
  // 密码不做 trim，避免把真实密码中的首尾空格误吞掉。
  if (!rawValue) {
    throw new Error("环境变量 DB_PASSWORD 不能为空。");
  }

  return rawValue;
}

function parseOptionalString(rawValue: string | undefined, defaultValue = ""): string {
  return rawValue?.trim() || defaultValue;
}

function parseFileStorageDir(rawValue: string | undefined): string {
  const configuredDir = rawValue?.trim();

  if (configuredDir) {
    return path.resolve(configuredDir);
  }

  // 默认落在仓库根目录的 data/files，便于本地直接查看和备份。
  return path.resolve(process.cwd(), "..", "data", "files");
}

function parseMaxUploadSizeBytes(rawValue: string | undefined): number {
  const sizeMb = parsePort(rawValue, "MAX_UPLOAD_SIZE_MB", DEFAULT_MAX_UPLOAD_SIZE_MB);
  return sizeMb * 1024 * 1024;
}

export function loadEnv(): AppEnv {
  return {
    nodeEnv: parseNodeEnv(process.env.NODE_ENV),
    host: parseRequiredString(process.env.HOST, "HOST", DEFAULT_HOST),
    port: parsePort(process.env.PORT, "PORT", DEFAULT_PORT),
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
    dbHost: parseRequiredString(process.env.DB_HOST, "DB_HOST", DEFAULT_DB_HOST),
    dbPort: parsePort(process.env.DB_PORT, "DB_PORT", DEFAULT_DB_PORT),
    dbUser: parseRequiredString(process.env.DB_USER, "DB_USER", DEFAULT_DB_USER),
    dbPassword: parseRequiredPassword(process.env.DB_PASSWORD),
    dbName: parseRequiredString(process.env.DB_NAME, "DB_NAME", DEFAULT_DB_NAME),
    authTokenSecret: parseRequiredString(
      process.env.AUTH_TOKEN_SECRET,
      "AUTH_TOKEN_SECRET",
      DEFAULT_AUTH_TOKEN_SECRET,
    ),
    downloadLinkSecret: parseRequiredString(
      process.env.DOWNLOAD_LINK_SECRET,
      "DOWNLOAD_LINK_SECRET",
      DEFAULT_DOWNLOAD_LINK_SECRET,
    ),
    downloadLinkTtlMs: DOWNLOAD_LINK_TTL_MS,
    fileStorageDir: parseFileStorageDir(process.env.FILE_STORAGE_DIR),
    fileBaseUrl: parseOptionalString(process.env.FILE_BASE_URL),
    maxUploadSizeBytes: parseMaxUploadSizeBytes(process.env.MAX_UPLOAD_SIZE_MB),
  };
}
