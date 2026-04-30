import type { RowDataPacket } from "mysql2";

import { execute, query } from "../database/mysql.js";
import type { UserRole, UserSummary } from "../types/domain.js";
import { toIsoString } from "../common/date.js";

type UserRow = RowDataPacket & {
  id: number;
  username: string;
  password: string;
  role: UserRole;
  created_at: Date | string;
};

function mapUserRow(row: UserRow): UserSummary {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    createdAt: toIsoString(row.created_at),
  };
}

async function findUserRowsBySql(sql: string, params: any[] = []): Promise<UserRow[]> {
  return query<UserRow[]>(sql, params);
}

export async function findUserByUsername(username: string): Promise<(UserSummary & { password: string }) | null> {
  const rows = await findUserRowsBySql(
    `
      SELECT id, username, password, role, created_at
      FROM users
      WHERE username = ?
      LIMIT 1
    `,
    [username],
  );

  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    ...mapUserRow(row),
    password: row.password,
  };
}

export async function findUserById(userId: number): Promise<(UserSummary & { password: string }) | null> {
  const rows = await findUserRowsBySql(
    `
      SELECT id, username, password, role, created_at
      FROM users
      WHERE id = ?
      LIMIT 1
    `,
    [userId],
  );

  const row = rows[0];

  if (!row) {
    return null;
  }

  return {
    ...mapUserRow(row),
    password: row.password,
  };
}

export async function findUsersByIds(ids: number[]): Promise<UserSummary[]> {
  if (ids.length === 0) {
    return [];
  }

  const placeholders = ids.map(() => "?").join(", ");
  const rows = await query<UserRow[]>(
    `
      SELECT id, username, password, role, created_at
      FROM users
      WHERE id IN (${placeholders})
    `,
    ids,
  );

  return rows.map(mapUserRow);
}

export async function listAllUsers(): Promise<UserSummary[]> {
  const rows = await findUserRowsBySql(
    `
      SELECT id, username, password, role, created_at
      FROM users
      ORDER BY FIELD(role, 'admin', 'cleaner', 'annotator', 'trainer'), id
    `,
  );

  return rows.map(mapUserRow);
}

export async function createUser(input: {
  username: string;
  password: string;
  role: UserRole;
}): Promise<number> {
  const result = await execute(
    `
      INSERT INTO users (username, password, role)
      VALUES (?, ?, ?)
    `,
    [input.username, input.password, input.role],
  );

  return result.insertId;
}

export async function updateUser(input: {
  id: number;
  username: string;
  password?: string;
}): Promise<boolean> {
  const params: Array<number | string> = [input.username];
  let sql = `
    UPDATE users
    SET username = ?
  `;

  // 编辑用户时允许不改密码，避免管理员每次修改用户名都必须重置密码。
  if (input.password !== undefined) {
    sql += `,
      password = ?
    `;
    params.push(input.password);
  }

  sql += `
    WHERE id = ?
  `;
  params.push(input.id);

  const result = await execute(sql, params);
  return result.affectedRows > 0;
}

export async function userHasTaskReferences(userId: number): Promise<boolean> {
  const rows = await query<Array<RowDataPacket & { matched: number }>>(
    `
      SELECT 1 AS matched
      FROM tasks
      WHERE creator_id = ? OR cleaner_id = ? OR annotator_id = ? OR trainer_id = ?
      LIMIT 1
    `,
    [userId, userId, userId, userId],
  );

  return rows.length > 0;
}

export async function deleteUserById(userId: number): Promise<boolean> {
  const result = await execute(
    `
      DELETE FROM users
      WHERE id = ?
    `,
    [userId],
  );

  return result.affectedRows > 0;
}
