import { useEffect, useRef, useState } from "react";
import { fetchCadCompanionVersion, fetchProjectFileLibrary, type CadCompanion, type CadInputSelection, type FileLibraryItem } from "../fileApi";

const supported = /\.(dxf|dwg|shx|shp|ttf|otf|png|jpe?g|bmp|gif|tiff?|webp|pdf|dgn|dwf|dwfx|ctb|stb)$/i;
const validPath = (path: string) => path.length > 0 && path.length <= 1024 && !/[\x00-\x1f\x7f:]/.test(path)
  && !path.startsWith("/") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");

export function CadResourcePicker({ projectId, fileId, name, selection, onApply, onClose }: {
  projectId: string; fileId: string; name: string; selection: CadInputSelection;
  onApply: (selection: CadInputSelection) => void; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [files, setFiles] = useState<FileLibraryItem[] | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [mainPath, setMainPath] = useState(selection.mainPath ?? name);
  const [companions, setCompanions] = useState<CadCompanion[]>(selection.companions);
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current!; element.showModal();
    let active = true;
    void fetchProjectFileLibrary(projectId, { statuses: ["draft", "final", "changed", "archived"] }).then((items) => {
      if (active) setFiles(items.filter((item) => item.id !== fileId && supported.test(item.name)));
    }).catch(() => { if (active) setError("项目文件读取失败，请关闭后重试。"); });
    return () => { active = false; element.close(); };
  }, [projectId, fileId]);
  const add = async (file: FileLibraryItem) => {
    if (pending) return;
    setPending(file.id); setError("");
    try {
      const version = await fetchCadCompanionVersion(file.id);
      setCompanions((rows) => [...rows, { fileId: file.id, versionId: version.id, path: file.name }]);
    } catch { setError("无法读取此文件的当前版本，请刷新项目文件后重试。"); }
    finally { setPending(null); }
  };
  const apply = () => {
    const main = mainPath.replaceAll("\\", "/");
    const selected = companions.map((row) => ({ ...row, path: row.path.replaceAll("\\", "/") }));
    const paths = [main, ...selected.map((row) => row.path)];
    if (!paths.every(validPath) || main.split("/").at(-1) !== name || new Set(paths).size !== paths.length) {
      setError("请使用不重复的相对路径，不能包含 .. 或绝对路径；主图路径须保留原文件名。"); return;
    }
    onApply({ mainPath: main, companions: selected });
  };
  const selectedIds = new Set(companions.map((row) => row.fileId));
  const available = (files ?? []).filter((file) => !selectedIds.has(file.id) && file.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <dialog ref={dialog} data-cad-resources className="m-auto max-h-[90dvh] w-[min(720px,94vw)] overflow-y-auto rounded-xl border border-zinc-200 bg-white p-5 text-zinc-900 shadow-2xl backdrop:bg-black/40"
    aria-labelledby="cad-resources-title" onCancel={(event) => { event.preventDefault(); onClose(); }} onClick={(event) => event.stopPropagation()}>
    <div className="mb-3 flex items-center justify-between gap-3"><h2 id="cad-resources-title" className="text-base font-semibold">二维图纸配套文件</h2><button onClick={onClose} className="rounded px-3 py-2 text-sm hover:bg-zinc-100">关闭</button></div>
    <p className="mb-4 text-sm text-zinc-600">从当前项目选择已上传的外部参照、字体、图片、PDF/DWF/DGN 底图或 CTB/STB 打印样式，并填写图纸引用的相对路径。字体支持 SHX、SHP、TTF、OTF。选择会固定到当前文件版本；补齐后重新打开图纸。</p>
    <label className="block text-sm font-medium">主图相对路径<input value={mainPath} onChange={(event) => setMainPath(event.target.value)} className="mt-1 w-full rounded border border-zinc-300 px-3 py-2 font-mono text-sm" /></label>
    <p className="mt-1 text-xs text-zinc-500">例如 drawings/{name}。DWG 参照会记录为未支持；不会自动转换或替换。</p>
    <h3 className="mb-2 mt-5 text-sm font-semibold">已选配套（{companions.length} / 127）</h3>
    {companions.length === 0 ? <p className="text-sm text-zinc-500">尚未选择。可以直接查看主图，缺失内容会在解析范围中标明。</p> : <ul className="space-y-2">{companions.map((row, index) => <li key={row.fileId} className="flex items-center gap-2">
      <label className="min-w-0 flex-1"><span className="sr-only">配套文件 {index + 1} 相对路径</span><input value={row.path} onChange={(event) => setCompanions((rows) => rows.map((item, at) => at === index ? { ...item, path: event.target.value } : item))} className="w-full rounded border border-zinc-300 px-3 py-2 font-mono text-sm" /></label>
      <button aria-label={`移除 ${row.path}`} onClick={() => setCompanions((rows) => rows.filter((_, at) => at !== index))} className="shrink-0 rounded px-3 py-2 text-sm hover:bg-zinc-100">移除</button>
    </li>)}</ul>}
    <label className="mb-2 mt-5 block text-sm font-medium">添加项目文件<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索文件名" className="mt-1 w-full rounded border border-zinc-300 px-3 py-2 text-sm" /></label>
    <div className="max-h-48 overflow-y-auto rounded border border-zinc-200" aria-busy={files === null}>
      {files === null ? <p className="p-3 text-sm text-zinc-500">正在读取项目文件…</p> : available.length === 0 ? <p className="p-3 text-sm text-zinc-500">没有可添加的文件。请先在项目中上传配套文件。</p> : <ul>{available.map((file) => <li key={file.id} className="flex items-center justify-between gap-2 border-b border-zinc-100 px-3 py-2 last:border-0"><span className="min-w-0 break-all text-sm">{file.name}</span><button disabled={pending !== null || companions.length >= 127} onClick={() => void add(file)} className="shrink-0 rounded px-3 py-2 text-sm text-indigo-700 hover:bg-indigo-50 disabled:text-zinc-400">{pending === file.id ? "正在读取…" : "添加"}</button></li>)}</ul>}
    </div>
    {error ? <p role="alert" className="mt-3 text-sm text-red-700">{error}</p> : null}
    <div className="mt-5 flex justify-end gap-2"><button onClick={onClose} className="rounded px-4 py-2 text-sm hover:bg-zinc-100">取消</button><button disabled={pending !== null} onClick={apply} className="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">应用并重新打开</button></div>
  </dialog>;
}
