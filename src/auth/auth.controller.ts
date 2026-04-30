import type { RequestHandler } from "express";

import type { AppEnv } from "../config/env.js";
import { AppError } from "../utils/app-error.js";
import { createAuthToken } from "./token.js";
import { findUserByUsername } from "../users/users.repository.js";

export function createLoginHandler(env: AppEnv): RequestHandler {
  return async (req, res) => {
    const { username, password } = req.body as {
      username?: string;
      password?: string;
    };

    if (!username?.trim() || !password) {
      throw new AppError("账号和密码不能为空。", {
        statusCode: 400,
        code: "INVALID_LOGIN_PAYLOAD",
      });
    }

    const user = await findUserByUsername(username.trim());

    if (!user || user.password !== password) {
      throw new AppError("账号或密码错误。", {
        statusCode: 401,
        code: "INVALID_CREDENTIALS",
      });
    }

    const token = createAuthToken(
      {
        id: user.id,
        username: user.username,
        role: user.role,
      },
      env.authTokenSecret,
    );

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.createdAt,
      },
    });
  };
}
