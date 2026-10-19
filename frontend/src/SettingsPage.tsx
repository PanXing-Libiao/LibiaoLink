import { useState } from "react";
import { AppHeader } from "./components/AppHeader";
import { Toast } from "./components/Toast";
import { WecomBindingGuideContent } from "./components/WecomBindingGuideContent";
import { ProjectGroupBindingPanel } from "./components/ProjectGroupBindingPanel";
import { WecomBindingPanel, type BindingNotice } from "./components/WecomBindingPanel";
import { useT } from "./i18n";
import type { MeResponse } from "./types";

/**
 * 设置页（Push 250 · 业务口径 2026-10-16「在点击用户右上角头像后的列表中添加一个设置页」）。
 *
 * 入口 = 右上角头像菜单首项「企微绑定」（AppHeader；全账号可见，无功能权限键）。地址 `#/settings`
 * （useHashRoute 的 SETTINGS_BASE_HASH 同源），本页为**账号级设置**的首个落点：
 *   ① 企业微信单聊绑定（D5 / D6 · M5-03-5-6 绑定码链路）：绑定态（掩码 + 绑定时间）/ 取绑定码 / 解绑；
 *   ② 项目群绑定：先选项目，再维护该项目唯一群聊的 chatid / 备注 / 激活态（解绑与换绑同页）。
 *   ③ 顶栏的「背景」「语言」「站内信」等仍在顶栏就地设置（本页不重复摆一套）。
 *
 * 页面壳与文件库 / 操作记录一致（AppHeader + main）；写口反馈走顶部浮空 Toast。
 * 未绑定提示（D6）同时落在站内信弹窗（components/InboxPanel），文案与单聊降级站内信前缀一致。
 */
export function SettingsPage({ me }: { me: MeResponse }) {
  const t = useT();
  const [notice, setNotice] = useState<BindingNotice | null>(null);

  return (
    <>
      <AppHeader me={me} />
      <main className="w-full px-6 pb-10 pt-3">
        <div data-settings="" className="w-full max-w-3xl space-y-4">
          <header>
            <h1 className="text-lg font-semibold text-zinc-900">{t("settings.title")}</h1>
            <p className="mt-0.5 text-xs text-zinc-500">{t("settings.subtitle")}</p>
          </header>

          <section
            data-settings-card="wecom-binding"
            className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-6"
          >
            <WecomBindingGuideContent onNotice={setNotice} />
            <div className="mt-4 border-t border-zinc-200/70 pt-4">
              <WecomBindingPanel
                variant="page"
                onNotice={(next) => {
                  setNotice(next);
                }}
              />
            </div>
          </section>

          <section
            data-settings-card="project-group-binding"
            className="rounded-2xl border border-zinc-200 bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] sm:p-6"
          >
            <ProjectGroupBindingPanel onNotice={setNotice} />
          </section>
        </div>
      </main>
      {notice === null ? null : (
        <Toast
          kind={notice.kind}
          text={notice.text}
          onClose={() => {
            setNotice(null);
          }}
        />
      )}
    </>
  );
}
