'use strict';

const $ = id => document.getElementById(id);
const NS = 'http://www.w3.org/2000/svg';
const state = {config: {}, mode: 'cold', panel: null, draft: null, report: null, archive: null,
  selection: null, tool: null, start: null, image: null, contextOpen: false,
  measure: null, focused: false, chartDots: []};
const numeric = ['gain', 'offset', 'mm_per_pixel', 'show_lo', 'show_hi', 'delta', 'min_area', 'bins',
  'band_threshold'];
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

function currentMeasurement() {
  const result = shown();
  if (!result || result.mode !== 'profile') return null;
  return (state.archive ? result.meta.measurement : state.measure) || null;
}

function viewWindow() {
  const measure = currentMeasurement();
  return measure && state.focused ? [measure.from, measure.to] : null;
}

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
  map.classList.toggle('drawing', !!state.tool);
  const nodes = [graphic('image', {href: state.image, width, height}),
    boxDrawing(settings.inspect, '#f3e4c8', '6 4'), boxDrawing(settings.reference, '#72e4cf', '6 4')];
  if (result.mode === 'profile') {
    const [x1, y1, x2, y2] = settings.trace.map(value => value + .5);
    nodes.push(graphic('line', {x1, y1, x2, y2, stroke: '#f7e976', 'stroke-width': 1.8,
      'vector-effect': 'non-scaling-stroke'}));
    const measure = currentMeasurement();
    if (measure) {
      const ends = measure.points.map(([x, y]) => [x + .5, y + .5]);
      nodes.push(graphic('line', {x1: ends[0][0], y1: ends[0][1], x2: ends[1][0], y2: ends[1][1],
        stroke: '#8bf4dc', 'stroke-width': 3, 'stroke-linecap': 'round',
        'vector-effect': 'non-scaling-stroke'}));
      for (const [cx, cy] of ends) {
        nodes.push(graphic('circle', {cx, cy, r: Math.max(1.8, Math.min(width, height) / 110),
          fill: '#8bf4dc'}));
      }
    }
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

function chartIndices(result) {
  const window = viewWindow();
  const [first, last] = window || [0, result.rows.length - 1];
  return result.rows.map((_, index) => index).slice(first, last + 1);
}

function drawChart(result) {
  const chart = $('chart');
  chart.toggleAttribute('hidden', result.mode !== 'profile');
  if (chart.hasAttribute('hidden')) {
    state.chartDots = [];
    return;
  }
  const indices = chartIndices(result);
  const window = viewWindow();
  const rows = result.rows;
  const low = window ? rows[window[0]].distance : 0;
  const high = window ? rows[window[1]].distance : (result.meta.length || 1);
  const span = high - low || 1;
  const temps = indices.map(index => rows[index].temperature).filter(value => value !== null);
  const threshold = result.meta.threshold;
  const scale = threshold === undefined || threshold === null ? temps : [...temps, threshold];
  const bottom = scale.length ? Math.min(...scale) : 0;
  const top = scale.length ? Math.max(...scale) : 1;
  const range = top === bottom ? 1 : top - bottom;
  const px = distance => 44 + 697 * (distance - low) / span;
  const py = temp => 107 - 83 * (temp - bottom) / range;
  let path = '';
  let ongoing = false;
  const dots = [];
  for (const index of indices) {
    const temp = rows[index].temperature;
    if (temp === null) {
      ongoing = false;
      continue;
    }
    const dot = {index, x: px(rows[index].distance), y: py(temp)};
    path += `${ongoing ? 'L' : 'M'}${dot.x.toFixed(2)} ${dot.y.toFixed(2)} `;
    ongoing = true;
    dots.push(dot);
  }
  state.chartDots = dots;
  const trim = value => String(Math.round(value * 1000) / 1000);
  const children = [
    graphic('path', {d: 'M44 15V116H741', stroke: '#7b726f', fill: 'none'}),
    graphic('text', {x: 10, y: 23}, '°C'),
    graphic('text', {x: 44, y: 136}, trim(low)),
    graphic('text', {x: 741, y: 136, 'text-anchor': 'end'}, trim(high) + ' mm'),
    graphic('path', {class: 'trend', d: path})
  ];
  if (threshold !== undefined && threshold !== null) {
    const y = py(threshold);
    children.push(graphic('line', {x1: 44, x2: 741, y1: y, y2: y, class: 'threshold'}));
    children.push(graphic('text', {x: 736, y: y - 4, 'text-anchor': 'end', class: 'threshold-label'},
      `门槛 ${threshold}`));
  }
  const measure = currentMeasurement();
  if (measure) {
    const xa = px(measure.start_distance);
    const xb = px(measure.end_distance);
    for (const x of [xa, xb]) {
      children.push(graphic('line', {x1: x, x2: x, y1: 15, y2: 116, class: 'measure-line'}));
    }
    children.push(graphic('text', {x: (xa + xb) / 2, y: 12, 'text-anchor': 'middle',
      class: 'measure-label'}, `量宽 ${measure.width} mm`));
  }
  const marker = dots.find(dot => dot.index === state.selection);
  if (marker) {
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
  if (result.mode === 'profile') {
    const measure = currentMeasurement();
    return `剖线 ${meta.length} mm · 有效样点 ${meta.valid} / ${result.rows.length}` +
      (measure ? ` · ${measure.name}量宽 ${measure.width} mm` +
        `（${measure.start_distance}–${measure.end_distance} mm）` : '');
  }
  if (result.mode === 'distribution') return `有效像素 ${meta.valid} · 缺测 ${meta.missing}`;
  return result.mode === 'reference' ? '参考区读数用于设定低温门槛。' : '面积按原图有效读数与当前长度标尺计算。';
}

function select(index, scroll) {
  state.selection = index;
  $('rows').querySelectorAll('tr[aria-selected=true]').forEach(row => row.setAttribute('aria-selected', 'false'));
  const row = $('rows').querySelector(`tr[data-index="${index}"]`);
  if (row) {
    row.setAttribute('aria-selected', 'true');
    if (scroll) row.scrollIntoView({block: 'nearest'});
  }
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
  const indices = result.mode === 'profile' ? chartIndices(result) : result.rows.map((_, index) => index);
  const measure = currentMeasurement();
  $('rows').replaceChildren(...indices.map(index => {
    const row = result.rows[index];
    const tr = node('tr', null);
    tr.dataset.index = index;
    if (measure && index >= measure.start && index <= measure.end) tr.classList.add('measured');
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
  drawBand(result);
}

function drawBand(result) {
  const meta = result.meta;
  const segments = meta.segments || [];
  const measure = currentMeasurement();
  $('band').hidden = result.mode !== 'profile' || (!segments.length && !meta.reason && !measure);
  if ($('band').hidden) return;
  $('band-reason').textContent = meta.reason || '';
  $('band-list').replaceChildren(...segments.map((segment, index) => {
    const li = node('li', null);
    const head = `${segment.name} · ${segment.start_distance}–${segment.end_distance} mm`;
    if (segment.eligible) {
      li.append(node('span', `${head} · 宽 ${segment.width} mm · 最低 ${segment.min} °C · 缺测 ${segment.gaps}`));
      if (meta.recommend === index) li.append(node('em', '建议'));
      if (!state.archive) {
        const pick = node('button', '采用', {type: 'button'});
        pick.onclick = () => {
          state.measure = segment;
          state.focused = true;
          render();
        };
        li.append(pick);
      }
    } else {
      li.classList.add('off');
      li.append(node('span', `${head} · ${segment.note}`));
    }
    return li;
  }));
  $('band-measure').hidden = !measure;
  if (measure) {
    $('band-measure-text').textContent = `量宽 ${measure.width} mm：${measure.name} ` +
      `${measure.start_distance}–${measure.end_distance} mm · 门槛 ${meta.threshold} °C · ` +
      `实测低温点 ${measure.samples} · 段内缺测 ${measure.gaps}`;
    $('toggle-focus').textContent = state.focused ? '查看完整剖线' : '聚焦量宽冷段';
  }
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
  $('profile-settings').hidden = result.mode !== 'profile';
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
      state.measure = null;
      state.focused = !!next.meta?.measurement;
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
  state.measure = null;
  state.focused = false;
  showFields();
  loadArchive();
  render();
}

async function openPanel(panel) {
  state.panel = panel;
  state.draft = structuredClone(panel.settings);
  state.mode = 'cold';
  state.archive = state.tool = state.start = null;
  state.measure = null;
  state.focused = false;
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
  const body = {revision: state.panel.revision, mode: state.mode, settings: formSettings()};
  if (state.mode === 'profile' && state.measure) {
    body.measure = {start: state.measure.start, end: state.measure.end};
  }
  const saved = await api(panelPath() + '/checks', 'POST', body);
  await getImage(saved.check.settings);
  state.panel = saved.panel;
  state.archive = saved.check;
  state.selection = state.tool = state.start = null;
  state.measure = null;
  state.focused = !!saved.check.meta?.measurement;
  loadArchive();
  render();
});
$('return-live').onclick = action(() => refresh());
$('palette').onchange = action(() => refresh(formSettings()));

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

$('toggle-focus').onclick = () => {
  state.focused = !state.focused;
  render();
};

$('chart').onclick = event => {
  const result = shown();
  if (!result || result.mode !== 'profile' || !state.chartDots.length) return;
  const matrix = $('chart').getScreenCTM();
  if (!matrix) return;
  const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix.inverse());
  let nearest = state.chartDots[0];
  for (const dot of state.chartDots) {
    if (Math.abs(dot.x - p.x) < Math.abs(nearest.x - p.x)) nearest = dot;
  }
  select(nearest.index, true);
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
