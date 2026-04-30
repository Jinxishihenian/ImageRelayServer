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

function parseSingleQueryValue(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string") {
    return value[0];
  }

  throw new AppError(`${fieldName} 必须是单个查询参数。`, {
    statusCode: 400,
    code: "INVALID_QUERY_PARAM",
    details: {
      field: fieldName,
    },
  });
}

export function parseOptionalPositiveInteger(
  value: unknown,
  fieldName: string,
  fallbackValue: number,
): number {
  const normalizedValue = parseSingleQueryValue(value, fieldName);

  if (normalizedValue === undefined || normalizedValue.trim() === "") {
    return fallbackValue;
  }

  return parsePositiveInteger(normalizedValue, fieldName);
}

export function parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  const normalizedValue = parseSingleQueryValue(value, fieldName);

  if (normalizedValue === undefined || normalizedValue.trim() === "") {
    return undefined;
  }

  if (normalizedValue === "true" || normalizedValue === "1") {
    return true;
  }

  if (normalizedValue === "false" || normalizedValue === "0") {
    return false;
  }

  throw new AppError(`${fieldName} 必须是布尔值。`, {
    statusCode: 400,
    code: "INVALID_BOOLEAN",
    details: {
      field: fieldName,
    },
  });
}

export type PaginationQuery = {
  page: number;
  pageSize: number;
};

export type PaginationMeta = {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};

export function parsePaginationQuery(
  query: {
    page?: unknown;
    pageSize?: unknown;
  },
  defaults: PaginationQuery = {
    page: 1,
    pageSize: 10,
  },
): PaginationQuery {
  return {
    page: parseOptionalPositiveInteger(query.page, "page", defaults.page),
    pageSize: parseOptionalPositiveInteger(query.pageSize, "pageSize", defaults.pageSize),
  };
}

export function buildPaginationMeta(
  page: number,
  pageSize: number,
  total: number,
): PaginationMeta {
  return {
    page,
    pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
  };
}
