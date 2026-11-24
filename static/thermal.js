'use strict';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const state = {config: {}, mode: 'cold', panel: null, draft: null, report: null, archive: null,
  selection: null, tool: null, start: null, image: null, contextOpen: false, windowOptions: null};
const numeric = ['gain', 'offset', 'mm_per_pixel', 'show_lo', 'show_hi', 'delta', 'min_area', 'bins'];
const palettes = {
  iron: '#15162f,#511a61,#a02866,#df5450,#ffad64,#fff2bc',
  gray: '#15182a,#f7f7ed', cool: '#253e73,#478ba6,#71bcac,#e4e7aa'
};
const tools = {inspect: '检查区', reference: '参考区', trace: '剖线'};
let busy = false;

function node(tag, text, attrs = {}) {
  const el = document.createElement(tag);
  if (text !== null) el.textContent = text;
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  return el;
}

function graphic(tag, attrs, text) {
  const el = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  if (text !== undefined) el.textContent = text;
  return el;
}

function status(message, error = false) {
  const target = state.panel ? $('status') : $('empty').querySelector('p');
  target.textContent = message;
  target.dataset.error = error;
}

function action(fn) {
  return async event => {
    if (busy) return;
    busy = true;
    try {
      await fn(event);
    } catch (error) {
      status(error.message || '操作未完成，请重试。', true);
    } finally {
      busy = false;
    }
  };
}

async function api(path, method = 'GET', value, type = 'json') {
  const options = {method};
  if (value instanceof FormData) options.body = value;
  else if (value !== undefined) {
    options.body = JSON.stringify(value);
    options.headers = {'Content-Type': 'application/json'};
  }
  const response = await fetch('/thermal' + path, options);
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw Error(detail.error || '服务没有返回热图结果。');
  }
  return response[type]();
}

const panelPath = () => '/panels/' + state.panel.id;
const shown = () => state.archive || state.report;
const format = value => value ?? '—';

function formSettings() {
  const draft = {...state.draft, palette: $('palette').value};
  for (const name of numeric) {
    const value = $(name).valueAsNumber;
    if (!Number.isFinite(value)) throw Error('请填写完整的数字设置。');
    draft[name] = value;
  }
  return draft;
}

function showFields() {
  for (const name of numeric) $(name).value = state.draft[name];
  $('palette').value = state.draft.palette;
  const saved = state.draft.reference_window;
  $('window-side').value = saved ? saved.side_mm : '';
}

function sourcePosition(event) {
  const map = $('map');
  const matrix = map.getScreenCTM();
  if (!matrix) return;
  const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  const {width, height} = state.panel;
  return [Math.max(0, Math.min(width - 1, Math.floor(p.x))),
    Math.max(0, Math.min(height - 1, Math.floor(p.y)))];
}

function boxDrawing(box, stroke, dash) {
  const [x, y, x1, y1] = box;
  return graphic('rect', {x, y, width: x1 - x, height: y1 - y, fill: 'none', stroke,
    'stroke-width': 1.7, 'stroke-dasharray': dash, 'vector-effect': 'non-scaling-stroke'});
}

function drawThermogram() {
  const result = shown();
  const settings = result.settings;
  const {width, height} = state.panel;
  const map = $('map');
  map.setAttribute('viewBox', `0 0 ${width} ${height}`);
  map.style.aspectRatio = `${width} / ${height}`;
  map.classList.toggle('drawing', !!state.tool);
  const nodes = [graphic('image', {href: state.image, width, height}),
    boxDrawing(settings.inspect, '#f3e4c8', '6 4'), boxDrawing(settings.reference, '#72e4cf', '6 4')];
  const windowBox = settings.reference_window?.box;
  if (windowBox) {
    const rect = boxDrawing(windowBox, '#ffd166', '0');
    rect.setAttribute('stroke-width', 2.4);
    nodes.push(rect);
  }
  if (result.mode === 'profile') {
    const [x1, y1, x2, y2] = settings.trace.map(value => value + .5);
    nodes.push(graphic('line', {x1, y1, x2, y2, stroke: '#f7e976', 'stroke-width': 1.8,
      'vector-effect': 'non-scaling-stroke'}));
  }
  if (result.mode === 'cold') {
    result.rows.forEach((row, index) => {
      nodes.push(boxDrawing(row.box, index === state.selection ? '#82f2d5' : '#fff9ec', '0'));
    });
  }
  const point = result.rows[state.selection]?.point;
  if (point) {
    const [x, y] = point.map(value => value + .5);
    nodes.push(graphic('circle', {cx: x, cy: y, r: Math.max(2, Math.min(width, height) / 65),
      fill: 'none', stroke: '#8bf4dc', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke'}));
  }
  if (state.start) {
    nodes.push(graphic('circle', {cx: state.start[0] + .5, cy: state.start[1] + .5,
      r: Math.max(2, Math.min(width, height) / 85), fill: '#f7e976'}));
  }
  map.replaceChildren(...nodes);
  $('low').textContent = settings.show_lo + ' °C';
  $('high').textContent = settings.show_hi + ' °C';
  $('ramp').style.background = `linear-gradient(0deg,${palettes[settings.palette]})`;
  $('map-note').textContent = point ? `源热图像素 (${point.join(', ')})`
    : state.tool ? `${tools[state.tool]} · 点选${state.start ? '另一端' : '起点'}`
      : windowBox ? '浅色虚框为检查区，绿色虚框为参考区，黄色实框为参考方窗。'
        : '浅色虚框为检查区，绿色虚框为参考区。';
}

function drawContext() {
  const detail = state.archive ? state.archive.context : state.panel.context;
  $('show-context').disabled = !detail;
  $('show-context').textContent = state.contextOpen && detail ? '收起现场底图' : '看现场底图';
  $('context').hidden = !detail || !state.contextOpen;
  if (!detail || !state.contextOpen) return;
  const suffix = state.archive ? '?check=' + state.archive.id : '?v=' + detail.source;
  $('context-image').src = '/thermal' + panelPath() + '/context.png' + suffix;
  $('context-title').textContent = detail.title;
}

function chartPoints(result) {
  const temps = result.rows.filter(row => row.temperature !== null).map(row => row.temperature);
  if (!temps.length) return [];
  const bottom = Math.min(...temps);
  const top = Math.max(...temps);
  const span = top === bottom ? 1 : top - bottom;
  return result.rows.map(row => ({
    x: 44 + 697 * row.distance / (result.meta.length || 1),
    y: row.temperature === null ? null : 107 - 83 * (row.temperature - bottom) / span
  }));
}

function drawChart(result) {
  const chart = $('chart');
  chart.toggleAttribute('hidden', result.mode !== 'profile');
  if (chart.hasAttribute('hidden')) return;
  const points = chartPoints(result);
  let path = '';
  let ongoing = false;
  for (const p of points) {
    if (p.y === null) ongoing = false;
    else {
      path += `${ongoing ? 'L' : 'M'}${p.x.toFixed(2)} ${p.y.toFixed(2)} `;
      ongoing = true;
    }
  }
  const children = [
    graphic('path', {d: 'M44 15V116H741', stroke: '#7b726f', fill: 'none'}),
    graphic('text', {x: 10, y: 23}, '°C'),
    graphic('text', {x: 44, y: 136}, '0'),
    graphic('text', {x: 741, y: 136, 'text-anchor': 'end'}, result.meta.length + ' mm'),
    graphic('path', {class: 'trend', d: path})
  ];
  const marker = points[state.selection];
  if (marker?.y !== null && marker !== undefined) {
    children.push(graphic('circle', {cx: marker.x, cy: marker.y, r: 4, fill: '#8bf4dc'}));
  }
  chart.replaceChildren(...children);
}

function summary(result) {
  const meta = result.meta;
  if (result.mode === 'cold') {
    if (meta.reference === null) return '参考区没有有效像素，未划分低温区。';
    const omitted = meta.omitted ? ` · 另有 ${meta.omitted} 个更小区未列表` : '';
    const source = meta.reference_window
      ? `参考方窗（边长 ${meta.reference_window.side_mm} mm · 覆盖 ${meta.reference_coverage}%）中位 ${meta.reference} °C`
      : meta.window_fallback
        ? '参考方窗已不达标，已退回整块参考区；参考中位'
        : '参考中位';
    const reserved = meta.reserved_pixels
      ? ` · 窗内与检查区重叠的 ${meta.reserved_pixels} px 留给参照，未计入低温区` : '';
    return `${source}${meta.window_fallback ? ` ${meta.reference} °C` : ''} · 低温门槛 ${meta.threshold} °C${reserved}${omitted}`;
  }
  if (result.mode === 'profile') return `剖线 ${meta.length} mm · 有效样点 ${meta.valid} / ${result.rows.length}`;
  if (result.mode === 'distribution') return `有效像素 ${meta.valid} · 缺测 ${meta.missing}`;
  return result.mode === 'reference' ? '参考区读数用于设定低温门槛。' : '面积按原图有效读数与当前长度标尺计算。';
}

function select(index, scroll) {
  state.selection = index;
  $('rows').querySelectorAll('tr[aria-selected=true]').forEach(row => row.setAttribute('aria-selected', 'false'));
  const row = $('rows').children[index];
  row.setAttribute('aria-selected', 'true');
  if (scroll) row.scrollIntoView({block: 'nearest'});
  drawThermogram();
  drawChart(shown());
}

function drawReport() {
  const result = shown();
  $('result-heading').textContent = result.heading;
  $('readings').textContent = summary(result);
  const header = node('tr', null);
  for (const value of Object.values(result.columns)) header.append(node('th', value, {scope: 'col'}));
  $('columns').replaceChildren(header);
  $('rows').replaceChildren(...result.rows.map((row, index) => {
    const tr = node('tr', null);
    for (const key of Object.keys(result.columns)) tr.append(node('td', format(row[key])));
    if (row.point) {
      tr.setAttribute('data-point', row.point.join(','));
      tr.setAttribute('tabindex', '0');
      tr.setAttribute('aria-selected', String(index === state.selection));
      tr.onclick = () => select(index, false);
      tr.onkeydown = event => { if (event.key === 'Enter') select(index, false); };
    }
    return tr;
  }));
  $('no-readings').hidden = !!result.rows.length;
  drawChart(result);
}

function render() {
  const result = shown();
  const isArchive = !!state.archive;
  $('title').textContent = state.panel.title;
  const kind = state.panel.provenance.kind === 'synthetic' ? '合成练习' : state.panel.filename;
  $('origin').textContent = `${kind} · ${state.panel.width} × ${state.panel.height} px`;
  $('empty').hidden = true;
  $('desk').hidden = false;
  $('controls').hidden = isArchive;
  $('cold-settings').hidden = result.mode !== 'cold';
  $('window-settings').hidden = result.mode !== 'cold' || isArchive;
  $('distribution-settings').hidden = result.mode !== 'distribution';
  $('return-live').hidden = !isArchive;
  $('save').hidden = isArchive;
  $('downloads').hidden = !isArchive;
  const base = '/thermal' + panelPath();
  $('raw').href = base + '/raw.png';
  $('prepare-link').href = '/prepare?panel=' + encodeURIComponent(state.panel.id);
  if (isArchive) {
    $('csv').href = base + '/checks/' + state.archive.id + '/report.csv';
    $('overlay').href = base + '/checks/' + state.archive.id + '/overlay.png';
  }
  for (const button of $('measure-tools').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.tool === state.tool));
  }
  for (const button of $('modes').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === result.mode));
  }
  drawThermogram();
  drawContext();
  drawReport();
  renderWindowPanel();
}

const WINDOW_TAGS = {near: '贴近检查区', uniform: '温度更均匀'};

function renderWindowPanel() {
  const panel = $('window-settings');
  if (panel.hidden) return;
  const result = shown();
  const active = result.settings.reference_window;
  const meta = result.meta || {};
  const activeBox = $('window-active');
  activeBox.hidden = !active;
  $('window-clear').hidden = !active;
  if (active) {
    activeBox.classList.toggle('fallback', !!meta.window_fallback);
    const reserved = meta.reserved_pixels
      ? ` 重叠区内 ${meta.reserved_pixels} px 留给参照，不计入低温区。` : '';
    activeBox.textContent = meta.window_fallback
      ? `已保存的方窗覆盖不足九成或移出参考区，本次已退回整块参考区判读，请重新推荐方窗。`
      : `当前参考：${WINDOW_TAGS[active.choice] || '已采用方窗'} · 边长 ${active.side_mm} mm · `
        + `中位 ${active.median} °C · 覆盖 ${meta.reference_coverage ?? '—'}%。${reserved}`;
  }
  const holder = $('window-candidates');
  const options = state.windowOptions;
  if (!options || options.settings_key !== JSON.stringify(result.settings)) {
    holder.replaceChildren();
    return;
  }
  holder.replaceChildren();
  if (!options.candidates.length) {
    holder.append(node('p', options.message || '没有合格方窗，继续使用整块参考区的判读。', {class: 'window-note'}));
    return;
  }
  if (options.message) holder.append(node('p', options.message, {class: 'window-reason'}));
  for (const candidate of options.candidates) {
    const card = node('article', null,
      {class: 'window-card' + (candidate.choice === options.recommended ? ' recommended' : '')});
    card.append(node('h4',
      (candidate.choice === options.recommended ? '推荐 · ' : '') + WINDOW_TAGS[candidate.choice]));
    card.append(node('p',
      `边长 ${options.actual_side_mm} mm（${options.side_px} px）· 覆盖 ${candidate.coverage}% · `
      + `距检查区 ${candidate.gap_mm} mm`, {class: 'window-stats'}));
    card.append(node('p',
      `中位 ${candidate.median} °C · 最低 ${candidate.min} °C · 最高 ${candidate.max} °C · 标准差 ${candidate.std} °C`,
      {class: 'window-stats'}));
    const adopted = active && JSON.stringify(active.box) === JSON.stringify(candidate.box);
    const adopt = node('button', adopted ? '已采用' : '采用此方窗');
    adopt.disabled = adopted;
    adopt.onclick = action(() => adoptWindow(candidate, options));
    const actions = node('div', null, {class: 'actions'});
    actions.append(adopt);
    card.append(actions);
    holder.append(card);
  }
}

async function recommendWindows() {
  const side = $('window-side').valueAsNumber;
  if (!Number.isFinite(side) || side <= 0) throw Error('请输入方窗的实际边长（毫米）。');
  const settings = formSettings();
  const options = await api(panelPath() + '/windows', 'POST', {settings, side_mm: side});
  options.settings_key = JSON.stringify(settings);
  state.windowOptions = options;
  renderWindowPanel();
  if (!options.candidates.length) status(options.message || '没有合格方窗。');
  else status(options.message);
}

async function adoptWindow(candidate, options) {
  const settings = formSettings();
  settings.reference_window = {
    box: candidate.box, side_mm: options.side_mm,
    choice: candidate.choice, median: candidate.median
  };
  state.windowOptions = null;
  await refresh(settings);
  status('已采用参考方窗，低温区按方窗有效温度中位数重新划区。');
}

async function clearWindow() {
  const settings = formSettings();
  settings.reference_window = null;
  state.windowOptions = null;
  await refresh(settings);
  status('已改用整块参考区判读。');
}

async function loadLibrary() {
  const panels = await api('/panels');
  const buttons = panels.map(panel => {
    const label = node('button', panel.title, {'aria-pressed': String(panel.id === state.panel?.id)});
    label.append(node('small', `${panel.width} × ${panel.height} px`));
    label.onclick = action(() => openPanel(panel));
    return label;
  });
  $('library').replaceChildren(...(buttons.length ? buttons : [node('small', '尚无热图')]));
  return panels;
}

function loadArchive() {
  const buttons = state.panel.checks.map(check => {
    const button = node('button', check.heading, {'aria-pressed': String(check.id === state.archive?.id)});
    button.append(node('small', new Date(check.created).toLocaleString('zh-CN')));
    button.onclick = action(async () => {
      const next = await api(panelPath() + '/checks/' + check.id);
      await getImage(next.settings);
      state.archive = next;
      state.selection = state.tool = state.start = null;
      loadArchive();
      render();
    });
    return button;
  });
  $('archive').replaceChildren(...(buttons.length ? buttons : [node('small', '尚无检查存档')]));
}

async function getImage(settings) {
  const blob = await api(panelPath() + '/view.png', 'POST', {settings}, 'blob');
  if (state.image) URL.revokeObjectURL(state.image);
  state.image = URL.createObjectURL(blob);
}

async function refresh(next = state.draft, mode = state.mode) {
  const report = await api(panelPath() + '/preview', 'POST', {settings: next, mode});
  await getImage(report.settings);
  state.draft = report.settings;
  state.mode = mode;
  state.archive = null;
  state.report = report;
  state.selection = null;
  state.windowOptions = null;
  showFields();
  loadArchive();
  render();
}

async function openPanel(panel) {
  state.panel = panel;
  state.draft = structuredClone(panel.settings);
  state.mode = 'cold';
  state.archive = state.tool = state.start = null;
  state.contextOpen = false;
  localStorage.setItem('thermal-survey-panel', panel.id);
  await refresh();
  await loadLibrary();
  status('');
}

function upload(set, key) {
  const data = new FormData();
  data.append('file', set.files[0]);
  if (key === 'context') data.append('revision', state.panel.revision);
  return data;
}

$('sample').onclick = action(async () => {
  await openPanel(await api('/demo', 'POST', {}));
  status('已打开合成热图。');
});

$('upload').onchange = action(async () => {
  if (!$('upload').files.length) return;
  const data = upload($('upload'), 'thermal');
  $('upload').value = '';
  await openPanel(await api('/panels', 'POST', data));
  status('已导入源热图。');
});

$('upload-context').onchange = action(async () => {
  if (!$('upload-context').files.length) return;
  const data = upload($('upload-context'), 'context');
  $('upload-context').value = '';
  state.panel = await api(panelPath() + '/context', 'POST', data);
  state.contextOpen = true;
  drawContext();
  status('已添加现场底图。');
});

$('show-context').onclick = () => {
  state.contextOpen = !state.contextOpen;
  drawContext();
};
$('refresh').onclick = action(async () => {
  await refresh(formSettings());
  status('已更新读数。');
});
$('retain').onclick = action(async () => {
  const settings = formSettings();
  state.panel = await api(panelPath() + '/settings', 'PUT', {revision: state.panel.revision, settings});
  await refresh(state.panel.settings);
  status('已保留标定和测温范围。');
});
$('save').onclick = action(async () => {
  const saved = await api(panelPath() + '/checks', 'POST',
    {revision: state.panel.revision, mode: state.mode, settings: formSettings()});
  await getImage(saved.check.settings);
  state.panel = saved.panel;
  state.archive = saved.check;
  state.selection = state.tool = state.start = null;
  loadArchive();
  render();
});
$('return-live').onclick = action(() => refresh());
$('palette').onchange = action(() => refresh(formSettings()));
$('window-find').onclick = action(recommendWindows);
$('window-clear').onclick = action(clearWindow);
$('window-side').onkeydown = event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    action(recommendWindows)();
  }
};

$('measure-tools').querySelectorAll('button').forEach(button => {
  button.onclick = () => {
    state.tool = state.tool === button.dataset.tool ? null : button.dataset.tool;
    state.start = null;
    render();
  };
});
$('map').onclick = action(async event => {
  if (!state.tool || state.archive) return;
  const point = sourcePosition(event);
  if (!point) return;
  if (!state.start) {
    state.start = point;
    drawThermogram();
    return;
  }
  const [x0, y0] = state.start;
  const [x1, y1] = point;
  const tool = state.tool;
  const geometry = tool === 'trace' ? [x0, y0, x1, y1]
    : [Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1) + 1, Math.max(y0, y1) + 1];
  await refresh({...formSettings(), [tool]: geometry});
  state.tool = state.start = null;
  render();
  status(`已更新${tools[tool]}。`);
});

$('chart').onclick = event => {
  const result = shown();
  const matrix = $('chart').getScreenCTM();
  if (!result || !matrix) return;
  const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  const fraction = Math.max(0, Math.min(1, (p.x - 44) / 697));
  select(Math.round(fraction * (result.rows.length - 1)), true);
};

action(async () => {
  state.config = await api('/config');
  $('modes').replaceChildren(...Object.entries(state.config.modes).map(([mode, label]) => {
    const button = node('button', label, {'data-mode': mode, 'aria-pressed': 'false'});
    button.onclick = action(() => refresh(formSettings(), mode));
    return button;
  }));
  const panels = await loadLibrary();
  if (panels.length) {
    const saved = localStorage.getItem('thermal-survey-panel');
    await openPanel(panels.find(panel => panel.id === saved) || panels[0]);
  }
})();
