import type { MaterialReissueSnapshot } from "@libiaolink/contracts";

/** 物料变更补发群图片快照：数据来自 change_requests.material_reissue，不反向依赖 file 模块。 */
export interface MaterialReissuePosterData {
  snapshot: MaterialReissueSnapshot;
  submittedAt: Date;
}
