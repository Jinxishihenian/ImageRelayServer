import { AppError } from "../utils/app-error.js";

export function parsePositiveInteger(value: string, fieldName: string): number {
  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(`${fieldName} 必须是正整数。`, {
      statusCode: 400,
      code: "INVALID_INTEGER",
      details: {
        field: fieldName,
      },
    });
  }

  return parsed;
}
