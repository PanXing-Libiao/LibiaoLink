import { previewKindOf } from "./fileApi";

/** 移动端文件预览口径（2026-10-28）：只允许 CAD 进入在线查看，其余类型直接下载原文件。
 * 设备判定不把窄桌面窗口误当手机：手机 / 平板 UA，或触屏且窄视口。 */
export function isMobileFilePreviewDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return false;
  }
  const userAgent = navigator.userAgent;
  const mobileUserAgent = /Android|iPhone|iPad|iPod|HarmonyOS|OpenHarmony/i.test(userAgent);
  const touchMac = navigator.maxTouchPoints > 1 && /Macintosh/i.test(userAgent);
  const narrowTouch = navigator.maxTouchPoints > 0 && window.matchMedia("(max-width: 767px)").matches;
  return mobileUserAgent || touchMac || narrowTouch;
}

/** true = 当前设备必须下载而不是打开文件预览；仅 CAD 在移动端保留在线查看。 */
export function mobileFilePreviewMustDownload(name: string): boolean {
  return isMobileFilePreviewDevice() && previewKindOf(name) !== "cad";
}
