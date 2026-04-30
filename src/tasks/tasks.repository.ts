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

export async function listTasksForUser(scope: TaskListScope): Promise<TaskRow[]> {
  const params: Array<number> = [];
  let whereClause = "";

  if (scope.role !== "admin") {
    whereClause = `
      WHERE t.cleaner_id = ? OR t.annotator_id = ? OR t.trainer_id = ?
    `;
    params.push(scope.id, scope.id, scope.id);
  }

  const rows = await query<TaskQueryRow[]>(
    `
      ${getBaseTaskSelectSql()}
      ${whereClause}
      ORDER BY
        FIELD(t.status, 'pending_clean', 'pending_annotate', 'pending_train', 'finished'),
        t.created_at DESC,
        t.id DESC
    `,
    params,
  );

  return rows.map(mapTaskRow);
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
