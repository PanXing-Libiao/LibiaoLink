import {parentPort} from 'node:worker_threads';
globalThis.self={postMessage:data=>parentPort.postMessage(data)};
await import('../../../../frontend/public/cad-viewer/core/manifest-worker.js');
parentPort.on('message',data=>self.onmessage({data}));
