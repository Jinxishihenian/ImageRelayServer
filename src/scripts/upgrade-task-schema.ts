import dotenv from "dotenv";
import { type RowDataPacket } from "mysql2";
import mysql from "mysql2/promise";

dotenv.config();

type DbConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
};

type ColumnRow = RowDataPacket & {
  COLUMN_NAME: string;
};

type IndexRow = RowDataPacket & {
  INDEX_NAME: string;
};

type TableRow = RowDataPacket & {
  TABLE_NAME: string;
};

type ForeignKeyRow = RowDataPacket & {
  CONSTRAINT_NAME: string;
};

function getRequiredEnv(name: string, fallback?: string): string {
  const value = process.env[name]?.trim() || fallback;

  if (!value) {
    throw new Error(`环境变量 ${name} 不能为空。`);
  }

  return value;
}

function getDbConfig(): DbConfig {
  const rawPort = process.env.DB_PORT?.trim() || "3306";
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("环境变量 DB_PORT 必须是 1 到 65535 之间的整数。");
  }

  return {
    host: getRequiredEnv("DB_HOST", "127.0.0.1"),
    port,
    user: getRequiredEnv("DB_USER", "root"),
    // 密码不做 trim，避免真实密码首尾空格被误伤。
    password: process.env.DB_PASSWORD ?? "",
    database: getRequiredEnv("DB_NAME", "wss_image_relay"),
  };
}

async function getExistingColumns(
  connection: mysql.Connection,
  databaseName: string,
): Promise<Set<string>> {
  const [rows] = await connection.query<ColumnRow[]>(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tasks'
    `,
    [databaseName],
  );

  return new Set(rows.map((row) => row.COLUMN_NAME));
}

async function getExistingIndexes(
  connection: mysql.Connection,
  databaseName: string,
): Promise<Set<string>> {
  const [rows] = await connection.query<IndexRow[]>(
    `
      SELECT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tasks'
    `,
    [databaseName],
  );

  return new Set(rows.map((row) => row.INDEX_NAME));
}

async function getExistingForeignKeys(
  connection: mysql.Connection,
  databaseName: string,
): Promise<Set<string>> {
  const [rows] = await connection.query<ForeignKeyRow[]>(
    `
      SELECT CONSTRAINT_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tasks' AND CONSTRAINT_TYPE = 'FOREIGN KEY'
    `,
    [databaseName],
  );

  return new Set(rows.map((row) => row.CONSTRAINT_NAME));
}

async function ensureTasksTableExists(connection: mysql.Connection, databaseName: string): Promise<void> {
  const [rows] = await connection.query<TableRow[]>(
    `
      SELECT TABLE_NAME
      FROM INFORMATION_SCHEMA.TABLES
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tasks'
      LIMIT 1
    `,
    [databaseName],
  );

  if (rows.length === 0) {
    throw new Error(`数据库 ${databaseName} 中不存在 tasks 表，无法执行增量补齐。`);
  }
}

async function main(): Promise<void> {
  const config = getDbConfig();

  console.log(`连接数据库 ${config.host}:${config.port}/${config.database}`);

  const connection = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    charset: "utf8mb4",
  });

  try {
    await ensureTasksTableExists(connection, config.database);

    const existingColumns = await getExistingColumns(connection, config.database);
    const existingIndexes = await getExistingIndexes(connection, config.database);
    const existingForeignKeys = await getExistingForeignKeys(connection, config.database);
    const alterClauses: string[] = [];

    if (!existingColumns.has("flow_mode")) {
      console.log("检测到缺少列: tasks.flow_mode");
      alterClauses.push("ADD COLUMN `flow_mode` ENUM('auto', 'manual') NOT NULL DEFAULT 'auto' AFTER `status`");
    }

    if (!existingColumns.has("need_clean_review")) {
      console.log("检测到缺少列: tasks.need_clean_review");
      alterClauses.push("ADD COLUMN `need_clean_review` TINYINT(1) NOT NULL DEFAULT 0 AFTER `flow_mode`");
    }

    if (!existingColumns.has("need_annotate_review")) {
      console.log("检测到缺少列: tasks.need_annotate_review");
      alterClauses.push(
        "ADD COLUMN `need_annotate_review` TINYINT(1) NOT NULL DEFAULT 0 AFTER `need_clean_review`",
      );
    }

    if (!existingColumns.has("need_train_review")) {
      console.log("检测到缺少列: tasks.need_train_review");
      alterClauses.push(
        "ADD COLUMN `need_train_review` TINYINT(1) NOT NULL DEFAULT 0 AFTER `need_annotate_review`",
      );
    }

    if (!existingColumns.has("review_status")) {
      console.log("检测到缺少列: tasks.review_status");
      alterClauses.push(
        "ADD COLUMN `review_status` ENUM('none', 'pending_admin_review', 'rejected') NOT NULL DEFAULT 'none' AFTER `flow_mode`",
      );
    }

    if (!existingColumns.has("review_stage")) {
      console.log("检测到缺少列: tasks.review_stage");
      alterClauses.push(
        "ADD COLUMN `review_stage` ENUM('clean', 'annotate', 'train') DEFAULT NULL AFTER `review_status`",
      );
    }

    if (!existingColumns.has("review_comment")) {
      console.log("检测到缺少列: tasks.review_comment");
      alterClauses.push("ADD COLUMN `review_comment` TEXT DEFAULT NULL AFTER `review_stage`");
    }

    if (!existingColumns.has("reviewed_by")) {
      console.log("检测到缺少列: tasks.reviewed_by");
      alterClauses.push("ADD COLUMN `reviewed_by` INT UNSIGNED DEFAULT NULL AFTER `review_comment`");
    }

    if (!existingColumns.has("reviewed_at")) {
      console.log("检测到缺少列: tasks.reviewed_at");
      alterClauses.push("ADD COLUMN `reviewed_at` DATETIME DEFAULT NULL AFTER `reviewed_by`");
    }

    if (!existingIndexes.has("idx_tasks_flow_mode")) {
      console.log("检测到缺少索引: idx_tasks_flow_mode");
      alterClauses.push("ADD KEY `idx_tasks_flow_mode` (`flow_mode`)");
    }

    if (!existingIndexes.has("idx_tasks_need_clean_review")) {
      console.log("检测到缺少索引: idx_tasks_need_clean_review");
      alterClauses.push("ADD KEY `idx_tasks_need_clean_review` (`need_clean_review`)");
    }

    if (!existingIndexes.has("idx_tasks_need_annotate_review")) {
      console.log("检测到缺少索引: idx_tasks_need_annotate_review");
      alterClauses.push("ADD KEY `idx_tasks_need_annotate_review` (`need_annotate_review`)");
    }

    if (!existingIndexes.has("idx_tasks_need_train_review")) {
      console.log("检测到缺少索引: idx_tasks_need_train_review");
      alterClauses.push("ADD KEY `idx_tasks_need_train_review` (`need_train_review`)");
    }

    if (!existingIndexes.has("idx_tasks_review_status")) {
      console.log("检测到缺少索引: idx_tasks_review_status");
      alterClauses.push("ADD KEY `idx_tasks_review_status` (`review_status`)");
    }

    if (!existingIndexes.has("idx_tasks_reviewed_by")) {
      console.log("检测到缺少索引: idx_tasks_reviewed_by");
      alterClauses.push("ADD KEY `idx_tasks_reviewed_by` (`reviewed_by`)");
    }

    if (!existingForeignKeys.has("fk_tasks_reviewed_by")) {
      console.log("检测到缺少外键: fk_tasks_reviewed_by");
      // 旧库补 reviewed_by 后需要同时补外键，避免后续审核人关联出现脏数据。
      alterClauses.push(
        "ADD CONSTRAINT `fk_tasks_reviewed_by` FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`)",
      );
    }

    if (alterClauses.length > 0) {
      const sql = `ALTER TABLE \`tasks\`\n  ${alterClauses.join(",\n  ")};`;
      console.log("即将执行 SQL:");
      console.log(sql);

      await connection.query(sql);
      console.log("tasks 表结构补齐完成。");
    } else {
      console.log("tasks 表结构已完整，无需新增字段或索引。");
    }

    // 兼容历史 flow_mode 数据：manual 回填为三阶段全开，auto 回填为三阶段全关。
    // 使用显式 UPDATE 保证重复执行脚本时依然收敛到一致状态。
    await connection.query(
      `
        UPDATE tasks
        SET
          need_clean_review = CASE WHEN flow_mode = 'manual' THEN 1 ELSE 0 END,
          need_annotate_review = CASE WHEN flow_mode = 'manual' THEN 1 ELSE 0 END,
          need_train_review = CASE WHEN flow_mode = 'manual' THEN 1 ELSE 0 END
      `,
    );

    console.log("历史任务审批字段回填完成。");
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error("升级 tasks 表结构失败:", error);
  process.exit(1);
});
