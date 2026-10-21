import { useState, type FormEvent } from "react";
import { useT } from "../i18n";

/** 输入框样式：与看板「添加 → 临时任务」表单同一套「白底 + 淡灰描边」小框口径。 */
const INPUT_CLASS =
  "w-full rounded-lg border border-zinc-200/90 bg-white/75 px-2 py-1.5 text-xs text-zinc-800 outline-none transition placeholder:text-zinc-400 focus:border-zinc-300 focus:bg-white";

type TempTaskCreateFormProps = {
  /**
   * 提交（上层负责落库 + 建完打开任务详情抽屉）：返回新任务 id（失败 = null）。
   * 成功（id 非空）后表单自动清空；失败保留输入便于重试。
   */
  onCreate: (values: { title: string; titleEn: string }) => Promise<string | null>;
  /** 「取消」回调（不传 = 不渲染取消按钮）。 */
  onCancel?: () => void;
};

/**
 * 「临时任务」新建表单（Push 197 · 业务口径「没有模板 点击后直接新建即可填写任务名称」）：
 * 项目总览底部「临时任务」分组头（TaskBoard）与看板列底「添加 → 临时任务」（TaskKanban）共用 ——
 * 临时任务没有节点 / 模板可挑，点入口后直接填名称（中文必填、英文可留空）；建完由上层直接打开它的详情抽屉补时间等细节。
 * Push 207 收窄（业务口径「临时任务不应该存在于阶段里面新建」）：阶段添加卡片（StageAddCard）那份入口下架，
 * 本表单不再从阶段面板打开。
 * 表单本体只到「输入 + 创建 / 取消」，外框由调用方给（看板列底 / 卡片列表 / 分组头浮层各随所在容器）。
 */
export function TempTaskCreateForm({ onCreate, onCancel }: TempTaskCreateFormProps) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [titleEn, setTitleEn] = useState("");
  const [busy, setBusy] = useState(false);
  /** 中文名必填（与抽屉改名的口径一致）：空名时创建按钮禁用。 */
  const invalid = title.trim() === "";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (invalid || busy) {
      return;
    }
    setBusy(true);
    void onCreate({ title: title.trim(), titleEn: titleEn.trim() })
      .then((createdId) => {
        if (createdId !== null) {
          setTitle("");
          setTitleEn("");
        }
      })
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <form data-temp-task-form="true" aria-label={t("tt.formAria")} onSubmit={submit}>
      <input
        autoFocus
        value={title}
        onChange={(event) => { setTitle(event.target.value); }}
        placeholder={t("tt.name")}
        aria-label={t("tt.nameAria")}
        className={INPUT_CLASS}
      />
      <input
        value={titleEn}
        onChange={(event) => { setTitleEn(event.target.value); }}
        placeholder={t("tt.nameEn")}
        aria-label={t("tt.nameEnAria")}
        className={INPUT_CLASS + " mt-1.5"}
      />
      <div className="mt-2 flex items-center justify-end gap-1.5">
        {onCancel === undefined ? null : (
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-white/70 bg-white/60 px-2 py-1 text-[11px] text-zinc-500 transition hover:border-zinc-300 hover:text-zinc-700"
          >
            {t("common.cancel")}
          </button>
        )}
        <button
          type="submit"
          disabled={invalid || busy}
          className="rounded-lg bg-zinc-900 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-white/60 disabled:text-zinc-400"
        >
          {t("tt.create")}
        </button>
      </div>
    </form>
  );
}
