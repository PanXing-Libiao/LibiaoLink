// Original File bytes remain Blobs; paths are logical names within this upload.
export function resourcePackage(main, resources) {
  const files = new Map(resources);
  files.set(main.name, main);
  if (files.size > 128) throw new Error('主图与配套文件合计最多 128 份');
  if ([...files.values()].reduce((sum, file) => sum + file.size, 0) > 64 * 1024 * 1024) throw new Error('主图与配套文件合计超过 64 MiB');
  const ordered = [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const header = new TextEncoder().encode(JSON.stringify({version: 'dxf-resources/1', main: main.name,
    files: ordered.map(([path, file]) => ({path, byteLength: file.size}))}));
  if (header.length > 128 * 1024) throw new Error('配套文件路径信息过大');
  const prefix = new Uint8Array(12);
  prefix.set(new TextEncoder().encode('DXFRES1\n'));
  new DataView(prefix.buffer).setUint32(8, header.length, true);
  return new Blob([prefix, header, ...ordered.map(([, file]) => file)], {type: 'application/vnd.cad.dxf-resources'});
}

export function collectResources(previous, files, directory = false) {
  const resources = new Map(previous);
  const selected = new Set();
  for (const file of files) {
    if (!/\.(dxf|dwg|shx|shp|ttf|otf|png|jpe?g|bmp|gif|tiff?|webp|pdf|dgn|dwf|dwfx|ctb|stb)$/i.test(file.name)) continue;
    const path = directory ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
    if (selected.has(path || file.name)) throw new Error('本次选择有同名路径，请改用文件夹方式保留各自目录');
    selected.add(path || file.name);
    resources.set(path || file.name, file);
  }
  return resources;
}
