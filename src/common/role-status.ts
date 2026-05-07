import type {
  TaskFileAlias,
  TaskReviewStage,
  TaskReviewStatus,
  TaskStatus,
  UserRole,
} from "../types/domain.js";

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: "管理员",
  cleaner: "数据清洗者",
  annotator: "数据标注者",
  trainer: "模型训练者",
};

export const STATUS_LABELS: Record<TaskStatus, string> = {
  pending_clean: "待清洗",
  pending_annotate: "待标注",
  pending_train: "待训练",
  finished: "已完成",
};

export const REVIEW_STATUS_LABELS: Record<TaskReviewStatus, string> = {
  none: "无",
  pending_admin_review: "等待管理员复核",
  rejected: "已驳回待重新提交",
};

export const REVIEW_STAGE_LABELS: Record<TaskReviewStage, string> = {
  clean: "清洗结果",
  annotate: "标注结果",
  train: "训练结果",
};

export const FILE_LABELS: Record<TaskFileAlias, string> = {
  source: "初始文件",
  cleaned: "清洗结果文件",
  annotated: "标注结果文件",
  model: "模型结果文件",
};

export function getStageRole(status: TaskStatus): UserRole | null {
  switch (status) {
    case "pending_clean":
      return "cleaner";
    case "pending_annotate":
      return "annotator";
    case "pending_train":
      return "trainer";
    case "finished":
      return null;
  }
}

export function getStageByStatus(status: TaskStatus): TaskReviewStage | null {
  switch (status) {
    case "pending_clean":
      return "clean";
    case "pending_annotate":
      return "annotate";
    case "pending_train":
      return "train";
    case "finished":
      return null;
  }
}

export function getNextStatus(status: TaskStatus): TaskStatus {
  switch (status) {
    case "pending_clean":
      return "pending_annotate";
    case "pending_annotate":
      return "pending_train";
    case "pending_train":
      return "finished";
    case "finished":
      return "finished";
  }
}

export function getAllowedFileAliases(role: UserRole): TaskFileAlias[] {
  switch (role) {
    case "admin":
      return ["source", "cleaned", "annotated", "model"];
    case "cleaner":
      return ["source"];
    case "annotator":
      return ["cleaned"];
    case "trainer":
      // 训练阶段需要同时消费原始数据、清洗产物和标注产物，
      // 这里补上 cleaned，避免详情页不返回下载项且下载接口被角色白名单拦截。
      return ["source", "cleaned", "annotated"];
  }
}

export function getReviewActionLabel(stage: TaskReviewStage | null): string | null {
  if (!stage) {
    return null;
  }

  return `复核${REVIEW_STAGE_LABELS[stage]}`;
}

export type TaskStageReviewFlags = {
  needCleanReview: boolean;
  needAnnotateReview: boolean;
  needTrainReview: boolean;
};

export function getStageReviewRequired(
  status: TaskStatus,
  flags: TaskStageReviewFlags,
): boolean {
  switch (status) {
    case "pending_clean":
      return flags.needCleanReview;
    case "pending_annotate":
      return flags.needAnnotateReview;
    case "pending_train":
      return flags.needTrainReview;
    case "finished":
      return false;
  }
}

export function getApprovalStages(flags: TaskStageReviewFlags): TaskReviewStage[] {
  const stages: TaskReviewStage[] = [];

  if (flags.needCleanReview) {
    stages.push("clean");
  }

  if (flags.needAnnotateReview) {
    stages.push("annotate");
  }

  if (flags.needTrainReview) {
    stages.push("train");
  }

  return stages;
}
