/** R06 动态海报共享数据与绘制口径。 */
export interface R06PosterView {
  projectCode: string;
  projectName: string;
  status: string;
  managers: string[];
  participants: string[];
  taskTotal: number;
  taskDone: number;
  onTimeDone: number;
  startDate: string | null;
  plannedEnd: string | null;
  completedAt: Date;
}

export interface R06PosterFontPaths {
  sans?: string;
  sansBold?: string;
  serif?: string;
}

export interface R06PosterMetrics {
  elapsedDays: number;
  plannedDays: number;
  rate: number;
  rateText: string;
  rateLabel: string;
  allTasksDone: boolean;
}
