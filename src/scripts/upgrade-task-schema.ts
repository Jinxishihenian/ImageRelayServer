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
    throw new Error(`Environment variable ${name} is required.`);
  }

  return value;
}

function getDbConfig(): DbConfig {
  const rawPort = process.env.DB_PORT?.trim() || "3306";
  const port = Number(rawPort);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("Environment variable DB_PORT must be an integer between 1 and 65535.");
  }

  return {
    host: getRequiredEnv("DB_HOST", "127.0.0.1"),
    port,
    user: getRequiredEnv("DB_USER", "root"),
    // Do not trim the password. Trailing or leading spaces may be intentional.
    password: process.env.DB_PASSWORD ?? "",
    database: getRequiredEnv("DB_NAME", "wss_image_relay"),
  };
}

async function getExistingColumns(
  connection: mysql.Connection,
  databaseName: string,
  tableName: string,
): Promise<Set<string>> {
  const [rows] = await connection.query<ColumnRow[]>(
    `
      SELECT COLUMN_NAME
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `,
    [databaseName, tableName],
  );

  return new Set(rows.map((row) => row.COLUMN_NAME));
}

async function getExistingIndexes(
  connection: mysql.Connection,
  databaseName: string,
  tableName: string,
): Promise<Set<string>> {
  const [rows] = await connection.query<IndexRow[]>(
    `
      SELECT INDEX_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
    `,
    [databaseName, tableName],
  );

  return new Set(rows.map((row) => row.INDEX_NAME));
}

async function getExistingForeignKeys(
  connection: mysql.Connection,
  databaseName: string,
  tableName: string,
): Promise<Set<string>> {
  const [rows] = await connection.query<ForeignKeyRow[]>(
    `
      SELECT CONSTRAINT_NAME
      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'
    `,
    [databaseName, tableName],
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
    throw new Error(`Database ${databaseName} does not contain the tasks table.`);
  }
}

async function ensureModelIterationsTable(connection: mysql.Connection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS \`model_iterations\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`name\` VARCHAR(128) NOT NULL,
      \`description\` TEXT NOT NULL,
      \`base_model_name\` VARCHAR(255) NOT NULL,
      \`goal\` TEXT NOT NULL,
      \`status\` ENUM('active', 'archived') NOT NULL DEFAULT 'active',
      \`creator_id\` INT UNSIGNED NOT NULL,
      \`current_best_task_id\` INT UNSIGNED DEFAULT NULL,
      \`latest_task_id\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      KEY \`idx_model_iterations_status\` (\`status\`),
      KEY \`idx_model_iterations_creator\` (\`creator_id\`),
      KEY \`idx_model_iterations_current_best_task\` (\`current_best_task_id\`),
      KEY \`idx_model_iterations_latest_task\` (\`latest_task_id\`),
      CONSTRAINT \`fk_model_iterations_creator\` FOREIGN KEY (\`creator_id\`) REFERENCES \`users\` (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureDatasetsTable(connection: mysql.Connection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS \`datasets\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`task_id\` INT UNSIGNED NOT NULL,
      \`name\` VARCHAR(160) NOT NULL,
      \`description\` TEXT NOT NULL,
      \`modality\` VARCHAR(32) NOT NULL DEFAULT 'image',
      \`task_type\` VARCHAR(64) NOT NULL DEFAULT 'task_dataset_phase1',
      \`creator_id\` INT UNSIGNED NOT NULL,
      \`current_version_id\` INT UNSIGNED DEFAULT NULL,
      \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      \`updated_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uk_datasets_task_id\` (\`task_id\`),
      KEY \`idx_datasets_creator\` (\`creator_id\`),
      KEY \`idx_datasets_current_version\` (\`current_version_id\`),
      CONSTRAINT \`fk_datasets_task\` FOREIGN KEY (\`task_id\`) REFERENCES \`tasks\` (\`id\`),
      CONSTRAINT \`fk_datasets_creator\` FOREIGN KEY (\`creator_id\`) REFERENCES \`users\` (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureDatasetVersionsTable(connection: mysql.Connection): Promise<void> {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS \`dataset_versions\` (
      \`id\` INT UNSIGNED NOT NULL AUTO_INCREMENT,
      \`dataset_id\` INT UNSIGNED NOT NULL,
      \`version_no\` INT UNSIGNED NOT NULL,
      \`stage\` ENUM('raw', 'cleaned', 'annotated') NOT NULL,
      \`parent_version_id\` INT UNSIGNED DEFAULT NULL,
      \`source_task_id\` INT UNSIGNED NOT NULL,
      \`storage_key\` VARCHAR(255) NOT NULL,
      \`file_name\` VARCHAR(255) NOT NULL,
      \`review_based\` TINYINT(1) NOT NULL DEFAULT 0,
      \`created_by\` INT UNSIGNED NOT NULL,
      \`created_at\` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uk_dataset_versions_dataset_version_no\` (\`dataset_id\`, \`version_no\`),
      KEY \`idx_dataset_versions_stage\` (\`stage\`),
      KEY \`idx_dataset_versions_parent\` (\`parent_version_id\`),
      KEY \`idx_dataset_versions_source_task\` (\`source_task_id\`),
      KEY \`idx_dataset_versions_created_by\` (\`created_by\`),
      CONSTRAINT \`fk_dataset_versions_dataset\` FOREIGN KEY (\`dataset_id\`) REFERENCES \`datasets\` (\`id\`),
      CONSTRAINT \`fk_dataset_versions_parent\` FOREIGN KEY (\`parent_version_id\`) REFERENCES \`dataset_versions\` (\`id\`),
      CONSTRAINT \`fk_dataset_versions_source_task\` FOREIGN KEY (\`source_task_id\`) REFERENCES \`tasks\` (\`id\`),
      CONSTRAINT \`fk_dataset_versions_created_by\` FOREIGN KEY (\`created_by\`) REFERENCES \`users\` (\`id\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function ensureDatasetCurrentVersionForeignKey(
  connection: mysql.Connection,
  databaseName: string,
): Promise<void> {
  const existingForeignKeys = await getExistingForeignKeys(connection, databaseName, "datasets");

  if (existingForeignKeys.has("fk_datasets_current_version")) {
    return;
  }

  console.log("Missing foreign key: fk_datasets_current_version");
  await connection.query(
    "ALTER TABLE `datasets` ADD CONSTRAINT `fk_datasets_current_version` FOREIGN KEY (`current_version_id`) REFERENCES `dataset_versions` (`id`)",
  );
}

async function upgradeTasksTable(connection: mysql.Connection, databaseName: string): Promise<boolean> {
  const existingColumns = await getExistingColumns(connection, databaseName, "tasks");
  const existingIndexes = await getExistingIndexes(connection, databaseName, "tasks");
  const existingForeignKeys = await getExistingForeignKeys(connection, databaseName, "tasks");
  const alterClauses: string[] = [];
  const datasetColumnsMissing =
    !existingColumns.has("dataset_id") ||
    !existingColumns.has("raw_dataset_version_id") ||
    !existingColumns.has("cleaned_dataset_version_id") ||
    !existingColumns.has("annotated_dataset_version_id");

  if (!existingColumns.has("flow_mode")) {
    console.log("Missing column: tasks.flow_mode");
    alterClauses.push("ADD COLUMN `flow_mode` ENUM('auto', 'manual') NOT NULL DEFAULT 'auto' AFTER `status`");
  }

  if (!existingColumns.has("need_clean_review")) {
    console.log("Missing column: tasks.need_clean_review");
    alterClauses.push("ADD COLUMN `need_clean_review` TINYINT(1) NOT NULL DEFAULT 0 AFTER `flow_mode`");
  }

  if (!existingColumns.has("need_annotate_review")) {
    console.log("Missing column: tasks.need_annotate_review");
    alterClauses.push(
      "ADD COLUMN `need_annotate_review` TINYINT(1) NOT NULL DEFAULT 0 AFTER `need_clean_review`",
    );
  }

  if (!existingColumns.has("need_train_review")) {
    console.log("Missing column: tasks.need_train_review");
    alterClauses.push(
      "ADD COLUMN `need_train_review` TINYINT(1) NOT NULL DEFAULT 0 AFTER `need_annotate_review`",
    );
  }

  if (!existingColumns.has("review_status")) {
    console.log("Missing column: tasks.review_status");
    alterClauses.push(
      "ADD COLUMN `review_status` ENUM('none', 'pending_admin_review', 'rejected') NOT NULL DEFAULT 'none' AFTER `flow_mode`",
    );
  }

  if (!existingColumns.has("review_stage")) {
    console.log("Missing column: tasks.review_stage");
    alterClauses.push("ADD COLUMN `review_stage` ENUM('clean', 'annotate', 'train') DEFAULT NULL AFTER `review_status`");
  }

  if (!existingColumns.has("review_comment")) {
    console.log("Missing column: tasks.review_comment");
    alterClauses.push("ADD COLUMN `review_comment` TEXT DEFAULT NULL AFTER `review_stage`");
  }

  if (!existingColumns.has("reviewed_by")) {
    console.log("Missing column: tasks.reviewed_by");
    alterClauses.push("ADD COLUMN `reviewed_by` INT UNSIGNED DEFAULT NULL AFTER `review_comment`");
  }

  if (!existingColumns.has("reviewed_at")) {
    console.log("Missing column: tasks.reviewed_at");
    alterClauses.push("ADD COLUMN `reviewed_at` DATETIME DEFAULT NULL AFTER `reviewed_by`");
  }

  if (!existingColumns.has("model_iteration_id")) {
    console.log("Missing column: tasks.model_iteration_id");
    alterClauses.push("ADD COLUMN `model_iteration_id` INT UNSIGNED DEFAULT NULL AFTER `id`");
  }

  if (!existingColumns.has("dataset_id")) {
    console.log("Missing column: tasks.dataset_id");
    // Keep these columns nullable first so legacy rows can be backfilled later.
    alterClauses.push("ADD COLUMN `dataset_id` INT UNSIGNED DEFAULT NULL AFTER `model_iteration_id`");
  }

  if (!existingColumns.has("raw_dataset_version_id")) {
    console.log("Missing column: tasks.raw_dataset_version_id");
    alterClauses.push("ADD COLUMN `raw_dataset_version_id` INT UNSIGNED DEFAULT NULL AFTER `dataset_id`");
  }

  if (!existingColumns.has("cleaned_dataset_version_id")) {
    console.log("Missing column: tasks.cleaned_dataset_version_id");
    alterClauses.push(
      "ADD COLUMN `cleaned_dataset_version_id` INT UNSIGNED DEFAULT NULL AFTER `raw_dataset_version_id`",
    );
  }

  if (!existingColumns.has("annotated_dataset_version_id")) {
    console.log("Missing column: tasks.annotated_dataset_version_id");
    alterClauses.push(
      "ADD COLUMN `annotated_dataset_version_id` INT UNSIGNED DEFAULT NULL AFTER `cleaned_dataset_version_id`",
    );
  }

  if (!existingIndexes.has("idx_tasks_flow_mode")) {
    console.log("Missing index: idx_tasks_flow_mode");
    alterClauses.push("ADD KEY `idx_tasks_flow_mode` (`flow_mode`)");
  }

  if (!existingIndexes.has("idx_tasks_need_clean_review")) {
    console.log("Missing index: idx_tasks_need_clean_review");
    alterClauses.push("ADD KEY `idx_tasks_need_clean_review` (`need_clean_review`)");
  }

  if (!existingIndexes.has("idx_tasks_need_annotate_review")) {
    console.log("Missing index: idx_tasks_need_annotate_review");
    alterClauses.push("ADD KEY `idx_tasks_need_annotate_review` (`need_annotate_review`)");
  }

  if (!existingIndexes.has("idx_tasks_need_train_review")) {
    console.log("Missing index: idx_tasks_need_train_review");
    alterClauses.push("ADD KEY `idx_tasks_need_train_review` (`need_train_review`)");
  }

  if (!existingIndexes.has("idx_tasks_review_status")) {
    console.log("Missing index: idx_tasks_review_status");
    alterClauses.push("ADD KEY `idx_tasks_review_status` (`review_status`)");
  }

  if (!existingIndexes.has("idx_tasks_reviewed_by")) {
    console.log("Missing index: idx_tasks_reviewed_by");
    alterClauses.push("ADD KEY `idx_tasks_reviewed_by` (`reviewed_by`)");
  }

  if (!existingIndexes.has("idx_tasks_model_iteration")) {
    console.log("Missing index: idx_tasks_model_iteration");
    alterClauses.push("ADD KEY `idx_tasks_model_iteration` (`model_iteration_id`)");
  }

  if (!existingIndexes.has("idx_tasks_dataset")) {
    console.log("Missing index: idx_tasks_dataset");
    alterClauses.push("ADD KEY `idx_tasks_dataset` (`dataset_id`)");
  }

  if (!existingIndexes.has("idx_tasks_raw_dataset_version")) {
    console.log("Missing index: idx_tasks_raw_dataset_version");
    alterClauses.push("ADD KEY `idx_tasks_raw_dataset_version` (`raw_dataset_version_id`)");
  }

  if (!existingIndexes.has("idx_tasks_cleaned_dataset_version")) {
    console.log("Missing index: idx_tasks_cleaned_dataset_version");
    alterClauses.push("ADD KEY `idx_tasks_cleaned_dataset_version` (`cleaned_dataset_version_id`)");
  }

  if (!existingIndexes.has("idx_tasks_annotated_dataset_version")) {
    console.log("Missing index: idx_tasks_annotated_dataset_version");
    alterClauses.push("ADD KEY `idx_tasks_annotated_dataset_version` (`annotated_dataset_version_id`)");
  }

  if (!existingForeignKeys.has("fk_tasks_reviewed_by")) {
    console.log("Missing foreign key: fk_tasks_reviewed_by");
    alterClauses.push(
      "ADD CONSTRAINT `fk_tasks_reviewed_by` FOREIGN KEY (`reviewed_by`) REFERENCES `users` (`id`)",
    );
  }

  if (existingColumns.has("model_iteration_id") && !existingForeignKeys.has("fk_tasks_model_iteration")) {
    console.log("Missing foreign key: fk_tasks_model_iteration");
    alterClauses.push(
      "ADD CONSTRAINT `fk_tasks_model_iteration` FOREIGN KEY (`model_iteration_id`) REFERENCES `model_iterations` (`id`)",
    );
  }

  if (existingColumns.has("dataset_id") && !existingForeignKeys.has("fk_tasks_dataset")) {
    console.log("Missing foreign key: fk_tasks_dataset");
    alterClauses.push(
      "ADD CONSTRAINT `fk_tasks_dataset` FOREIGN KEY (`dataset_id`) REFERENCES `datasets` (`id`)",
    );
  }

  if (existingColumns.has("raw_dataset_version_id") && !existingForeignKeys.has("fk_tasks_raw_dataset_version")) {
    console.log("Missing foreign key: fk_tasks_raw_dataset_version");
    alterClauses.push(
      "ADD CONSTRAINT `fk_tasks_raw_dataset_version` FOREIGN KEY (`raw_dataset_version_id`) REFERENCES `dataset_versions` (`id`)",
    );
  }

  if (
    existingColumns.has("cleaned_dataset_version_id") &&
    !existingForeignKeys.has("fk_tasks_cleaned_dataset_version")
  ) {
    console.log("Missing foreign key: fk_tasks_cleaned_dataset_version");
    alterClauses.push(
      "ADD CONSTRAINT `fk_tasks_cleaned_dataset_version` FOREIGN KEY (`cleaned_dataset_version_id`) REFERENCES `dataset_versions` (`id`)",
    );
  }

  if (
    existingColumns.has("annotated_dataset_version_id") &&
    !existingForeignKeys.has("fk_tasks_annotated_dataset_version")
  ) {
    console.log("Missing foreign key: fk_tasks_annotated_dataset_version");
    alterClauses.push(
      "ADD CONSTRAINT `fk_tasks_annotated_dataset_version` FOREIGN KEY (`annotated_dataset_version_id`) REFERENCES `dataset_versions` (`id`)",
    );
  }

  if (alterClauses.length > 0) {
    const sql = `ALTER TABLE \`tasks\`\n  ${alterClauses.join(",\n  ")};`;
    console.log("Running SQL:");
    console.log(sql);
    await connection.query(sql);
    console.log("tasks table upgrade completed.");
  } else {
    console.log("tasks table is already up to date.");
  }

  return datasetColumnsMissing;
}

async function backfillTaskReviewFlags(connection: mysql.Connection): Promise<void> {
  // Keep the script idempotent by recomputing review flags from flow_mode every time.
  await connection.query(
    `
      UPDATE tasks
      SET
        need_clean_review = CASE WHEN flow_mode = 'manual' THEN 1 ELSE 0 END,
        need_annotate_review = CASE WHEN flow_mode = 'manual' THEN 1 ELSE 0 END,
        need_train_review = CASE WHEN flow_mode = 'manual' THEN 1 ELSE 0 END
    `,
  );
}

async function main(): Promise<void> {
  const config = getDbConfig();

  console.log(`Connecting to database ${config.host}:${config.port}/${config.database}`);

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
    await ensureModelIterationsTable(connection);
    await ensureDatasetsTable(connection);
    await ensureDatasetVersionsTable(connection);

    const datasetColumnsAdded = await upgradeTasksTable(connection, config.database);
    await ensureDatasetCurrentVersionForeignKey(connection, config.database);
    await backfillTaskReviewFlags(connection);

    console.log("Task review flags backfill completed.");
    console.log("If legacy rows exist, backfill model_iteration_id before making it NOT NULL.");
    if (datasetColumnsAdded) {
      console.log("If legacy rows exist, backfill dataset_id and the dataset version ids as needed.");
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error("Schema upgrade failed:", error);
  process.exit(1);
});
