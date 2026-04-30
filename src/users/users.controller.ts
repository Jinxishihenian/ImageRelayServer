import type { RequestHandler } from "express";

import { USER_ROLES, type UserRole } from "../types/domain.js";
import {
  buildPaginationMeta,
  parseOptionalBoolean,
  parsePaginationQuery,
  parsePositiveInteger,
} from "../common/http.js";
import { getAuthUser } from "../auth/auth.middleware.js";
import { AppError } from "../utils/app-error.js";
import {
  createUser,
  deleteUserById,
  findUserById,
  findUserByUsername,
  getUserListSummary,
  listAllUsers,
  listUsersPage,
  updateUser,
  userHasTaskReferences,
} from "./users.repository.js";

export const listUsersHandler: RequestHandler = async (req, res) => {
  const all = parseOptionalBoolean(req.query.all, "all");

  if (all) {
    // 创建任务抽屉仍然需要完整用户列表，避免默认分页把负责人下拉截断。
    const [users, summary] = await Promise.all([listAllUsers(), getUserListSummary()]);
    const pageSize = users.length === 0 ? 10 : users.length;

    res.json({
      items: users,
      pagination: buildPaginationMeta(1, pageSize, summary.total),
      summary,
    });
    return;
  }

  const pagination = parsePaginationQuery(req.query);
  const userPage = await listUsersPage(pagination);

  res.json({
    items: userPage.items,
    pagination: buildPaginationMeta(userPage.page, userPage.pageSize, userPage.total),
    summary: userPage.summary,
  });
};

function parseRole(value: unknown): UserRole {
  if (typeof value !== "string" || !USER_ROLES.includes(value as UserRole)) {
    throw new AppError("用户角色不合法。", {
      statusCode: 400,
      code: "INVALID_USER_ROLE",
    });
  }

  return value as UserRole;
}

function parseRequiredUsername(value: unknown): string {
  const username = typeof value === "string" ? value.trim() : "";

  if (!username) {
    throw new AppError("用户名不能为空。", {
      statusCode: 400,
      code: "INVALID_USERNAME",
    });
  }

  return username;
}

function parseRequiredPassword(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new AppError("密码不能为空。", {
      statusCode: 400,
      code: "INVALID_PASSWORD",
    });
  }

  return value;
}

export const createUserHandler: RequestHandler = async (req, res) => {
  const username = parseRequiredUsername((req.body as { username?: unknown }).username);
  const password = parseRequiredPassword((req.body as { password?: unknown }).password);
  const role = parseRole((req.body as { role?: unknown }).role);

  const existingUser = await findUserByUsername(username);

  if (existingUser) {
    throw new AppError("用户名已存在，请更换后重试。", {
      statusCode: 409,
      code: "USERNAME_ALREADY_EXISTS",
    });
  }

  const userId = await createUser({
    username,
    password,
    role,
  });
  const createdUser = await findUserById(userId);

  if (!createdUser) {
    throw new AppError("用户创建成功，但读取结果失败。", {
      statusCode: 500,
      code: "USER_CREATED_BUT_NOT_FOUND",
      expose: false,
    });
  }

  res.status(201).json({
    item: {
      id: createdUser.id,
      username: createdUser.username,
      role: createdUser.role,
      createdAt: createdUser.createdAt,
    },
  });
};

export const updateUserHandler: RequestHandler = async (req, res) => {
  const userId = parsePositiveInteger(String(req.params.userId), "userId");
  const payload = req.body as {
    username?: unknown;
    password?: unknown;
    role?: unknown;
  };

  if (payload.role !== undefined) {
    throw new AppError("修改用户时不允许修改角色。", {
      statusCode: 400,
      code: "ROLE_UPDATE_FORBIDDEN",
    });
  }

  const existingUser = await findUserById(userId);

  if (!existingUser) {
    throw new AppError("用户不存在。", {
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  }

  const username = parseRequiredUsername(payload.username);
  const password =
    payload.password === undefined ? undefined : parseRequiredPassword(payload.password);
  const sameNameUser = await findUserByUsername(username);

  if (sameNameUser && sameNameUser.id !== userId) {
    throw new AppError("用户名已存在，请更换后重试。", {
      statusCode: 409,
      code: "USERNAME_ALREADY_EXISTS",
    });
  }

  await updateUser({
    id: userId,
    username,
    password,
  });

  const updatedUser = await findUserById(userId);

  if (!updatedUser) {
    throw new AppError("用户更新成功，但读取结果失败。", {
      statusCode: 500,
      code: "USER_UPDATED_BUT_NOT_FOUND",
      expose: false,
    });
  }

  res.json({
    item: {
      id: updatedUser.id,
      username: updatedUser.username,
      role: updatedUser.role,
      createdAt: updatedUser.createdAt,
    },
  });
};

export const deleteUserHandler: RequestHandler = async (req, res) => {
  const userId = parsePositiveInteger(String(req.params.userId), "userId");
  const authUser = getAuthUser(req);

  if (authUser.id === userId) {
    throw new AppError("不能删除当前登录账号。", {
      statusCode: 400,
      code: "DELETE_SELF_FORBIDDEN",
    });
  }

  const existingUser = await findUserById(userId);

  if (!existingUser) {
    throw new AppError("用户不存在。", {
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  }

  const hasReferences = await userHasTaskReferences(userId);

  if (hasReferences) {
    throw new AppError("该用户已被任务引用，不能删除。", {
      statusCode: 400,
      code: "USER_REFERENCED_BY_TASKS",
    });
  }

  await deleteUserById(userId);
  res.status(204).send();
};
