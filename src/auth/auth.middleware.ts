import type { NextFunction, Request, RequestHandler, Response } from "express";

import type { AppEnv } from "../config/env.js";
import type { AuthenticatedUser, UserRole } from "../types/domain.js";
import { AppError } from "../utils/app-error.js";
import { verifyAuthToken } from "./token.js";

export type AuthenticatedRequest = Request & {
  authUser?: AuthenticatedUser;
};

export function getAuthUser(req: Request): AuthenticatedUser {
  const authUser = (req as AuthenticatedRequest).authUser;

  if (!authUser) {
    throw new AppError("用户未登录。", {
      statusCode: 401,
      code: "UNAUTHORIZED",
    });
  }

  return authUser;
}

export function requireAuth(env: AppEnv): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const authorization = req.headers.authorization;

    if (!authorization?.startsWith("Bearer ")) {
      next(
        new AppError("缺少有效的授权令牌。", {
          statusCode: 401,
          code: "UNAUTHORIZED",
        }),
      );
      return;
    }

    const token = authorization.slice("Bearer ".length).trim();
    const authUser = verifyAuthToken(token, env.authTokenSecret);

    if (!authUser) {
      next(
        new AppError("登录状态已失效，请重新登录。", {
          statusCode: 401,
          code: "INVALID_TOKEN",
        }),
      );
      return;
    }

    (req as AuthenticatedRequest).authUser = authUser;
    next();
  };
}

export function requireRoles(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    const authUser = getAuthUser(req);

    if (!roles.includes(authUser.role)) {
      next(
        new AppError("当前用户没有操作权限。", {
          statusCode: 403,
          code: "FORBIDDEN",
        }),
      );
      return;
    }

    next();
  };
}
