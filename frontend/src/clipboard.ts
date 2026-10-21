/**
 * 复制到剪贴板（双通道 · Push 253 修「复制一直失败」）。
 *
 * ① 优先 `navigator.clipboard.writeText`（异步剪贴板 API）；
 * ② 不可用 / 被拒（**非安全上下文** = http + 局域网 IP，或文档失焦、权限被拒）→ 回退
 *    `document.execCommand("copy")`（临时 textarea 选区，http 下唯一可用路径）；
 * ③ 两条都失败 → 返回 false，由调用方提示「手动选中复制」（码面已置为可全选）。
 *
 * 为什么必须回退：`navigator.clipboard` 只在安全上下文（https / localhost）存在 —— 用
 * `http://10.x.x.x:5173` 打开时它是 undefined，直接调用即抛错（旧实现只走 ① → 恒失败）。
 */

/** 复制文本：成功 = true。调用方据返回值给「已复制」/「复制失败（请手动选中复制）」两种反馈。 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard !== undefined && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // 落到回退通道（非安全上下文 / 权限被拒 / 文档失焦）
    }
  }
  return copyByExecCommand(text);
}

/** 回退通道（http 非安全上下文唯一可用路径）：临时 textarea + 选区 + execCommand("copy")。 */
function copyByExecCommand(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "true");
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.top = "-1000px";
  area.style.opacity = "0";
  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, area.value.length);
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.body.removeChild(area);
  }
}