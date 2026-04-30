export type AppErrorOptions = {
  statusCode: number;
  code: string;
  details?: unknown;
  expose?: boolean;
};

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(message: string, options: AppErrorOptions) {
    super(message);
    this.name = "AppError";
    this.statusCode = options.statusCode;
    this.code = options.code;
    this.details = options.details;
    this.expose = options.expose ?? true;
  }
}
