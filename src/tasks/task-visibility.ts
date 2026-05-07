import type {
  AuthenticatedUser,
  TaskReviewStatus,
  TaskStatus,
  UserRole,
} from "../types/domain.js";

type TaskVisibilityScope = {
  id: number;
  role: UserRole;
};

type TaskVisibilityRecord = {
  status: TaskStatus;
  reviewStatus: TaskReviewStatus;
  cleanerId: number;
  annotatorId: number;
  trainerId: number;
  cleanedFile: string | null;
  annotatedFile: string | null;
  modelFile: string | null;
};

type TaskVisibilitySql = {
  condition: string;
  params: number[];
};

function buildRoleVisibilitySql(
  userId: number,
  assigneeColumn: string,
  status: TaskStatus,
  completedFileColumn: string,
): TaskVisibilitySql {
  return {
    // Visibility rule for non-admin users:
    // 1. the task is currently waiting for this user's stage, or
    // 2. this user has already submitted their stage output.
    condition: `(
      (${assigneeColumn} = ? AND status = '${status}')
      OR (${assigneeColumn} = ? AND ${completedFileColumn} IS NOT NULL)
    )`,
    params: [userId, userId],
  };
}

export function buildTaskVisibilitySql(
  scope: TaskVisibilityScope,
  tableAlias = "t",
): TaskVisibilitySql {
  if (scope.role === "admin") {
    return {
      condition: "",
      params: [],
    };
  }

  switch (scope.role) {
    case "cleaner":
      return buildRoleVisibilitySql(
        scope.id,
        `${tableAlias}.cleaner_id`,
        "pending_clean",
        `${tableAlias}.cleaned_file`,
      );
    case "annotator":
      return buildRoleVisibilitySql(
        scope.id,
        `${tableAlias}.annotator_id`,
        "pending_annotate",
        `${tableAlias}.annotated_file`,
      );
    case "trainer":
      return buildRoleVisibilitySql(
        scope.id,
        `${tableAlias}.trainer_id`,
        "pending_train",
        `${tableAlias}.model_file`,
      );
  }
}

export function canUserAccessTask(
  task: TaskVisibilityRecord,
  user: AuthenticatedUser,
): boolean {
  if (user.role === "admin") {
    return true;
  }

  switch (user.role) {
    case "cleaner":
      return (
        (task.cleanerId === user.id && task.status === "pending_clean") ||
        (task.cleanerId === user.id && task.cleanedFile !== null)
      );
    case "annotator":
      return (
        (task.annotatorId === user.id && task.status === "pending_annotate") ||
        (task.annotatorId === user.id && task.annotatedFile !== null)
      );
    case "trainer":
      return (
        (task.trainerId === user.id && task.status === "pending_train") ||
        (task.trainerId === user.id && task.modelFile !== null)
      );
  }
}
