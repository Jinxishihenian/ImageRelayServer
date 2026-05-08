export const USER_ROLES = ["admin", "cleaner", "annotator", "trainer"] as const;
export const MODEL_ITERATION_STATUSES = ["active", "archived"] as const;
export const TASK_STATUSES = [
  "pending_clean",
  "pending_annotate",
  "pending_train",
  "finished",
] as const;
export const TASK_REVIEW_STATUSES = [
  "none",
  "pending_admin_review",
  "rejected",
] as const;
export const TASK_REVIEW_STAGES = ["clean", "annotate", "train"] as const;
export const TASK_FILE_ALIASES = ["source", "cleaned", "annotated", "model"] as const;

export type UserRole = (typeof USER_ROLES)[number];
export type ModelIterationStatus = (typeof MODEL_ITERATION_STATUSES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskReviewStatus = (typeof TASK_REVIEW_STATUSES)[number];
export type TaskReviewStage = (typeof TASK_REVIEW_STAGES)[number];
export type TaskFileAlias = (typeof TASK_FILE_ALIASES)[number];

export type AuthenticatedUser = {
  id: number;
  username: string;
  role: UserRole;
};

export type UserSummary = {
  id: number;
  username: string;
  role: UserRole;
  createdAt: string;
};

export type UploadedFileRef = {
  storageKey: string;
  originalName: string;
  mimeType: string;
  size: number;
};
