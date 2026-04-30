import crypto from "node:crypto";

import type { AuthenticatedUser } from "../types/domain.js";

type TokenPayload = AuthenticatedUser & {
  exp: number;
};

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function encodeBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function decodeBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

function createSignature(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createAuthToken(user: AuthenticatedUser, secret: string): string {
  const payload: TokenPayload = {
    ...user,
    exp: Date.now() + TOKEN_TTL_MS,
  };
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = createSignature(encodedPayload, secret);

  return `${encodedPayload}.${signature}`;
}

export function verifyAuthToken(token: string, secret: string): AuthenticatedUser | null {
  const [encodedPayload, signature] = token.split(".");

  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = createSignature(encodedPayload, secret);

  if (
    signature.length !== expectedSignature.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeBase64Url(encodedPayload)) as TokenPayload;

    if (parsed.exp <= Date.now()) {
      return null;
    }

    return {
      id: parsed.id,
      username: parsed.username,
      role: parsed.role,
    };
  } catch {
    return null;
  }
}
