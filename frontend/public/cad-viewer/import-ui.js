import { ImportClock, estimateRemaining } from './import-progress.js';

const $ = id => document.getElementById(id);
const phaseText = {
  'worker-starting': '正在启动模型处理', 'worker-started': '正在启动模型处理', workerEntry: '正在启动模型处理',
  runtimeReady: '正在读取模型数据', parseStart: '正在读取模型数据', sourceReadCompleted: '正在读取模型数据',
  stepReadCompleted: '正在整理零件结构', xcafTransferCompleted: '正在准备模型几何',
  geometryExtractionCompleted: '正在检查模型', revisionCompleted: '正在检查模型', validationCompleted: '正在保存模型结果',
  parseEnd: '正在保存模型结果', serializationCompleted: '正在校验模型结果', workerResultReady: '正在校验模型结果',
};

export class ImportUI {
  constructor({ fileId, versionId, engineVersion }) {
    this.clock = new ImportClock(performance.now()); this.bytes = null; this.stageNumber = 0;
    this.received = 0; this.total = 0; this.finished = false; this.waiting = false;
    this.key = ['cad-import-time/1', engineVersion, fileId, versionId].join('/');
    try { const stored = JSON.parse(sessionStorage.getItem(this.key) || '[]'); this.history = Array.isArray(stored) ? stored.filter(n => Number.isFinite(n) && n > 0 && n <= 1_200_000).slice(-3) : []; }
    catch { this.history = []; }
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
    if ($('loadStage').textContent !== text) {
      $('loadStage').textContent = text;
      $('importAnnouncement').textContent = `${text}，第 ${stage + 1} 步，共 4 步`;
    }
    [...$('loadSteps').children].forEach((step, index) => {
      step.dataset.state = index < stage ? 'done' : index === stage ? 'current' : 'next';
      if (index === stage) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
    });
    if (!this.total) {
      $('loadProgress').removeAttribute('value');
      $('loadProgress').setAttribute('aria-label', '模型处理进行中，当前没有可测量的完成百分比');
      $('loadMeasure').textContent = queued ? '等待开始处理' : `第 ${stage + 1} 步 / 共 4 步`;
    }
    this.tick();
  }
  job(job) {
    this.bytes = job.sourceByteLength;
    this.update(1, job.state === 'queued' ? '正在排队，等待处理' : phaseText[job.phase] || '正在处理模型', { queued: job.state === 'queued' });
  }
  downloading(total) {
    this.total = total; this.received = 0;
    this.update(2, '正在读取模型视图');
    if (total > 0) { $('loadProgress').max = total; $('loadProgress').value = 0; $('loadProgress').setAttribute('aria-label', '模型数据读取进度'); }
  }
  receive(count) {
    this.received += count;
    if (!this.total) return;
    $('loadProgress').value = Math.min(this.received, this.total);
    const percent = Math.min(100, Math.floor(this.received / this.total * 100));
    $('loadMeasure').textContent = `读取 ${percent}% · ${(this.received / 1e6).toFixed(1)} / ${(this.total / 1e6).toFixed(1)} MB`;
  }
  tick() {
    if (this.finished) return;
    const now = performance.now(), elapsed = this.clock.elapsed(now);
    const estimate = estimateRemaining({ bytes: this.bytes, history: this.history, elapsedMS: elapsed, queued: this.waiting });
    let text;
    if (estimate.kind === 'queued') text = '开始处理后估算时间';
    else if (estimate.kind === 'pending') text = '读取文件后估算时间';
    else if (estimate.kind === 'overrun') text = '耗时比预计更长，仍在处理中';
    else text = estimate.lowSeconds >= estimate.highSeconds || estimate.lowSeconds === 0 ? `预计还需约 ${estimate.highSeconds} 秒` : `预计还需 ${estimate.lowSeconds}–${estimate.highSeconds} 秒`;
    $('loadEta').textContent = text;
    $('loadElapsed').textContent = `已用 ${Math.floor((now - this.clock.start) / 1000)} 秒`;
    $('loadBasis').textContent = this.waiting ? '排队时间不计入处理时间估算' : this.history.length ? '参考此文件之前在本标签页的打开用时' : this.bytes ? '首次打开，按文件大小粗略估算' : '正在准备文件与处理任务';
  }
  stop(state, { retryable = true } = {}) {
    this.finished = true; clearInterval(this.timer); document.body.dataset.cadState = state;
    $('viewport').setAttribute('aria-busy', 'false');
    $('sessionStatus').textContent = state === 'ready' ? '已就绪' : state === 'cancelled' ? '已取消' : '未打开';
    $('importAnnouncement').textContent = state === 'ready' ? '模型已就绪，可以操作' : state === 'cancelled' ? '已取消导入' : '模型未能打开';
    if (state === 'ready') {
      for (const id of ['partsSidebar', 'viewTools', 'selectionTools', 'modelInfo']) $(id).inert = false;
      try { sessionStorage.setItem(this.key, JSON.stringify([...this.history.filter(n => Number.isFinite(n) && n > 0), this.clock.elapsed(performance.now())].slice(-3))); }
      catch { /* Storage may be unavailable; viewing does not depend on it. */ }
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
