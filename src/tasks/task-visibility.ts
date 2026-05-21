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

type TaskPrioritySql = {
  expression: string;
  params: number[];
};

function buildRoleVisibilitySql(
  userId: number,
  assigneeColumn: string,
  statusColumn: string,
  status: TaskStatus,
  completedFileColumn: string,
): TaskVisibilitySql {
  return {
    // Visibility rule for non-admin users:
    // 1. the task is currently waiting for this user's stage, or
    // 2. this user has already submitted their stage output.
    condition: `(
      (${assigneeColumn} = ? AND ${statusColumn} = '${status}')
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
        `${tableAlias}.status`,
        "pending_clean",
        `${tableAlias}.cleaned_file`,
      );
    case "annotator":
      return buildRoleVisibilitySql(
        scope.id,
        `${tableAlias}.annotator_id`,
        `${tableAlias}.status`,
        "pending_annotate",
        `${tableAlias}.annotated_file`,
      );
    case "trainer":
      return buildRoleVisibilitySql(
        scope.id,
        `${tableAlias}.trainer_id`,
        `${tableAlias}.status`,
        "pending_train",
        `${tableAlias}.model_file`,
      );
  }
}

export function buildTaskActionPrioritySql(
  scope: TaskVisibilityScope,
  tableAlias = "t",
): TaskPrioritySql {
  // 把“当前就需要处理”的任务排到前面，分页时也能优先看到待办，而不是先看到已处理过的记录。
  switch (scope.role) {
    case "admin":
      return {
        expression: `CASE WHEN ${tableAlias}.review_status = 'pending_admin_review' THEN 0 ELSE 1 END`,
        params: [],
      };
    case "cleaner":
      return {
        expression: `CASE WHEN ${tableAlias}.cleaner_id = ? AND ((${tableAlias}.status = 'pending_clean' AND ${tableAlias}.review_status <> 'pending_admin_review') OR ${tableAlias}.review_status = 'rejected') THEN 0 ELSE 1 END`,
        params: [scope.id],
      };
    case "annotator":
      return {
        expression: `CASE WHEN ${tableAlias}.annotator_id = ? AND ((${tableAlias}.status = 'pending_annotate' AND ${tableAlias}.review_status <> 'pending_admin_review') OR ${tableAlias}.review_status = 'rejected') THEN 0 ELSE 1 END`,
        params: [scope.id],
      };
    case "trainer":
      return {
        expression: `CASE WHEN ${tableAlias}.trainer_id = ? AND ((${tableAlias}.status = 'pending_train' AND ${tableAlias}.review_status <> 'pending_admin_review') OR ${tableAlias}.review_status = 'rejected') THEN 0 ELSE 1 END`,
        params: [scope.id],
      };
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
