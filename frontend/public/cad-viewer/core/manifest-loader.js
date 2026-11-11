import {applyManifestEntries} from './manifest-parts.js?v=direct-1';
import {decodeManifestBytes} from './manifest-decode.js?v=direct-1';

const WORKER_BYTES = 1024 * 1024;
const createWorker = url => new Worker(url, {type:'module'});

export async function decodeManifest(bytes, {signal, workerFactory=createWorker} = {}) {
  signal?.throwIfAborted();
  const started = performance.now();
  if (bytes.byteLength < WORKER_BYTES) {
    const result = await decodeManifestBytes(bytes);
    return {...result, timing:{...result.timing, execution:'main', totalMS:performance.now()-started}};
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const result = await decodeInWorker(bytes, signal, workerFactory, attempt);
      return {...result, timing:{...result.timing, execution:'worker', totalMS:performance.now()-started}};
    } catch (error) {
      signal?.throwIfAborted();
      if (attempt !== 1 || error.cause?.phase !== 'worker-start') throw error;
    }
  }
}

function decodeInWorker(bytes, signal, workerFactory, attempt) {
  return new Promise((resolve, reject) => {
    const url = new URL('./manifest-worker.js?v=start-1', import.meta.url);
    if (attempt > 1) url.searchParams.set('retry', String(attempt));
    const worker = workerFactory(url);
    let settled = false, transferred = false, packet;
    function finish(error, result) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (error) reject(error);
      else resolve(result);
    }
    const abort = () => finish(signal.reason);
    worker.onmessage = ({data}) => {
      if (settled) return;
      if (signal?.aborted) { abort(); return; }
      try {
        if (data.kind === 'ready') {
          // Keep ownership until the module and its imports are running.
          worker.postMessage(bytes, [bytes]);
          transferred = true;
          return;
        }
        if (data.kind === 'error') throw new Error('模型数据展开失败，请重试或下载原文件');
        if (data.kind === 'done') {
          if (packet?.curvePens) delete packet.curvePens;
          finish(null, {packet, timing:data.timing});
          return;
        }
        if (data.kind === 'header') packet = data.packet;
        else if (data.kind === 'entries') applyManifestEntries(packet, data);
        else throw new Error('模型数据处理消息无效');
        worker.postMessage('next');
      } catch (error) { finish(error); }
    };
    worker.onerror = event => {
      if (settled) return;
      event.preventDefault?.();
      const cause = {
        phase: transferred ? 'worker-decode' : 'worker-start',
        attempt, viewId:new URLSearchParams(globalThis.location?.search).get('viewId'), workerScript:url.href, message:event.message, filename:event.filename,
        line:event.lineno, column:event.colno,
      };
      console.warn('[cad-manifest-worker]', cause);
      finish(new Error('模型数据处理线程失败，请重试或下载原文件', {cause}));
    };
    worker.onmessageerror = () => finish(new Error('模型数据传输失败，请重试或下载原文件'));
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) { abort(); return; }
    try { worker.postMessage('start'); } catch (error) { finish(error); }
  });
}
