import type { TaskFileAlias, TaskStatus, UserRole } from "../types/domain.js";

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
      return ["source", "annotated"];
  }
}
