const $ = id => document.getElementById(id);
const phaseText = {
  'worker-starting': '正在启动模型处理', reading: '正在读取文件', persisting: '正在保存模型结果', 'worker-started': '正在转换模型', workerEntry: '正在启动模型处理',
  runtimeReady: '正在读取模型数据', parseStart: '正在读取模型数据', sourceReadCompleted: '正在读取模型数据',
  stepReadCompleted: '正在整理零件结构', xcafTransferCompleted: '正在准备模型几何',
  geometryExtractionCompleted: '正在检查模型', revisionCompleted: '正在检查模型', validationCompleted: '正在保存模型结果',
  parseEnd: '正在保存模型结果', serializationCompleted: '正在校验模型结果', workerResultReady: '正在校验模型结果',
};

export class ImportUI {
  constructor(openedAt) {
    this.openedAt = openedAt > 0 ? openedAt : performance.timeOrigin;
    this.finished = false;
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
    if ($('loadStage').textContent !== text) {
      $('loadStage').textContent = text;
      $('importAnnouncement').textContent = text + '，第 ' + (stage + 1) + ' 步，共 4 步';
    }
    [...$('loadSteps').children].forEach((step, index) => {
      step.dataset.state = index < stage ? 'done' : index === stage ? 'current' : 'next';
      if (index === stage) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
    });
    $('loadProgress').removeAttribute('value');
    $('loadProgress').setAttribute('aria-label', '模型处理进行中，当前没有可测量的完成百分比');
    $('loadMeasure').textContent = queued ? '等待开始处理' : '第 ' + (stage + 1) + ' 步 / 共 4 步';
    this.tick();
  }
  job(job) {
    const behindDrawing = job.phase === 'waiting-for-drawing';
    const queued = behindDrawing || job.state === 'queued' || job.phase === 'queue-entered';
    const text = behindDrawing ? '前面有图纸正在处理，轮到这张图时会自动转换并显示。'
      : queued ? '正在等待开始转换' : phaseText[job.phase] || '正在处理模型';
    this.update(1, text, { queued });
    return text;
  }
  downloadProgress(received, total) {
    if (!total || this.finished) return;
    const progress = $('loadProgress');
    progress.max = total;
    progress.value = received;
    progress.setAttribute('aria-label', '模型数据读取进度');
    $('loadMeasure').textContent = '读取 ' + Math.floor(received / total * 100) + '% · ' +
      (received / 1e6).toFixed(1) + ' / ' + (total / 1e6).toFixed(1) + ' MB';
  }
  tick() {
    const elapsed = performance.timeOrigin + performance.now() - this.openedAt;
    $('loadElapsed').textContent = '已用 ' + Math.max(0, Math.floor(elapsed / 1000)) + ' 秒';
  }
  stop(state, { retryable = true } = {}) {
    this.finished = true; clearInterval(this.timer); document.body.dataset.cadState = state;
    $('viewport').setAttribute('aria-busy', 'false');
    $('sessionStatus').textContent = state === 'ready' ? '已就绪' : state === 'cancelled' ? '已取消' : state === 'unsupported' ? '暂不支持预览' : '未打开';
    $('importAnnouncement').textContent = state === 'ready' ? '模型已就绪，可以操作' : state === 'cancelled' ? '已取消导入' : state === 'unsupported' ? '暂不支持在线预览' : '模型未能打开';
    if (state === 'ready') {
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
