'use strict';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const state = {config: {}, mode: 'cold', panel: null, draft: null, report: null, archive: null,
  selection: null, tool: null, start: null, image: null, contextOpen: false,
  panels: [], baseline: null, view: 'after', probes: []};
const numeric = ['gain', 'offset', 'mm_per_pixel', 'show_lo', 'show_hi', 'delta', 'warm_delta', 'min_area', 'bins'];
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
const probing = () => state.archive?.mode === 'warm' && !!state.archive.baseline;

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
  map.classList.toggle('drawing', !!state.tool || probing());
  const nodes = [graphic('image', {href: state.image, width, height}),
    boxDrawing(settings.inspect, '#f3e4c8', '6 4'), boxDrawing(settings.reference, '#72e4cf', '6 4')];
  if (result.mode === 'profile') {
    const [x1, y1, x2, y2] = settings.trace.map(value => value + .5);
    nodes.push(graphic('line', {x1, y1, x2, y2, stroke: '#f7e976', 'stroke-width': 1.8,
      'vector-effect': 'non-scaling-stroke'}));
  }
  if (result.mode === 'cold' || result.mode === 'warm') {
    result.rows.forEach((row, index) => {
      const stroke = index === state.selection ? '#82f2d5' : row.recommended ? '#f7c873' : '#fff9ec';
      nodes.push(boxDrawing(row.box, stroke, '0'));
    });
  }
  if (probing()) {
    const radius = Math.max(2.5, Math.min(width, height) / 58);
    const font = Math.max(7, Math.min(width, height) / 30);
    state.probes.forEach((probe, index) => {
      const [x, y] = probe.point.map(value => value + .5);
      nodes.push(graphic('circle', {cx: x, cy: y, r: radius, fill: '#22192688', stroke: '#f7c873',
        'stroke-width': 1.6, 'vector-effect': 'non-scaling-stroke'}));
      nodes.push(graphic('text', {x, y: y + font * .35, 'text-anchor': 'middle', 'font-size': font,
        fill: '#ffe9c4', 'pointer-events': 'none'}, String(index + 1)));
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
    : probing() ? '在热图上点选位置，查看同一像素修前、修后读数。'
      : state.tool ? `${tools[state.tool]} · 点选${state.start ? '另一端' : '起点'}`
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
    return `参考中位 ${meta.reference} °C · 低温门槛 ${meta.threshold} °C · 参考覆盖 ${meta.reference_coverage}%${omitted}`;
  }
  if (result.mode === 'warm') {
    const omitted = meta.omitted ? ` · 另有 ${meta.omitted} 个更小区未列表` : '';
    const base = `修前「${result.baseline.title}」· 最小回暖温差 ${meta.threshold} °C · 可比较像素 ${meta.comparable} · 占检查框 ${meta.coverage}%`;
    const recommendation = meta.recommendation;
    if (!recommendation) return `${base} · 没有达到温差的回暖区${omitted}`;
    const reason = recommendation.reason === 'magnitude' ? '本次看重回暖幅度（中位回暖最高）'
      : recommendation.reason === 'coverage' ? '本次看重覆盖（回暖像素最多）'
        : '回暖幅度与覆盖同为最大';
    return `${base} · 推荐回看 ${recommendation.name}：${reason}${omitted}`;
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
    for (const key of Object.keys(result.columns)) {
      tr.append(node('td', key === 'name' && row.recommended ? '★ ' + row[key] : format(row[key])));
    }
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
  $('no-readings').textContent = result.mode === 'warm' ? '检查框内没有达到所填温差的回暖。' : '当前范围没有符合条件的读数。';
  drawChart(result);
}

function drawProbes() {
  const active = probing();
  $('probe-card').hidden = !active;
  if (!active) return;
  $('probe-empty').hidden = !!state.probes.length;
  $('probe-rows').replaceChildren(...state.probes.map((probe, index) => {
    const tr = node('tr', null);
    tr.append(node('td', `点 ${index + 1} (${probe.point.join(', ')})`), node('td', format(probe.before)),
      node('td', format(probe.after)), node('td', format(probe.lift)));
    return tr;
  }));
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
  $('warm-settings').hidden = result.mode !== 'warm';
  $('area-settings').hidden = !(result.mode === 'cold' || result.mode === 'warm');
  $('distribution-settings').hidden = result.mode !== 'distribution';
  $('return-live').hidden = !isArchive;
  $('save').hidden = isArchive;
  $('downloads').hidden = !isArchive;
  $('view-switch').hidden = !probing();
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
  for (const button of $('view-switch').querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button.dataset.view === state.view));
  }
  drawThermogram();
  drawContext();
  drawReport();
  drawProbes();
}

async function loadLibrary() {
  const panels = await api('/panels');
  state.panels = panels;
  const buttons = panels.map(panel => {
    const label = node('button', panel.title, {'aria-pressed': String(panel.id === state.panel?.id)});
    label.append(node('small', `${panel.width} × ${panel.height} px`));
    label.onclick = action(() => openPanel(panel));
    return label;
  });
  $('library').replaceChildren(...(buttons.length ? buttons : [node('small', '尚无热图')]));
  loadBaseline();
  return panels;
}

function loadBaseline() {
  const select = $('baseline');
  if (!state.panel) {
    select.replaceChildren();
    state.baseline = null;
    return;
  }
  const others = state.panels.filter(panel => panel.id !== state.panel.id
    && panel.width === state.panel.width && panel.height === state.panel.height);
  if (!others.some(panel => panel.id === state.baseline)) state.baseline = others[0]?.id || null;
  const options = others.length ? others.map(panel => node('option', panel.title, {value: panel.id}))
    : [node('option', '（热图库中没有同尺寸热图）', {value: ''})];
  select.replaceChildren(...options);
  select.value = state.baseline || '';
  select.disabled = !others.length;
}

function pickRecommended() {
  const index = shown()?.rows?.findIndex(row => row.recommended) ?? -1;
  state.selection = index >= 0 ? index : null;
}

function loadArchive() {
  const buttons = state.panel.checks.map(check => {
    const button = node('button', check.heading, {'aria-pressed': String(check.id === state.archive?.id)});
    button.append(node('small', new Date(check.created).toLocaleString('zh-CN')));
    button.onclick = action(async () => {
      const next = await api(panelPath() + '/checks/' + check.id);
      state.archive = next;
      state.view = 'after';
      state.probes = [];
      await getImage(next.settings);
      state.tool = state.start = null;
      pickRecommended();
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

async function getArchiveImage() {
  if (state.view === 'before') {
    const blob = await api(`${panelPath()}/checks/${state.archive.id}/baseline.png`, 'GET', undefined, 'blob');
    if (state.image) URL.revokeObjectURL(state.image);
    state.image = URL.createObjectURL(blob);
    return;
  }
  await getImage(state.archive.settings);
}

async function refresh(next = state.draft, mode = state.mode) {
  if (mode === 'warm' && !state.baseline) throw Error('热图库中没有同尺寸的修前热图，请先导入。');
  const request = {settings: next, mode};
  if (mode === 'warm') request.baseline = state.baseline;
  const report = await api(panelPath() + '/preview', 'POST', request);
  await getImage(report.settings);
  state.draft = report.settings;
  state.mode = mode;
  state.archive = null;
  state.report = report;
  state.view = 'after';
  state.probes = [];
  pickRecommended();
  showFields();
  loadArchive();
  render();
}

async function openPanel(panel) {
  state.panel = panel;
  state.draft = structuredClone(panel.settings);
  state.mode = 'cold';
  state.archive = state.tool = state.start = null;
  state.view = 'after';
  state.probes = [];
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
  const request = {revision: state.panel.revision, mode: state.mode, settings: formSettings()};
  if (state.mode === 'warm') {
    if (!state.baseline) throw Error('热图库中没有同尺寸的修前热图，请先导入。');
    request.baseline = state.baseline;
  }
  const saved = await api(panelPath() + '/checks', 'POST', request);
  await getImage(saved.check.settings);
  state.panel = saved.panel;
  state.archive = saved.check;
  state.view = 'after';
  state.probes = [];
  state.tool = state.start = null;
  pickRecommended();
  loadArchive();
  render();
});
$('return-live').onclick = action(() => refresh());
$('palette').onchange = action(() => refresh(formSettings()));

$('baseline').onchange = action(async () => {
  state.baseline = $('baseline').value || null;
  if (state.mode === 'warm') await refresh(formSettings(), 'warm');
});

$('view-switch').querySelectorAll('button').forEach(button => {
  button.onclick = action(async () => {
    if (button.dataset.view === state.view) return;
    state.view = button.dataset.view;
    await getArchiveImage();
    render();
  });
});

$('clear-probes').onclick = () => {
  state.probes = [];
  drawThermogram();
  drawProbes();
};

$('measure-tools').querySelectorAll('button').forEach(button => {
  button.onclick = () => {
    state.tool = state.tool === button.dataset.tool ? null : button.dataset.tool;
    state.start = null;
    render();
  };
});
$('map').onclick = action(async event => {
  if (probing()) {
    const point = sourcePosition(event);
    if (!point) return;
    if (state.probes.length >= 30) {
      status('最多保留 30 个点位，可先清除再点。', true);
      return;
    }
    const points = [...state.probes.map(probe => probe.point), point];
    const result = await api(`${panelPath()}/checks/${state.archive.id}/probes`, 'POST', {points});
    state.probes = result.rows;
    drawThermogram();
    drawProbes();
    return;
  }
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
