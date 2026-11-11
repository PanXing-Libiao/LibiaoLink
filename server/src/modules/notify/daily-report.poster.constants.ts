/** 合集图硬上限：超出预算时截断文字并提示点击上方深链，不继续增高。 */
export const DAILY_REPORT_POSTER_MAX_HEIGHT = 16_000;
/** 每张合集图最多展示的附件缩略图数量；取每项首图后超限则整图回退文字 + 深链。 */
export const DAILY_REPORT_POSTER_MAX_THUMBNAILS = 8;
export const DAILY_REPORT_DIGEST_TRUNCATION_NOTICE = "内容较多，本图已展示可容纳部分；完整内容请点击上方深链。";
export const DAILY_REPORT_DIGEST_ATTACHMENT_NOTICE = "附件较多，每项仅展示 1 张且整图最多 8 张；完整内容请点击上方深链。";
