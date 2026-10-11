// API client. Real backend by default; `?mock=1` serves fixtures from /static/mock/*.json.
const MOCK = new URLSearchParams(location.search).has('mock');
const MOCK_BASE = (() => {
  // Works both under FastAPI (/static/...) and python http.server (/static/index.html).
  const m = location.pathname.match(/^(.*\/static)\//);
  return (m ? m[1] : '/static') + '/mock/';
})();

export const isMock = MOCK;

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function http(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, opt);
  } catch (e) {
    throw new ApiError('サーバーに接続できません', 0);
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j && j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail);
    } catch (_) { /* ignore */ }
    throw new ApiError(msg, res.status);
  }
  return res.json();
}

// Multipart upload (field `file`). XHR so the UI can show upload progress.
function httpForm(url, file, onProgress, signal) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.responseType = 'text';
    if (onProgress && xhr.upload) xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let j = null;
      try { j = JSON.parse(xhr.responseText || 'null'); } catch (_) { /* ignore */ }
      if (xhr.status >= 200 && xhr.status < 300) { resolve(j); return; }
      const msg = j && j.detail ? (typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)) : `${xhr.status} ${xhr.statusText}`;
      reject(new ApiError(msg, xhr.status));
    };
    xhr.onerror = () => reject(new ApiError('サーバーに接続できません', 0));
    xhr.onabort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal) { if (signal.aborted) { reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; } signal.addEventListener('abort', () => xhr.abort(), { once: true }); }
    xhr.send(fd);
  });
}

// ── Mock layer ────────────────────────────────────────────────────────────
const mockCache = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fixture(name) {
  if (!mockCache[name]) {
    const res = await fetch(MOCK_BASE + name + '?v=3');
    if (!res.ok) throw new ApiError(`mock ${name} not found`, 404);
    mockCache[name] = await res.json();
  }
  return mockCache[name];
}
const clone = (o) => JSON.parse(JSON.stringify(o));

const mock = {
  async config() { return fixture('config.json'); },
  async dashboard() {
    const d = clone(await fixture('dashboard.json'));
    const rv = await fixture('reviews.json');
    // keep the badge consistent with the (small) mock review queue
    const remaining = rv.items.filter((x) => !mockState.done.has(x.rec.sku + '|' + x.rec.attr_key)).length;
    d.totals.needs_review = remaining;
    d.funnel.needs_review = remaining;
    d.totals.human_approved += mockState.done.size;
    return d;
  },
  async products(p = {}) {
    const d = clone(await fixture('products.json'));
    let items = [...Object.values(mockState.csvItems).map(clone), ...d.items.filter((i) => !mockState.csvItems[i.sku])];
    if (p.group) items = items.filter((i) => i.group === p.group);
    if (p.status) items = items.filter((i) => i.status === p.status);
    if (p.q) items = items.filter((i) => (i.title + i.brand + i.sku).toLowerCase().includes(p.q.toLowerCase()));
    return { items, total: items.length };
  },
  async product(sku) {
    if (mockState.csvDetails[sku]) return clone(mockState.csvDetails[sku]);
    try { if (!FIXTURE_SKUS.has(sku)) throw new Error('no fixture'); return clone(await fixture(`product_${sku}.json`)); } catch (e) {
      const list = await fixture('products.json');
      const it = list.items.find((i) => i.sku === sku);
      if (!it) throw new ApiError('商品が見つかりません', 404);
      // Minimal detail for SKUs without a dedicated fixture
      return {
        product: { ...it, category: it.group_label, description: '(モック: この商品の詳細フィクスチャはありません)', product_url: '#', raw_attributes: {} },
        source_text: `【タイトル】${it.title}`, targets: [], records: [], extras: { search_keywords: [], ai_summary: '' },
        status: it.status, fill_before: it.fill_before, fill_after: it.fill_after,
      };
    }
  },
  async reviews(p = {}) {
    const d = await fixture('reviews.json');
    let items = d.items.filter((x) => !mockState.done.has(x.rec.sku + '|' + x.rec.attr_key));
    if (p.group) items = items.filter((x) => x.product.group_label === p.group);
    return clone({ items, count: items.length });
  },
  async review(sku, attrKey, body) {
    await sleep(250);
    const d = await fixture('reviews.json');
    const it = d.items.find((x) => x.rec.sku === sku && x.rec.attr_key === attrKey);
    if (!it) throw new ApiError('レビュー対象が見つかりません', 404);
    mockState.done.add(sku + '|' + attrKey);
    mockState.reviewed = mockState.done.size;
    const map = { approve: 'approved', edit: 'edited', reject: 'human_rejected' };
    const rec = clone(it.rec);
    rec.gate_status = map[body.action];
    if (body.action === 'edit') rec.value = body.value;
    rec.reviewed = { action: body.action, comment: body.comment || '', at: new Date().toISOString() };
    // reflect into product fixture
    const pd = mockCache[`product_${sku}.json`];
    if (pd) {
      const r = pd.records.find((x) => x.attr_key === attrKey);
      if (r) Object.assign(r, rec);
    }
    return { record: rec, remaining: d.items.length - mockState.done.size };
  },
  async batchJobs() { return clone(await fixture('batch_jobs.json')); },
  async batchSubmit(body) {
    await sleep(600);
    const d = await fixture('batch_jobs.json');
    const now = new Date().toISOString();
    const job = {
      job_id: `projects/123/locations/global/batchPredictionJobs/${Math.floor(Math.random() * 9000 + 1000)}`,
      display_name: `enrich-${now.slice(0, 16).replace(/[-:T]/g, '')}${body.group ? '-' + body.group : ''}`,
      model: 'gemini-3.8-flash', state: 'JOB_STATE_PENDING', sku_count: body.limit, request_count: body.limit * 2,
      input_tokens: 0, output_tokens: 0, cost_jpy: 0, created_at: now, updated_at: now, ingested: false,
    };
    d.jobs.unshift(job);
    return { job: clone(job) };
  },
  async batchRefresh() {
    await sleep(700);
    const d = await fixture('batch_jobs.json');
    d.jobs.forEach((j) => {
      if (j.state === 'JOB_STATE_PENDING') j.state = 'JOB_STATE_RUNNING';
      else if (j.state === 'JOB_STATE_RUNNING') {
        j.state = 'JOB_STATE_SUCCEEDED'; j.input_tokens = j.sku_count * 1523; j.output_tokens = j.sku_count * 582;
        j.cost_jpy = +(j.sku_count * 0.052).toFixed(2); j.ingested = true;
      }
      j.updated_at = new Date().toISOString();
    });
    return clone(d);
  },
  async costEstimate(skus) {
    const m = 0.052, s = 0.061;
    return { skus, per_sku_jpy_measured: m, per_sku_jpy_slide: s, total_jpy_measured: +(skus * m).toFixed(2),
      total_jpy_slide: +(skus * s).toFixed(2), avg_input_tokens: 1523, avg_output_tokens: 582, basis: 'batch (50% off)' };
  },
  async golden() { return clone(await fixture('golden.json')); },
  ...mockCsvGmc(),
  async enrich(sku, onEvent) {
    const detail = await mock.product(sku);
    const recs = detail.records;
    const nAttr = recs.filter((r) => r.kind === 'attribute').length;
    const nTag = recs.filter((r) => r.kind === 'tag').length;
    const summ = { auto_approved: 0, needs_review: 0, rejected: 0 };
    recs.forEach((r) => { if (summ[r.gate_status] !== undefined) summ[r.gate_status] += 1; });
    const evs = [
      [200, { event: 'start', sku, model: 'gemini-3.8-flash' }],
      [300, { event: 'stage', stage: 'stage1', status: 'running' }],
      [100, { event: 'stage', stage: 'stage3', status: 'running' }],
      [1800, { event: 'stage', stage: 'stage3', status: 'done', latency_ms: 1840, count: nTag }],
      [700, { event: 'stage', stage: 'stage1', status: 'done', latency_ms: 2620, input_tokens: 1523, output_tokens: 611, count: nAttr }],
      [600, { event: 'stage', stage: 'normalize', status: 'done', count: nAttr, failed: 1 }],
      [700, { event: 'stage', stage: 'gate', status: 'done', summary: summ }],
      [400, { event: 'result', detail }],
    ];
    for (const [ms, ev] of evs) { await sleep(ms); onEvent(ev); }
  },
};
const mockState = { done: new Set(), reviewed: 0, csvItems: {}, csvDetails: {}, gmc: {} };

// ── SSE over POST (fetch + ReadableStream) ─────────────────────────────────
async function postStream(url, body, onEvent, signal) {
  let res;
  const headers = { Accept: 'text/event-stream' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    res = await fetch(url, { method: 'POST', headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new ApiError('サーバーに接続できません', 0);
  }
  if (!res.ok || !res.body) {
    let msg = `${res.status} ${res.statusText}`;
    try { const j = await res.json(); if (j && j.detail) msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail); } catch (_) { /* ignore */ }
    throw new ApiError(msg, res.status);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '';
  const flush = (chunk) => {
    const lines = chunk.split(/\r?\n/).filter((l) => l.startsWith('data:'));
    if (!lines.length) return;
    const data = lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
    try { onEvent(JSON.parse(data)); } catch (e) { console.warn('bad SSE payload', data); }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
      const m = buf.match(/\r?\n\r?\n/);
      flush(buf.slice(0, idx));
      buf = buf.slice(idx + m[0].length);
    }
  }
  if (buf.trim()) flush(buf);
}

const enrichStream = (sku, onEvent, signal) => postStream(`/api/products/${encodeURIComponent(sku)}/enrich`, undefined, onEvent, signal);

const qs = (p) => {
  const u = new URLSearchParams();
  Object.entries(p || {}).forEach(([k, v]) => { if (v !== undefined && v !== null && v !== '') u.set(k, v); });
  const s = u.toString();
  return s ? '?' + s : '';
};

const real = {
  config: () => http('GET', '/api/config'),
  dashboard: () => http('GET', '/api/dashboard'),
  products: (p) => http('GET', '/api/products' + qs(p)),
  product: (sku) => http('GET', `/api/products/${encodeURIComponent(sku)}`),
  reviews: (p) => http('GET', '/api/reviews' + qs(p)),
  review: (sku, attrKey, body) => http('POST', `/api/reviews/${encodeURIComponent(sku)}/${encodeURIComponent(attrKey)}`, body),
  batchJobs: () => http('GET', '/api/batch/jobs'),
  batchSubmit: (body) => http('POST', '/api/batch/jobs', body),
  batchRefresh: () => http('POST', '/api/batch/jobs/refresh'),
  costEstimate: (skus) => http('GET', '/api/cost/estimate' + qs({ skus })),
  golden: (p) => http('GET', '/api/golden' + qs(p)),
  enrich: enrichStream,
  csvSample: () => http('GET', '/api/csv/sample'),
  csvParse: (body) => http('POST', '/api/csv/parse', body),
  csvEnrich: (body, onEvent, signal) => postStream('/api/csv/enrich', body, onEvent, signal),
  csvSaveBq: (skus) => http('POST', '/api/csv/save-bq', { skus }),
  gmcList: (p) => http('GET', '/api/gmc' + qs(p)),
  gmcDetail: (sku) => http('GET', `/api/gmc/${encodeURIComponent(sku)}`),
  gmcGenerate: (sku) => http('POST', `/api/gmc/${encodeURIComponent(sku)}/generate`),
  gmcUpdate: (sku, body) => http('PUT', `/api/gmc/${encodeURIComponent(sku)}`, body),
  // ① 季節画像
  imagePresets: (sku) => http('GET', '/api/images/presets' + qs({ sku })),
  productImages: (sku) => http('GET', `/api/products/${encodeURIComponent(sku)}/images`),
  uploadBaseImage: (sku, file, onProgress, signal) => httpForm(`/api/products/${encodeURIComponent(sku)}/images/upload`, file, onProgress, signal),
  searchImages: (sku) => http('POST', `/api/products/${encodeURIComponent(sku)}/images/search`, {}),
  generateImages: (sku, body, onEvent, signal) => postStream(`/api/products/${encodeURIComponent(sku)}/images/generate`, body, onEvent, signal),
  saveImages: (sku, body) => http('POST', `/api/products/${encodeURIComponent(sku)}/images/save`, body),
  deleteImage: (sku, imageId) => http('DELETE', `/api/products/${encodeURIComponent(sku)}/images/${encodeURIComponent(imageId)}`),
  // ② 資料から抽出
  docsUpload: (file, onProgress, signal) => httpForm('/api/docs/upload', file, onProgress, signal),
  docsList: (gcsUri) => http('POST', '/api/docs/list', { gcs_uri: gcsUri }),
  docsExtract: (body, onEvent, signal) => postStream('/api/docs/extract', body, onEvent, signal),
  docsPreview: (body) => http('POST', '/api/docs/preview', body),
  docsApply: (body, onEvent, signal) => postStream('/api/docs/apply', body, onEvent, signal),
};
Object.assign(mock, mockImagesDocs());

export const api = MOCK ? mock : real;
export const goldenCsvUrl = MOCK ? null : '/api/golden/export.csv';
export const sampleCsvUrl = '/api/csv/sample.csv';
export const gmcTsvUrl = '/api/gmc/export.tsv';
export const gmcCsvUrl = '/api/gmc/export.csv';
export const GMC_SPEC_URL = 'https://support.google.com/merchants/answer/17085370?hl=en';
export const GMC_SPEC_URL_JA = 'https://support.google.com/merchants/answer/17085370?hl=ja';

// ── Mock: CSV live test + GMC conversational attributes ─────────────────────
const MOCK_MODEL = 'gemini-3.8-flash';
const HEADER_ALIASES = {
  sku: ['sku', 'id', 'p_cd', 'product_id', 'item_id', '商品コード', '商品id', '品番', 'jan'],
  title: ['title', 'name', 'product_name', '商品名', 'タイトル', '品名'],
  brand: ['brand', 'brands', 'maker', 'ブランド', 'メーカー'],
  category: ['category', 'categories', 'category_path', 'カテゴリ', 'カテゴリー', '分類'],
  description: ['description', 'desc', 'body', '説明文', '商品説明', '詳細説明'],
  price: ['price', 'sale_price', '価格', '販売価格', '税込価格'],
  product_url: ['product_url', 'uri', 'url', 'link', '商品url', 'リンク'],
  image_url: ['image_url', 'image', 'image_link', 'thumbnail', '画像url', '商品画像'],
  group: ['group', 'category_group', 'カテゴリグループ'],
};
const GROUP_LABELS = { fridge: '冷蔵庫', aircon: 'エアコン', fan: '扇風機・サーキュレーター', handy: 'ハンディファン・小型扇風機' };
const MOCK_TARGETS = {
  common: [['width_mm', '幅', 'mm'], ['height_mm', '高さ', 'mm'], ['depth_mm', '奥行', 'mm'], ['weight_kg', '重量', 'kg'], ['power_supply_v', '電源電圧', 'V']],
  fridge: [['total_capacity_l', '定格内容積', 'L'], ['freezer_capacity_l', '冷凍室容量', 'L'], ['annual_power_kwh', '年間消費電力量', 'kWh/年'], ['door_type', 'ドアタイプ', '']],
  aircon: [['cooling_tatami_min', '冷房 目安畳数(下限)', '畳'], ['cooling_tatami_max', '冷房 目安畳数(上限)', '畳'], ['cooling_capacity_kw', '冷房能力', 'kW'], ['noise_db', '運転音', 'dB']],
  fan: [['power_consumption_w', '消費電力', 'W'], ['blade_count', '羽根枚数', '枚'], ['motor_type', 'モーター方式', ''], ['airflow_levels', '風量段階', '段階'], ['noise_db', '運転音', 'dB']],
  handy: [['blade_count', '羽根枚数', '枚'], ['battery_hours', '連続使用時間(最大)', '時間'], ['charging_hours', '充電時間', '時間'], ['is_cordless', 'コードレス(充電式)', '']],
};
const RAW_TO_ATTR = {
  weight: 'weight_kg', indoor_unit_weight: 'weight_kg', capacity: 'total_capacity_l', freezer_capacity: 'freezer_capacity_l',
  annual_power_consumption: 'annual_power_kwh', door_type: 'door_type', power_supply: 'power_supply_v', power_consumption: 'power_consumption_w',
  number_of_blades: 'blade_count', motor_type: 'motor_type', airflow_control: 'airflow_levels', noise_level: 'noise_db', cooling_noise_level: 'noise_db',
  cooling_capacity: 'cooling_capacity_kw', charging_time: 'charging_hours', battery_life: 'battery_hours',
};

function parseCsvRows(text) {
  const rows = []; let row = []; let f = ''; let q = false;
  text = String(text || '').replace(/^\ufeff/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim()));
}
function detectGroup(s) {
  if (/エアコン/.test(s)) return 'aircon';
  if (/冷蔵庫|冷凍庫/.test(s)) return 'fridge';
  if (/ハンディ|ミニ扇風機|首掛け/.test(s)) return 'handy';
  return 'fan';
}
function mockTargets(group) { return [...MOCK_TARGETS.common, ...(MOCK_TARGETS[group] || [])].map(([key, label, unit]) => ({ key, label, unit, type: ['door_type', 'motor_type'].includes(key) ? 'text' : key === 'is_cordless' ? 'bool' : 'number', raw_keys: [] })); }
function mockFillBefore(p) {
  const t = mockTargets(p.group).map((x) => x.key);
  const have = new Set();
  Object.keys(p.raw_attributes || {}).forEach((k) => {
    if (/dimensions/.test(k)) ['width_mm', 'height_mm', 'depth_mm'].forEach((x) => have.add(x));
    if (RAW_TO_ATTR[k]) have.add(RAW_TO_ATTR[k]);
  });
  return +(t.filter((k) => have.has(k)).length / t.length).toFixed(3);
}
function csvToProducts(text) {
  const rows = parseCsvRows(text);
  if (!rows.length) throw new ApiError('CSVデータが空です', 400);
  const headers = rows[0].map((h) => String(h).trim());
  const map = headers.map((h) => {
    const n = h.toLowerCase().replace(/[\s\-]+/g, '_');
    const hit = Object.entries(HEADER_ALIASES).find(([, al]) => al.includes(n) || al.includes(h));
    return hit ? hit[0] : 'raw:' + h;
  });
  const items = rows.slice(1).map((r, idx) => {
    const p = { sku: '', title: '', brand: '', category: '', description: '', price: null, product_url: '', image_url: '', group: '', raw_attributes: {} };
    r.forEach((v, i) => {
      v = String(v || '').trim(); if (!v || !headers[i]) return;
      const t = map[i];
      if (t === 'price') p.price = Number(v.replace(/[^\d.]/g, '')) || null;
      else if (t.startsWith('raw:')) p.raw_attributes[t.slice(4)] = v;
      else p[t] = v;
    });
    p.sku = p.sku || `CSV-${String(idx + 1).padStart(4, '0')}`;
    if (!GROUP_LABELS[p.group]) p.group = detectGroup(`${p.category} ${p.title}`);
    p.group_label = GROUP_LABELS[p.group];
    p.fill_before = mockFillBefore(p);
    p.raw_attr_count = Object.keys(p.raw_attributes).length;
    return p;
  });
  return { items, count: items.length, columns: headers };
}
const firstNum = (s) => { const m = String(s).replace(/,/g, '').match(/\d+(?:\.\d+)?/); return m ? Number(m[0]) : null; };
function mockRec(p, key, label, raw, value, unit, note, ev, field, sc, em, jobId, kind = 'attribute') {
  const score = +(0.6 * em + 0.4 * sc).toFixed(3);
  const st = em > 0 && score >= 0.9 ? 'auto_approved' : 'needs_review';
  return { sku: p.sku, kind, attr_key: key, label, raw_value: raw, value, unit, norm_note: note, evidence: ev, source_field: field, self_conf: sc,
    evidence_match: em, token_conf: null, score, gate_status: st, gate: 'gate2', reason: st === 'auto_approved' ? `複合スコア ${score.toFixed(2)} ≥ 0.90` : `複合スコア ${score.toFixed(2)} < 0.90(確信度不足)`,
    job_id: jobId, model: MOCK_MODEL, created_at: new Date().toISOString() };
}
async function mockEnrichProduct(p, jobId) {
  const cfg = await fixture('config.json');
  const targets = mockTargets(p.group);
  const tlabel = Object.fromEntries(targets.map((t) => [t.key, t]));
  const recs = [];
  const seen = new Set();
  Object.entries(p.raw_attributes || {}).forEach(([k, v]) => {
    if (/dimensions/.test(k)) {
      const m = String(v).match(/W\s*([\d.]+).*?H\s*([\d.]+).*?D\s*([\d.]+)/i);
      if (m) [['width_mm', m[1]], ['height_mm', m[2]], ['depth_mm', m[3]]].forEach(([key, n], j) => {
        if (seen.has(key)) return; seen.add(key);
        recs.push(mockRec(p, key, tlabel[key].label, v, Math.round(Number(n) * 10), 'mm', 'W×H×D 表記を分解し cm → mm に換算', v, 'attributes', 0.95 - j * 0.01, 1.0, jobId));
      });
      return;
    }
    const key = RAW_TO_ATTR[k];
    if (!key || seen.has(key) || !tlabel[key]) return;
    seen.add(key);
    const t = tlabel[key];
    let val = t.type === 'text' ? v : firstNum(v);
    let note = '数値部分を抽出';
    if (key === 'weight_kg' && /g$/.test(v) && !/kg/.test(v)) { val = +(val / 1000).toFixed(3); note = 'g → kg に換算'; }
    if (key === 'power_supply_v') val = firstNum(v.replace(/単相/, ''));
    recs.push(mockRec(p, key, t.label, v, val, t.unit, note, v, 'attributes', /約/.test(v) ? 0.86 : 0.94, /約/.test(v) ? 0.8 : 1.0, jobId));
  });
  if (p.group === 'aircon') {
    const m = String(p.raw_attributes.cooling_area_coverage || p.description).match(/(\d+)\s*[～〜~]\s*(\d+)\s*畳/);
    if (m) {
      recs.push(mockRec(p, 'cooling_tatami_min', '冷房 目安畳数(下限)', m[0], Number(m[1]), '畳', '範囲表記の下限', m[0], 'attributes', 0.93, 1.0, jobId));
      recs.push(mockRec(p, 'cooling_tatami_max', '冷房 目安畳数(上限)', m[0], Number(m[2]), '畳', '範囲表記の上限', m[0], 'attributes', 0.93, 1.0, jobId));
    }
  }
  const tagDict = (cfg.feature_tags && cfg.feature_tags[p.group]) || [];
  const text = `${p.title} ${p.description}`;
  tagDict.filter((t) => text.includes(t.replace(/\(.+\)|\/.+/, ''))).slice(0, 5).forEach((t) => {
    const ev = t.replace(/\(.+\)|\/.+/, '');
    recs.push(mockRec(p, 'tag:' + t, t, t, true, '', '標準タグ辞書に一致', ev, 'description', 0.95, 1.0, jobId, 'tag'));
  });
  const src = `【タイトル】${p.title}\n【説明文】${p.description}\n【属性】\n` + Object.entries(p.raw_attributes || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  const attrs = recs.filter((r) => r.kind === 'attribute');
  const fill_after = +(new Set(attrs.map((r) => r.attr_key)).size / targets.length).toFixed(3);
  const status = recs.some((r) => r.gate_status === 'needs_review') ? 'needs_review' : 'completed';
  const sentences = String(p.description).split('。').map((x) => x.trim()).filter(Boolean);
  const detail = {
    product: { sku: p.sku, title: p.title, brand: p.brand, category: p.category, description: p.description, product_url: p.product_url,
      image_url: p.image_url, price: p.price, group: p.group, group_label: GROUP_LABELS[p.group], raw_attributes: p.raw_attributes },
    source_text: src, targets, records: recs,
    extras: { search_keywords: [`${p.brand} ${GROUP_LABELS[p.group]}`, ...recs.filter((r) => r.kind === 'tag').slice(0, 2).map((r) => `${r.label} ${GROUP_LABELS[p.group]}`)],
      ai_summary: sentences[0] ? sentences[0] + '。' : '' },
    status, fill_before: p.fill_before ?? mockFillBefore(p), fill_after,
  };
  // GMC
  const byKey = Object.fromEntries(attrs.map((r) => [r.attr_key, r]));
  const qas = [];
  if (byKey.width_mm && byKey.height_mm && byKey.depth_mm) qas.push({ question: '本体サイズはどのくらいですか？', answer: `幅${byKey.width_mm.value}mm×高さ${byKey.height_mm.value}mm×奥行${byKey.depth_mm.value}mmです。`, evidence: byKey.width_mm.evidence, confidence: 0.96 });
  if (byKey.weight_kg) qas.push({ question: '重さはどれくらいですか？', answer: `約${byKey.weight_kg.value}kgです。`, evidence: byKey.weight_kg.evidence, confidence: 0.95 });
  if (sentences[1]) qas.push({ question: 'どんな特長がありますか？', answer: sentences[1] + '。', evidence: sentences[1], confidence: 0.9 });
  const gmcQas = qas.map((q) => { const em = src.includes(q.evidence) ? 1 : 0; const sc = +(0.6 * em + 0.4 * q.confidence).toFixed(3); return { ...q, evidence_match: em, score: sc, status: em && sc >= 0.9 ? 'auto_approved' : 'needs_review' }; });
  const vos = [];
  if (byKey.total_capacity_l) vos.push({ name: '定格内容積', value: `${byKey.total_capacity_l.value}L`, evidence: byKey.total_capacity_l.evidence, evidence_match: 1 });
  if (byKey.door_type) vos.push({ name: 'ドア開閉方向', value: byKey.door_type.value, evidence: byKey.door_type.evidence, evidence_match: 1 });
  const color = (p.title.match(/(ホワイト|グレー|ブラック|ゴールド|シルバー|グレイスゴールド)/) || [])[1];
  if (color) vos.unshift({ name: 'カラー', value: color, evidence: color, evidence_match: 1 });
  const groupId = (p.title.match(/[A-Z]{1,4}-?[A-Z0-9]{3,}[A-Z0-9-]*/) || [p.sku])[0].replace(/-[A-Z]$/, '');
  const gmc = mockGmcStrings({
    sku: p.sku, item_group_id: groupId, item_group_title: p.title.replace(/\s*(ホワイト|グレー|ブラック|グレイスゴールド)\s*/g, ' ').trim(),
    variant_options: vos, questions_and_answers: gmcQas,
    product_highlights: sentences.slice(0, 3).map((x) => x.length > 40 ? x.slice(0, 40) + '…' : x),
    product_details: attrs.filter((r) => r.gate_status === 'auto_approved' && r.value !== null).map((r) => ({ section: '仕様', attribute: r.label, value: `${r.value}${r.unit || ''}` })),
    related_products: [], popularity_rank: 50 + (p.sku.length * 7) % 40, document_link: `https://store.example.com/download/manual/${groupId}.pdf`,
    model: MOCK_MODEL, job_id: jobId, updated_at: new Date().toISOString(),
  });
  return { detail, gmc, src };
}
function mockGmcStrings(g) {
  g.variant_option = (g.variant_options || []).filter((v) => v.name && v.value).map((v) => `${v.name}:${v.value}`).join(',');
  g.question_and_answer = (g.questions_and_answers || []).filter((q) => q.question && q.answer).map((q) => `"${q.question}":"${q.answer}"`).join(', ');
  g.product_highlight = (g.product_highlights || []).filter(Boolean).map((h) => `"${h}"`).join(', ');
  g.product_detail = (g.product_details || []).map((d) => `${d.section}:${d.attribute}:"${d.value}"`).join(', ');
  g.related_product = (g.related_products || []).filter((r) => r.identifier).map((r) => `${r.relationship_type}:${r.identifier_type}:${r.identifier}`).join(',');
  return g;
}
function mockFeedRow(p, g) {
  return { id: p.sku, item_group_id: g.item_group_id || '', title: p.title, item_group_title: g.item_group_title || '', variant_option: g.variant_option || '',
    question_and_answer: g.question_and_answer || '', product_highlight: g.product_highlight || '', product_detail: g.product_detail || '',
    related_product: g.related_product || '', popularity_rank: g.popularity_rank ?? '', document_link: g.document_link || '', brand: p.brand || '',
    price: p.price ? `${Math.round(p.price)} JPY` : '', link: p.product_url || '', image_link: p.image_url || '' };
}
// SKUs that have dedicated fixture files (avoids 404 noise for the rest)
const FIXTURE_SKUS = new Set(['00081900756', '00082233104']);
async function mockGmcGet(sku) {
  if (mockState.gmc[sku]) return mockState.gmc[sku];
  if (FIXTURE_SKUS.has(sku)) { try { mockState.gmc[sku] = clone(await fixture(`gmc_${sku}.json`)); return mockState.gmc[sku]; } catch (e) { /* fallthrough */ } }
  const d = await mock.product(sku);
  const g = mockGmcStrings({ sku, item_group_id: '', item_group_title: '', variant_options: [], questions_and_answers: [], product_highlights: [], product_details: [], related_products: [], popularity_rank: null, document_link: '', model: MOCK_MODEL, job_id: '', updated_at: '' });
  mockState.gmc[sku] = { product: d.product, source_text: d.source_text, gmc: g, feed_row: mockFeedRow(d.product, g) };
  return mockState.gmc[sku];
}
function mockCsvGmc() {
  return {
    async csvSample() {
      const s = await fixture('csv_sample.json');
      return { ...csvToProducts(s.csv_text), csv_text: s.csv_text };
    },
    async csvParse(body) { await sleep(150); return csvToProducts(body.csv_text || ''); },
    async csvEnrich(body, onEvent, signal) {
      const prods = body.products && body.products.length ? body.products : csvToProducts(body.csv_text).items;
      const jobId = `csv-live-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}`;
      const t0 = Date.now();
      const chk = () => { if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); };
      onEvent({ event: 'start', job_id: jobId, model: MOCK_MODEL, total: prods.length, save_to_bq: !!body.save_to_bq, dataset: 'demo-project.product_enrichment' });
      let tin = 0, tout = 0; const done = [];
      for (let i = 0; i < prods.length; i++) {
        const p = prods[i];
        chk();
        onEvent({ event: 'sku_start', index: i, total: prods.length, sku: p.sku, title: p.title, group: p.group, group_label: GROUP_LABELS[p.group] });
        await sleep(1400 + Math.random() * 600); chk();
        const { detail, gmc, src } = await mockEnrichProduct(p, jobId);
        const it = { sku: p.sku, title: p.title, brand: p.brand, group: p.group, group_label: GROUP_LABELS[p.group], image_url: p.image_url, price: p.price,
          status: detail.status, fill_before: detail.fill_before, fill_after: detail.fill_after, attr_count: detail.records.filter((r) => r.kind === 'attribute').length,
          auto_approved: detail.records.filter((r) => r.gate_status === 'auto_approved' && r.kind === 'attribute').length,
          needs_review: detail.records.filter((r) => r.gate_status === 'needs_review').length, rejected: 0, tags: detail.records.filter((r) => r.kind === 'tag').map((r) => r.label) };
        mockState.csvItems[p.sku] = it; mockState.csvDetails[p.sku] = detail;
        mockState.gmc[p.sku] = { product: detail.product, source_text: src, gmc, feed_row: mockFeedRow(detail.product, gmc) };
        const ti = 1500 + Math.round(Math.random() * 300), to = 900 + Math.round(Math.random() * 300);
        tin += ti; tout += to; done.push(p.sku);
        onEvent({ event: 'sku_done', index: i, total: prods.length, sku: p.sku, latency_ms: 1400 + Math.round(Math.random() * 900), input_tokens: ti, output_tokens: to,
          attr_count: it.attr_count, tag_count: it.tags.length, qa_count: gmc.questions_and_answers.length, fill_before: detail.fill_before, fill_after: detail.fill_after, status: detail.status, detail });
      }
      let bq = null;
      if (body.save_to_bq && done.length) {
        onEvent({ event: 'bq_saving', skus: done.length, dataset: 'demo-project.product_enrichment' });
        await sleep(900);
        bq = await mock.csvSaveBq(done, true);
        delete bq.ok;
      }
      const cost = +((tin * 0.3 + tout * 2.5) / 1e6 * 150).toFixed(3);
      onEvent({ event: 'complete', job_id: jobId, model: MOCK_MODEL, processed: done.length, total: prods.length, save_to_bq: !!body.save_to_bq, bq_result: bq,
        input_tokens: tin, output_tokens: tout, cost_jpy: cost, elapsed_ms: Date.now() - t0 });
    },
    async csvSaveBq(skus, quiet) {
      if (!quiet) await sleep(700);
      const recs = skus.reduce((a, s) => a + ((mockState.csvDetails[s] || {}).records || []).length, 0);
      const DS = 'demo-project.product_enrichment'; // backend returns dataset-qualified table keys
      return { ok: true, skus: skus.length, tables: { [`${DS}.source_products`]: skus.length, [`${DS}.enriched_attributes`]: recs, [`${DS}.sku_extras`]: skus.length, [`${DS}.golden_records`]: skus.length, [`${DS}.gmc_conversational`]: skus.length } };
    },
    async gmcList(p = {}) {
      const prods = (await mock.products({})).items;
      const all = [];
      for (const it of prods) {
        const d = await mockGmcGet(it.sku); const g = d.gmc;
        const qas = g.questions_and_answers || [];
        all.push({ sku: it.sku, title: it.title, brand: it.brand, group: it.group, group_label: it.group_label, image_url: it.image_url, price: it.price,
          item_group_id: g.item_group_id, item_group_title: g.item_group_title, variant_option: g.variant_option, variant_options: g.variant_options || [],
          qa_count: qas.length, qa_auto_approved: qas.filter((q) => q.status === 'auto_approved').length, qa_needs_review: qas.filter((q) => q.status === 'needs_review').length,
          highlight_count: (g.product_highlights || []).length, detail_count: (g.product_details || []).length, related_count: (g.related_products || []).length,
          popularity_rank: g.popularity_rank, document_link: g.document_link, model: MOCK_MODEL, job_id: g.job_id, updated_at: g.updated_at });
      }
      const tq = all.reduce((a, i) => a + i.qa_count, 0);
      const stats = { total_skus: all.length, total_qas: tq, avg_qas_per_sku: +(tq / Math.max(all.length, 1)).toFixed(1),
        variant_option_skus: all.filter((i) => i.variant_options.length).length, related_product_skus: all.filter((i) => i.related_count).length,
        highlight_skus: all.filter((i) => i.highlight_count).length, auto_approved_qas: all.reduce((a, i) => a + i.qa_auto_approved, 0), needs_review_qas: all.reduce((a, i) => a + i.qa_needs_review, 0) };
      let items = all;
      if (p.group) items = items.filter((i) => i.group === p.group);
      if (p.q) { const q = p.q.toLowerCase(); items = items.filter((i) => (i.title + i.brand + i.sku + i.item_group_title).toLowerCase().includes(q)); }
      return { spec_url: 'https://support.google.com/merchants/answer/17085370?hl=en', spec_url_ja: 'https://support.google.com/merchants/answer/17085370?hl=ja', model: MOCK_MODEL, stats, items, total: items.length };
    },
    async gmcDetail(sku) { return clone(await mockGmcGet(sku)); },
    async gmcGenerate(sku) {
      await sleep(1800);
      const d = await mockGmcGet(sku);
      d.gmc.updated_at = new Date().toISOString(); d.gmc.job_id = `gmc-live-${Date.now()}`;
      d.gmc.questions_and_answers.forEach((q) => { q.confidence = Math.min(0.99, +(q.confidence + 0.01).toFixed(2)); });
      return { ...clone(d), latency_ms: 1780, input_tokens: 1320, output_tokens: 640 };
    },
    async gmcUpdate(sku, body) {
      await sleep(400);
      const d = await mockGmcGet(sku);
      const g = d.gmc;
      ['item_group_id', 'item_group_title', 'document_link'].forEach((k) => { if (body[k] != null) g[k] = String(body[k]).trim(); });
      if (body.popularity_rank != null) g.popularity_rank = +Number(body.popularity_rank).toFixed(1);
      if (Array.isArray(body.variant_options)) g.variant_options = body.variant_options.filter((v) => v.name && v.value).map((v) => ({ ...v, evidence: v.evidence || v.value, evidence_match: d.source_text.includes(v.evidence || v.value) ? 1 : 0 }));
      if (Array.isArray(body.questions_and_answers)) g.questions_and_answers = body.questions_and_answers.filter((q) => q.question && q.answer).map((q) => {
        const em = q.evidence ? (d.source_text.includes(q.evidence) ? 1 : 0) : 1; const conf = q.confidence || 0.95; const sc = +(0.6 * em + 0.4 * conf).toFixed(3);
        return { ...q, confidence: conf, evidence_match: em, score: sc, status: q.status || (sc >= 0.9 ? 'auto_approved' : 'needs_review') };
      });
      if (Array.isArray(body.product_highlights)) g.product_highlights = body.product_highlights.map((h) => String(h).trim()).filter(Boolean);
      if (Array.isArray(body.related_products)) g.related_products = body.related_products.filter((r) => r.identifier);
      mockGmcStrings(g);
      d.feed_row = mockFeedRow(d.product, g);
      return clone(d);
    },
  };
}

// ── Mock: ① 季節画像スタジオ + ② 資料から抽出 ─────────────────────────────
// Everything is evaluated lazily inside the methods (module-level consts below this point are in TDZ at Object.assign time).
function mockImagesDocs() {
  const BUCKET = 'products_images_demo-project';
  const imgState = {}; // sku -> ImageRow[]
  const SEASON_COL = { spring: ['#fde2ec', '#f7a8c4'], summer: ['#d8f1ff', '#3fa9f5'], rainy: ['#e3ecf5', '#7c9cc0'], autumn: ['#fdebd3', '#e58a3a'], winter: ['#eef4ff', '#9db7e8'], all: ['#ffffff', '#cfd6e0'] };
  const P = (id, label, season, season_label, icon, available, reason, evidence, facts, prompt) => ({ id, label, season, season_label, icon, available, reason, evidence, facts, prompt });
  const PRESETS = {
    aircon: [
      P('spring-pollen', '春：花粉・空気清浄', 'spring', '春', '🌸', false, 'この商品には花粉・空気清浄・フィルターに関する記載がありません', '', [], '春の柔らかい光。窓の外に桜、室内は澄んだ空気。'),
      P('summer-cooling', '夏：冷房パワー', 'summer', '夏', '☀️', true, '', '冷房能力 2.2kW（主に6畳）', [{ label: '冷房能力', value: '2.2 kW' }, { label: '目安畳数', value: '6〜9畳' }], '真夏の強い日差しのリビング。エアコンから涼しい風が広がる爽快感。'),
      P('night-quiet', '夏の夜：静音', 'summer', '夏', '🌙', true, '', '室内機運転音 19dB', [{ label: '運転音', value: '19 dB' }], '夏の夜の寝室。静かに眠れる落ち着いた雰囲気。'),
      P('rainy-dehumid', '梅雨：除湿', 'rainy', '梅雨', '☔', true, '', '除湿運転（弱冷房除湿）', [{ label: '除湿', value: 'あり' }], '梅雨の窓辺。室内はさらっと快適。'),
      P('winter-heating', '冬：暖房パワー', 'winter', '冬', '❄️', false, '暖房能力の記載がありません', '', [], '雪の夜、暖かいオレンジの光に包まれた家族団らん。'),
    ],
    fridge: [
      P('yearend-freezer', '年末：大容量冷凍・まとめ買い', 'winter', '冬', '🎍', true, '', '冷凍室 103L', [{ label: '冷凍室容量', value: '103 L' }], '年末のまとめ買い。食材がたっぷり入る冷凍室。'),
      P('newlife-slim', '新生活：スリム設置', 'spring', '春', '🌸', false, '「薄型/スリム」の記載がありません', '', [], '新生活のキッチン。'),
      P('eco', '通年：省エネ', 'all', '通年', '🌿', true, '', '年間消費電力量 302kWh/年', [{ label: '年間消費電力量', value: '302 kWh/年' }], '明るいキッチン、グリーンのアクセント。'),
    ],
    fan: [
      P('summer-cool-fan', '夏：涼しさ', 'summer', '夏', '🌀', true, '', 'DCモーター 8段階風量', [{ label: '風量', value: '8段階' }], '夏のリビング、心地よいそよ風。'),
      P('night-quiet', '夏の夜：静音', 'summer', '夏', '🌙', false, '静音に関する記載がありません', '', [], '夏の夜の寝室。'),
    ],
    handy: [
      P('summer-cool-fan', '夏：涼しさ', 'summer', '夏', '🌀', true, '', '3段階風量 / 最大12時間', [{ label: '連続使用時間', value: '最大12時間' }], '真夏の屋外、手元で涼しく。'),
    ],
  };
  const COMMON = [
    P('ec-white', 'EC用：白背景', 'all', '通年', '⬜', true, '', '', [], '純白背景、柔らかい影、商品を中央に大きく。'),
    P('lifestyle', 'ライフスタイル', 'all', '通年', '🏠', true, '', '', [], '明るい日本の住まいで使われているシーン。'),
    P('sale-banner', 'セールバナー', 'all', '通年', '🏷', true, '', '', [], 'ブランドカラーのセールバナー。'),
  ];
  const svgUri = (w, h, icon, label, sub, season) => {
    const [c1, c2] = SEASON_COL[season] || SEASON_COL.all;
    const s = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><rect x="${w * 0.22}" y="${h * 0.3}" width="${w * 0.56}" height="${h * 0.3}" rx="${w * 0.04}" fill="#fff" stroke="#cfd6e0"/><text x="50%" y="${h * 0.22}" font-size="${w * 0.12}" text-anchor="middle">${icon}</text><text x="50%" y="${h * 0.48}" font-size="${w * 0.06}" text-anchor="middle" fill="#004098" font-family="sans-serif" font-weight="bold">${label.replace(/[<&>]/g, '')}</text><text x="50%" y="${h * 0.78}" font-size="${w * 0.045}" text-anchor="middle" fill="#1f2328" font-family="sans-serif">${sub.replace(/[<&>]/g, '')}</text></svg>`;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(s);
  };
  const productOf = async (sku) => {
    const list = (await mock.products({})).items;
    const p = list.find((x) => x.sku === sku) || list[0];
    return { sku: p.sku, title: p.title, brand: p.brand, group: p.group, group_label: p.group_label, image_url: p.image_url, has_image: !!p.image_url && p.group !== 'fan' };
  };
  const presetsFor = (group) => [...(PRESETS[group] || []), ...COMMON];
  const ts = () => new Date().toISOString().replace(/\D/g, '').slice(0, 14).replace(/^(\d{8})/, '$1-');
  const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
  const DOCS = {};
  return {
    async imagePresets(sku) {
      await sleep(250);
      const product = await productOf(sku);
      return {
        sku: product.sku, product, presets: clone(presetsFor(product.group)),
        options: {
          models: [{ id: 'gemini-3.1-flash-image', label: 'Flash（高速・標準）' }, { id: 'gemini-3-pro-image', label: 'Pro（高品質・文字入れ向き）' }],
          default_model: 'gemini-3.1-flash-image',
          sizes: [{ value: 300, label: '300×300' }, { value: 600, label: '600×600' }, { value: 1024, label: '1024×1024' }, { value: 0, label: '元サイズ' }],
          default_size: 300, aspects: ['1:1', '4:3', '3:4', '16:9'], default_aspect: '1:1',
          text_modes: [{ id: 'none', label: '文字なし' }, { id: 'copy', label: 'キャッチコピーのみ' }, { id: 'spec', label: 'スペック入り' }], default_text_mode: 'none',
          counts: [2, 3, 4], default_count: 3, bucket: BUCKET,
        },
      };
    },
    async productImages(sku) {
      await sleep(200);
      const p = await productOf(sku);
      return { sku, registered: p.has_image ? [{ url: p.image_url, kind: 'original', label: '登録画像（カタログ）' }] : [], images: clone((imgState[sku] || []).filter((r) => r.status !== 'deleted')) };
    },
    async uploadBaseImage(sku, file, onProgress) {
      for (let i = 1; i <= 5; i++) { await sleep(120); if (onProgress) onProgress(i / 5); }
      const name = `${sku}_base_${ts()}.jpg`;
      return { base: { type: 'upload', uri: `gs://${BUCKET}/${sku}/base/${name}`, url: URL.createObjectURL(file) } };
    },
    async searchImages(sku) {
      await sleep(1500);
      const p = await productOf(sku);
      const model = (p.title.match(/[A-Z]{1,4}-?[A-Z0-9]{3,}[A-Z0-9-]*/) || [p.sku])[0];
      const cands = [['eef2f7', 'メーカー公式'], ['f7f1e8', '家電レビュー'], ['eaf6ee', '量販店A'], ['f3eefa', 'カタログPDF']].map(([bg, src], i) => ({
        url: `https://placehold.co/800x800/${bg}/004098?text=${encodeURIComponent(model)}%0A${i + 1}`, page_url: `https://example.com/${encodeURIComponent(model)}/${i + 1}`,
        title: `${p.brand} ${model}｜${src}`, width: 800, height: 800, via: 'grounding' }));
      return { query: `${p.brand} ${model}`, candidates: cands, message: '' };
    },
    async generateImages(sku, body, onEvent, signal) {
      const chk = () => { if (signal && signal.aborted) throw abortErr(); };
      const p = await productOf(sku);
      const presets = presetsFor(p.group).filter((x) => (body.presets || []).includes(x.id));
      const pr = presets[0] || COMMON[0];
      const n = body.n || 3;
      const size = body.size || 1024;
      const [aw, ah] = String(body.aspect || '1:1').split(':').map(Number);
      const w = aw >= ah ? size : Math.round(size * aw / ah), h = ah >= aw ? size : Math.round(size * ah / aw);
      const t0 = Date.now();
      const prompt = `【商品】${p.title}（${p.brand}）\n【検証済みスペック】${presets.flatMap((x) => x.facts.map((f) => `${f.label}: ${f.value}`)).join(' / ') || '—'}\n【シーン】${presets.map((x) => x.prompt).join(' ')}\n【追加指示】${body.extra_prompt || 'なし'}\n【制約】商品の形状・色・ロゴを変えない。記載のない機能を描かない。${body.text_mode === 'none' ? '文字を入れない。' : ''}`;
      await sleep(400); chk();
      onEvent({ event: 'start', n, model: body.model, base_url: p.image_url, prompt, facts: presets.flatMap((x) => x.facts) });
      for (let i = 1; i <= n; i++) onEvent({ event: 'progress', index: i, status: 'generating' });
      for (let i = 1; i <= n; i++) {
        await sleep(900 + Math.random() * 700); chk();
        onEvent({ event: 'progress', index: i, status: 'checking' });
        await sleep(350); chk();
        const ps = presets.length ? presets[(i - 1) % presets.length] : pr;
        if (i === 3 && n === 4) { onEvent({ event: 'image_error', index: i, message: '安全フィルタにより生成できませんでした（モック）' }); continue; }
        const id = `${sku}_${ps.id}_${ts()}_${i}`;
        const score = i === 2 ? 0.64 : +(0.86 + Math.random() * 0.1).toFixed(2);
        const row = { image_id: id, sku, gcs_uri: `gs://${BUCKET}/${sku}/${id}.jpg`, url: svgUri(w || 600, h || 600, ps.icon, ps.label, p.title.slice(0, 18), ps.season), kind: 'generated', status: 'candidate', is_primary: false,
          preset: ps.id, preset_label: ps.label, season: ps.season, prompt, extra_prompt: body.extra_prompt || '', base_image_uri: (body.base && body.base.uri) || p.image_url, source_url: '',
          model: body.model, width: w || 1024, height: h || 1024, aspect: body.aspect || '1:1', fidelity_score: score, fidelity_note: score >= 0.7 ? '同一商品。形状・色ともに一致。' : 'ロゴの位置が元画像と異なる可能性があります。',
          created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        (imgState[sku] = imgState[sku] || []).unshift(row);
        onEvent({ event: 'image', index: i, image: clone(row) });
      }
      onEvent({ event: 'complete', count: n, elapsed_ms: Date.now() - t0 });
    },
    async saveImages(sku, body) {
      await sleep(700);
      const rows = imgState[sku] || [];
      const saved = [];
      rows.forEach((r) => {
        if (body.primary_id) r.is_primary = r.image_id === body.primary_id;
        if ((body.image_ids || []).includes(r.image_id)) { r.status = 'saved'; r.updated_at = new Date().toISOString(); saved.push(clone(r)); }
      });
      const total = rows.filter((r) => r.status === 'saved').length + 1;
      return { saved, bq: { table: 'demo-project.product_enrichment.product_images', rows: saved.length },
        aics: body.update_aics ? { table: 'demo-project.ai_commerce_search_dataset.products_aics', updated: true, images_total: total, backup: `products_aics_backup_${ts().slice(0, 8)}`, message: '' } : null };
    },
    async deleteImage(sku, imageId) {
      await sleep(300);
      const r = (imgState[sku] || []).find((x) => x.image_id === imageId);
      if (!r) throw new ApiError('画像が見つかりません', 404);
      const wasSaved = r.status === 'saved';
      r.status = 'deleted';
      return { deleted: true, image_id: imageId, gcs_deleted: true, aics: wasSaved ? { table: 'demo-project.ai_commerce_search_dataset.products_aics', updated: true, images_total: (imgState[sku] || []).filter((x) => x.status === 'saved').length + 1 } : null };
    },
    // ── ② docs
    async docsUpload(file, onProgress) {
      for (let i = 1; i <= 6; i++) { await sleep(90 + Math.random() * 80); if (onProgress) onProgress(i / 6); }
      const uri = `gs://${BUCKET}/_docs_uploads/${ts().slice(0, 8)}/${Math.random().toString(16).slice(2, 10)}_${file.name}`;
      const f = { uri, name: file.name, mime: file.type || 'application/octet-stream', size: file.size, url: '' };
      DOCS[uri] = f;
      return { file: f };
    },
    async docsList(gcsUri) {
      await sleep(600);
      if (!/^gs:\/\//.test(gcsUri || '')) throw new ApiError('gs:// で始まるパスを指定してください', 400);
      const base = gcsUri.endsWith('/') ? gcsUri : gcsUri.replace(/[^/]+$/, '');
      if (/\.(pdf|png|jpe?g|webp|xlsx|csv)$/i.test(gcsUri)) return { files: [{ uri: gcsUri, name: gcsUri.split('/').pop(), mime: 'application/pdf', size: 820000 }], skipped: 0 };
      return { files: [
        { uri: base + 'daikin_S224ATES_spec.pdf', name: 'daikin_S224ATES_spec.pdf', mime: 'application/pdf', size: 1834221 },
        { uri: base + 'haier_fridge_catalog.png', name: 'haier_fridge_catalog.png', mime: 'image/png', size: 642113 },
        { uri: base + 'new_items_2026AW.xlsx', name: 'new_items_2026AW.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 48211 },
      ], skipped: 1 };
    },
    async docsExtract(body, onEvent, signal) {
      const chk = () => { if (signal && signal.aborted) throw abortErr(); };
      const list = (await mock.products({})).items;
      const air = list.find((x) => x.group === 'aircon') || list[0];
      const fr = list.find((x) => x.group === 'fridge') || list[0];
      const files = body.files || [];
      onEvent({ event: 'start', count: files.length, model: 'gemini-3.8-flash' });
      let np = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        chk(); onEvent({ event: 'file_start', index: i, name: f.name });
        await sleep(1300 + Math.random() * 900); chk();
        if (/fail|broken/i.test(f.name)) { onEvent({ event: 'file_error', index: i, name: f.name, message: 'ファイルを読み取れませんでした（モック）' }); continue; }
        const isFridge = /fridge|冷蔵|haier/i.test(f.name);
        const isX = /xlsx|csv/i.test(f.name);
        const mk = (idx, o) => ({ idx, jan: '', price: null, confidence: 0.9, ...o });
        let products;
        if (isX) {
          products = [
            mk(0, { model_number: 'AS-X403R-W', title: 'ノクリア 14畳 エアコン AS-X403R-W', brand: '富士通ゼネラル', category: 'エアコン', price: 228000, description: '新商品一覧（2026年秋冬）より。AI自動運転、熱交換器加熱除菌。',
              attributes: [{ key: 'cooling_capacity', label: '冷房能力', value: '4.0kW', evidence: '冷房 4.0kW', page: null }, { key: 'heating_capacity', label: '暖房能力', value: '5.0kW', evidence: '暖房 5.0kW', page: null }, { key: 'color', label: 'カラー', value: 'ホワイト', evidence: 'W(ホワイト)', page: null }],
              confidence: 0.88, matches: [], suggested_sku: null }),
            mk(1, { model_number: air.title.match(/[A-Z]{1,4}-?[A-Z0-9]{3,}[A-Z0-9-]*/)?.[0] || 'AN-22', title: air.title, brand: air.brand, category: 'エアコン', description: '',
              attributes: [{ key: 'price_campaign', label: 'キャンペーン価格', value: '¥79,800', evidence: '特価 79,800円', page: null }], confidence: 0.81,
              matches: [{ sku: air.sku, title: air.title, image_url: air.image_url, score: 0.95, why: '型番一致' }], suggested_sku: air.sku }),
          ];
        } else if (isFridge) {
          products = [mk(0, { model_number: 'JR-GX41E5', jan: '4562117089xxx', title: fr.title, brand: fr.brand, category: '冷蔵庫', price: 139800,
            description: '大容量406L。チルド室は-2℃〜+2℃で切り替え可能。冷凍室は引き出し2段で整理しやすい。',
            attributes: [{ key: 'total_capacity', label: '定格内容積', value: '406L', evidence: '定格内容積 406L', page: 1 }, { key: 'freezer_capacity', label: '冷凍室容量', value: '103L', evidence: '冷凍室 103L', page: 1 }, { key: 'annual_power_consumption', label: '年間消費電力量', value: '302kWh/年', evidence: '年間消費電力量 302kWh/年(50/60Hz)', page: 1 }, { key: 'dimensions', label: '外形寸法', value: '幅650×高さ1833×奥行671mm', evidence: 'W650×H1833×D671(mm)', page: 1 }],
            confidence: 0.94, matches: [{ sku: fr.sku, title: fr.title, image_url: fr.image_url, score: 0.97, why: '型番一致（色違いを除く）' }], suggested_sku: fr.sku })];
        } else {
          products = [mk(0, { model_number: 'S224ATES-W', jan: '4548848xxxxxx', title: 'ダイキン ルームエアコン Eシリーズ 6畳 S224ATES-W', brand: 'ダイキン', category: 'エアコン', price: 98000,
            description: '主に6畳向け。ストリーマ空気清浄、内部クリーン運転。室内機運転音（冷房）19dB。',
            attributes: [{ key: 'cooling_capacity', label: '冷房能力', value: '2.2(0.7〜3.0)kW', evidence: '冷房能力 2.2(0.7～3.0)kW', page: 2 }, { key: 'heating_capacity', label: '暖房能力', value: '2.5(0.6〜4.7)kW', evidence: '暖房能力 2.5(0.6～4.7)kW', page: 2 }, { key: 'cooling_noise_level', label: '運転音(冷房)', value: '19dB', evidence: '運転音 冷房 19dB', page: 3 }, { key: 'indoor_unit_weight', label: '室内機質量', value: '9kg', evidence: '質量 室内機 9kg', page: 3 }, { key: 'apf', label: '通年エネルギー消費効率(APF)', value: '5.8', evidence: 'APF 5.8', page: 2 }],
            confidence: 0.93, matches: [{ sku: air.sku, title: air.title, image_url: air.image_url, score: 0.71, why: '同カテゴリ・同畳数（型番不一致）' }, { sku: list[3] ? list[3].sku : air.sku, title: list[3] ? list[3].title : air.title, image_url: list[3] ? list[3].image_url : air.image_url, score: 0.32, why: 'ブランド一致なし' }], suggested_sku: null })];
        }
        np += products.length;
        const ti = 2400 + Math.round(Math.random() * 1500), to = 600 + Math.round(Math.random() * 400);
        onEvent({ event: 'file_done', index: i, name: f.name, uri: f.uri, mime: f.mime, document_type: isX ? 'product_list' : isFridge ? 'catalog' : 'spec_sheet', latency_ms: 1300 + Math.round(Math.random() * 2000), input_tokens: ti, output_tokens: to, products });
      }
      onEvent({ event: 'complete', files: files.length, products: np });
    },
    async docsPreview(body) {
      await sleep(450);
      const prod = body.product || {};
      let cur = { description: '', raw_attributes: {} };
      if (body.sku) { try { cur = (await mock.product(body.sku)).product; } catch (_) { /* new-ish */ } }
      const raw = cur.raw_attributes || {};
      const diff = [];
      const put = (field, label, before, after) => {
        before = before == null ? '' : String(before); after = after == null ? '' : String(after);
        let action = body.new_sku ? 'new' : !before ? 'add' : before === after ? 'keep' : body.mode === 'overwrite' ? 'overwrite' : 'keep';
        if (!after) action = 'keep';
        diff.push({ field, label, before, after: action === 'keep' && before ? before : after, action });
      };
      if (body.new_sku) { put('title', 'タイトル', '', prod.title); put('brand', 'ブランド', '', prod.brand); put('category', 'カテゴリ', '', prod.category); }
      put('description', '説明文', body.new_sku ? '' : cur.description, prod.description);
      (prod.attributes || []).forEach((a) => put('attr:' + a.key, a.label || a.key, body.new_sku ? '' : raw[a.key], a.value));
      return { sku: body.sku || body.new_sku, is_new: !!body.new_sku, diff, changes: diff.filter((d) => d.action !== 'keep').length };
    },
    async docsApply(body, onEvent, signal) {
      const chk = () => { if (signal && signal.aborted) throw abortErr(); };
      const t0 = Date.now();
      const items = body.items || [];
      onEvent({ event: 'start', count: items.length });
      const results = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const sku = it.sku || it.new_sku;
        chk(); onEvent({ event: 'item_start', index: i, sku });
        await sleep(600); chk();
        const pv = await mock.docsPreview(it);
        onEvent({ event: 'merged', index: i, sku, changes: pv.changes, diff: pv.diff });
        if (body.enrich) {
          await sleep(1500); chk();
          const fb = it.new_sku ? 0 : 0.42 + Math.random() * 0.2;
          onEvent({ event: 'enriched', index: i, sku, attr_count: 9 + i, tag_count: 3, status: i % 2 ? 'needs_review' : 'completed', fill_before: +fb.toFixed(3), fill_after: +(0.82 + Math.random() * 0.15).toFixed(3), latency_ms: 2100 + Math.round(Math.random() * 900) });
        }
        results.push({ sku, status: 'ok', changes: pv.changes });
      }
      await sleep(700); chk();
      const DS = 'demo-project.product_enrichment';
      onEvent({ event: 'saved', bq: { dataset: DS, tables: { [`${DS}.source_products`]: items.length, [`${DS}.enriched_attributes`]: items.length * 11, [`${DS}.sku_extras`]: items.length, [`${DS}.golden_records`]: items.length, [`${DS}.doc_extractions`]: items.length } } });
      if (body.update_aics) {
        await sleep(600); chk();
        onEvent({ event: 'aics', result: { table: 'demo-project.ai_commerce_search_dataset.products_aics', updated: items.filter((x) => x.sku).length, inserted: items.filter((x) => x.new_sku).length, backup: `products_aics_backup_${ts().slice(0, 8)}`, message: '' } });
      }
      onEvent({ event: 'complete', results, elapsed_ms: Date.now() - t0 });
    },
  };
}
