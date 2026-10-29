/** 阶段完成群里程碑海报：由 notify.group 的 STAGE_COMPLETE_GROUP 模板消费。 */
export interface StageCompletePosterStage {
  key: string;
  total: number;
  done: number;
}

export interface StageCompletePosterData {
  projectCode: string;
  projectName: string;
  stageKey: string;
  completedAt: Date;
  stages: StageCompletePosterStage[];
}
