import { ImportClock, estimateRemaining, HISTORY_LIMIT, MAX_SAMPLE_MS } from './import-progress.js?v=cad-0.21.11';

const $ = id => document.getElementById(id);
const phaseText = {
  'worker-starting': '正在启动模型处理', 'worker-started': '正在启动模型处理', workerEntry: '正在启动模型处理',
  runtimeReady: '正在读取模型数据', parseStart: '正在读取模型数据', sourceReadCompleted: '正在读取模型数据',
  stepReadCompleted: '正在整理零件结构', xcafTransferCompleted: '正在准备模型几何',
  geometryExtractionCompleted: '正在检查模型', revisionCompleted: '正在检查模型', validationCompleted: '正在保存模型结果',
  parseEnd: '正在保存模型结果', serializationCompleted: '正在校验模型结果', workerResultReady: '正在校验模型结果',
};

function isMobileClient() {
  const mobile = globalThis.navigator?.userAgentData?.mobile;
  if (typeof mobile === 'boolean') return mobile;
  return Boolean(globalThis.matchMedia?.('(max-width: 760px)')?.matches);
}

function networkBytesPerSecond() {
  const downlink = Number(globalThis.navigator?.connection?.downlink);
  return Number.isFinite(downlink) && downlink > 0 ? downlink * 1e6 / 8 : 0;
}

function validSample(value) {
  return value && typeof value === 'object' && Number.isFinite(value.totalMs) && value.totalMs > 0 && value.totalMs <= MAX_SAMPLE_MS;
}

function loadHistory(key) {
  try {
    const stored = JSON.parse(globalThis.localStorage?.getItem(key) || '[]');
    return Array.isArray(stored) ? stored.filter(validSample).slice(-HISTORY_LIMIT) : [];
  } catch {
    return [];
  }
}

function formatEta(lowSeconds, highSeconds) {
  if (!Number.isFinite(lowSeconds) || !Number.isFinite(highSeconds)) return '正在估算剩余时间';
  if (highSeconds >= 120) {
    const lowMinutes = Math.max(1, Math.round(lowSeconds / 60));
    const highMinutes = Math.max(lowMinutes + 1, Math.ceil(highSeconds / 60));
    return '预计还需 ' + lowMinutes + '–' + highMinutes + ' 分钟';
  }
  if (lowSeconds <= 0) return '预计最多约 ' + highSeconds + ' 秒';
  if (lowSeconds >= highSeconds) return '预计还需约 ' + highSeconds + ' 秒';
  return '预计还需 ' + lowSeconds + '–' + highSeconds + ' 秒';
}

function estimateBasis(estimate, waiting) {
  if (waiting) return '排队时间不计入处理时间估算';
  if (estimate.source === 'download') return '按当前下载速度和剩余资源估算';
  if (estimate.source === 'history') return '参考同类图纸在本设备的打开记录';
  if (estimate.source === 'build') return '下载已完成，按本机视图构建耗时估算';
  if (estimate.source === 'cached') return '模型已缓存，按资源大小和下载速度估算';
  if (estimate.source === 'cold') return '首次解析，按同类任务的保守范围估算';
  return '正在准备文件与处理任务';
}

export class ImportUI {
  constructor({ fileId, versionId, engineVersion, format }) {
    this.clock = new ImportClock(performance.now()); this.bytes = null; this.artifactBytes = 0; this.stageNumber = 0;
    this.received = 0; this.total = 0; this.finished = false; this.waiting = false; this.reused = false;
    this.fileId = fileId; this.versionId = versionId; this.format = format || 'CAD';
    this.mobile = isMobileClient(); this.networkBytesPerSecond = networkBytesPerSecond();
    this.downloadBps = 0; this.downloadStartedAt = 0; this.buildStartedAt = 0;
    this.historyKey = ['cad-import-time/2', engineVersion, this.format].join('/');
    this.history = loadHistory(this.historyKey);
    document.body.dataset.cadState = 'loading';
    $('viewport').setAttribute('aria-busy', 'true');
    for (const id of ['partsSidebar', 'viewTools', 'selectionTools', 'modelInfo']) $(id).inert = true;
    this.update(0, '正在读取文件');
    this.timer = setInterval(() => this.tick(), 1000);
    window.addEventListener('error', () => { if (!this.finished) this.stop('failed'); }, { once: true });
  }
  context(name) { if (typeof name === 'string') { $('filename').textContent = name; $('filename').title = name; $('loadFilename').textContent = name; } }
  update(stage, text, { queued = false } = {}) {
    if (this.finished) return;
    this.stageNumber = stage; this.waiting = queued; this.clock.queued(queued, performance.now());
    if (stage === 2 && text === '正在生成可交互视图' && !this.buildStartedAt) this.buildStartedAt = performance.now();
    if ($('loadStage').textContent !== text) {
      $('loadStage').textContent = text;
      $('importAnnouncement').textContent = text + '，第 ' + (stage + 1) + ' 步，共 4 步';
    }
    [...$('loadSteps').children].forEach((step, index) => {
      step.dataset.state = index < stage ? 'done' : index === stage ? 'current' : 'next';
      if (index === stage) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
    });
    if (!this.total) {
      $('loadProgress').removeAttribute('value');
      $('loadProgress').setAttribute('aria-label', '模型处理进行中，当前没有可测量的完成百分比');
      $('loadMeasure').textContent = queued ? '等待开始处理' : '第 ' + (stage + 1) + ' 步 / 共 4 步';
    }
    this.tick();
  }
  job(job, { reused = false } = {}) {
    this.bytes = job.sourceByteLength;
    this.artifactBytes = Number.isSafeInteger(job.artifactBytes) && job.artifactBytes > 0 ? job.artifactBytes : this.artifactBytes;
    this.reused = Boolean(reused);
    this.update(1, job.state === 'queued' ? '正在排队，等待处理' : phaseText[job.phase] || '正在处理模型', { queued: job.state === 'queued' });
  }
  downloading(total, { reset = true } = {}) {
    const measured = Number.isSafeInteger(total) && total > 0;
    if (reset || !measured) {
      this.total = measured ? total : 0;
      this.received = 0;
      this.downloadStartedAt = performance.now();
    } else {
      this.total = total;
      this.received = Math.min(this.received, total);
    }
    this.update(2, '正在读取模型视图');
    if (this.total > 0) {
      $('loadProgress').max = this.total;
      $('loadProgress').value = this.received;
      $('loadProgress').setAttribute('aria-label', '模型数据读取进度');
    }
  }
  receive(count) {
    this.received += count;
    const now = performance.now();
    if (this.total && this.received > 0) {
      const elapsed = now - this.downloadStartedAt;
      if (elapsed >= 250) {
        const instant = this.received * 1_000 / elapsed;
        this.downloadBps = this.downloadBps ? this.downloadBps * 0.65 + instant * 0.35 : instant;
      }
    }
    if (!this.total) return;
    $('loadProgress').value = Math.min(this.received, this.total);
    const percent = Math.min(100, Math.floor(this.received / this.total * 100));
    $('loadMeasure').textContent = '读取 ' + percent + '% · ' + (this.received / 1e6).toFixed(1) + ' / ' + (this.total / 1e6).toFixed(1) + ' MB';
  }
  tick() {
    if (this.finished) return;
    const now = performance.now(), elapsed = this.clock.elapsed(now);
    const buildElapsedMS = this.buildStartedAt ? Math.max(0, elapsed - this.clock.elapsed(this.buildStartedAt)) : null;
    const estimate = estimateRemaining({
      bytes: this.bytes, artifactBytes: this.artifactBytes, history: this.history,
      totalBytes: this.total, receivedBytes: this.received, throughputBytesPerSecond: this.downloadBps,
      networkBytesPerSecond: this.networkBytesPerSecond, elapsedMS: elapsed, buildElapsedMS, queued: this.waiting,
      reused: this.reused, mobile: this.mobile, format: this.format, fileId: this.fileId, versionId: this.versionId,
    });
    let text;
    if (estimate.kind === 'queued') text = '开始处理后估算时间';
    else if (estimate.kind === 'pending') text = '读取文件后估算时间';
    else if (estimate.kind === 'overrun') text = '耗时比预计更长，仍在处理中';
    else text = formatEta(estimate.lowSeconds, estimate.highSeconds);
    $('loadEta').textContent = text;
    $('loadElapsed').textContent = '已用 ' + Math.floor(elapsed / 1000) + ' 秒';
    $('loadBasis').textContent = estimateBasis(estimate, this.waiting);
  }
  recordHistory() {
    const totalMs = Math.round(this.clock.elapsed(performance.now()));
    const buildStartedMS = this.buildStartedAt ? Math.round(this.clock.elapsed(this.buildStartedAt)) : null;
    const sample = {
      fileId: this.fileId, versionId: this.versionId, format: this.format,
      bytes: this.bytes, artifactBytes: this.artifactBytes || this.total || null,
      totalMs, buildMs: buildStartedMS === null ? null : Math.max(0, totalMs - buildStartedMS),
      kind: this.reused ? 'cached' : 'converted', mobile: this.mobile, at: Date.now(),
    };
    if (!validSample(sample)) return;
    const next = [...loadHistory(this.historyKey), sample].slice(-HISTORY_LIMIT);
    this.history = next;
    try { globalThis.localStorage?.setItem(this.historyKey, JSON.stringify(next)); } catch { /* Storage may be unavailable; viewing does not depend on it. */ }
  }
  stop(state, { retryable = true } = {}) {
    this.finished = true; clearInterval(this.timer); document.body.dataset.cadState = state;
    $('viewport').setAttribute('aria-busy', 'false');
    $('sessionStatus').textContent = state === 'ready' ? '已就绪' : state === 'cancelled' ? '已取消' : state === 'unsupported' ? '暂不支持预览' : '未打开';
    $('importAnnouncement').textContent = state === 'ready' ? '模型已就绪，可以操作' : state === 'cancelled' ? '已取消导入' : state === 'unsupported' ? '暂不支持在线预览' : '模型未能打开';
    if (state === 'ready') {
      this.recordHistory();
      for (const id of ['partsSidebar', 'viewTools', 'selectionTools', 'modelInfo']) $(id).inert = false;
      document.querySelector('.treehead strong').textContent = '零件结构';
      $('showAll').textContent = '全部显示';
      $('filename').title = $('filename').textContent;
    } else if (state === 'cancelled') {
      $('error').hidden = false; $('error').textContent = '已取消导入，需要时可以重新打开模型。';
    }
    $('retryActions').hidden = state === 'ready' || !retryable;
    if (state !== 'ready') $(retryable ? 'retryImport' : 'closeViewer').focus();
  }
  destroy() { clearInterval(this.timer); }
}
