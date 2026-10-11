// ⑥ CSV ライブテスト — CSV アップロード → Gemini リアルタイム エンリッチ → BigQuery 保存
import { api, sampleCsvUrl } from '../api.js?v=3';
import {
  esc, $, $$, fmtInt, fmtPct, fmtJpy, fmtValue, chip, confBar, tip, emptyState, toast, state, stepper, refreshShell, STATUS,
} from '../ui.js?v=3';

const datasetRef = () => (state.config && state.config.dataset) || (S.bq && S.bq.dataset) || 'product_enrichment';
const BQ_TABLES = [
  ['source_products', '原本商品データ'],
  ['enriched_attributes', '抽出属性・タグ(判定付き)'],
  ['sku_extras', '検索キーワード・AI要約'],
  ['golden_records', 'ゴールデンレコード'],
  ['gmc_conversational', 'GMC 会話属性'],
];
const GROUP_SHORT = { fridge: '冷蔵庫', aircon: 'エアコン', fan: '扇風機', handy: 'ハンディファン' };

// Session survives navigation (a running job keeps streaming in the background).
const S = {
  items: [], columns: [], csvText: '', rows: {}, running: false, ctrl: null, t0: 0, tin: 0, tout: 0,
  current: null, doneSkus: [], bq: null, bqSaving: false, complete: null, gmc: {}, open: new Set(), paint: null, showText: false,
};

export const modelPretty = () => {
  const m = (state.config && state.config.model) || 'gemini-3.8-flash';
  return m.replace(/^gemini-/i, 'Gemini ').replace(/-/g, ' ').replace(/\b(flash|pro|lite)\b/gi, (x) => x[0].toUpperCase() + x.slice(1));
};
const estCost = (tin, tout) => (tin * 0.3 + tout * 2.5) / 1e6 * 150; // online list price (JPY)

export async function render(root, _params, stale) {
  const model = (state.config && state.config.model) || 'gemini-3.8-flash';
  root.innerHTML = `
    <div class="csv-hero">
      <div class="csv-hero-txt">
        <h1>CSV ライブテスト<span class="h1-sub">(リアルタイム エンリッチ &amp; BigQuery 保存)</span></h1>
        <p>CSVファイルをアップロード(またはサンプルCSVを読込)すると、<b class="mono">${esc(model)}</b> がリアルタイムで
        <b>属性抽出・単位正規化・3段階ゲート判定・GMC会話属性生成</b>を行い、BigQuery(<span class="mono">${esc(datasetRef().split('.').pop())}</span> データセット全5テーブル)に即時保存します。</p>
      </div>
      <div class="csv-hero-act">
        <button class="btn btn-primary" id="btn-csv-sample">⚡ サンプルCSV (3商品) をワンクリック読込</button>
        <a class="btn btn-outline" href="${sampleCsvUrl}" download>⬇ サンプルCSVダウンロード</a>
      </div>
    </div>

    <div class="panel csv-upload">
      <div class="csv-up-grid">
        <label class="dropzone" id="dropzone" for="csv-file">
          <input type="file" id="csv-file" accept=".csv,text/csv" hidden>
          <div class="dz-ic">📄</div>
          <div class="dz-title">CSV ファイルをドラッグ&amp;ドロップ</div>
          <div class="dz-sub">またはクリックしてファイルを選択(UTF-8 / Shift_JIS・最大50行)</div>
          <div class="dz-file" id="dz-file"></div>
        </label>
        <div class="csv-help">
          <div class="sec-lab">対応している列 ${tip('?', '列名は日本語・英語どちらでも自動認識します。未知の列はすべて「原本属性」として扱い、Gemini が正規化します')}</div>
          <div class="col-pills">${['sku / 商品コード', 'title / 商品名', 'brand / メーカー', 'category / カテゴリ', 'description / 説明文', 'price / 価格', 'image_url', 'product_url', '+ 任意の属性列 (dimensions, weight …)'].map((c) => `<span class="kvp">${esc(c)}</span>`).join('')}</div>
          <button class="btn btn-ghost btn-sm" id="btn-toggle-text">✎ CSVテキストを直接貼り付け / 編集</button>
        </div>
      </div>
      <div class="csv-text-wrap" id="csv-text-wrap" ${S.showText ? '' : 'hidden'}>
        <textarea class="input csv-text" id="csv-text" spellcheck="false" placeholder="sku,title,brand,category,description,price,dimensions,weight&#10;...">${esc(S.csvText)}</textarea>
        <div class="csv-text-act"><button class="btn btn-outline btn-sm" id="btn-reparse">↻ CSVを再解析</button><span class="muted small" id="csv-cols"></span></div>
      </div>
      <div class="csv-controls">
        <label class="chk"><input type="checkbox" id="chk-save-bq" checked><span>エンリッチ完了時に BigQuery (<span class="mono">${esc(datasetRef())}</span>) へ自動保存する</span></label>
        <span class="spacer"></span>
        <button class="btn btn-outline" id="btn-csv-save-bq" disabled>☁️ BigQuery に今すぐ保存</button>
        <button class="btn btn-primary btn-live" id="btn-csv-run" disabled><span class="live-ic">▶</span><span class="live-txt">${esc(modelPretty())} でリアルタイム実行 (0件)</span></button>
      </div>
    </div>

    <div id="csv-progress"></div>
    <div id="csv-bq"></div>
    <div class="panel csv-table-panel">
      <div class="panel-head"><h2>商品一覧 <span class="muted small" id="csv-count"></span></h2>
        <span class="muted small">行をクリックすると Before / After と GMC Q&amp;A を展開します</span></div>
      <div id="csv-rows"></div>
    </div>`;

  // ── handlers
  const loadText = async (text, label) => {
    try {
      const d = await api.csvParse({ csv_text: text });
      setItems(d.items || [], d.columns || [], text);
      toast(`${label}: ${d.count} 件を読み込みました`, 'ok');
    } catch (e) { toast('CSVを解析できませんでした: ' + e.message, 'err', 6000); }
  };
  const setItems = (items, cols, text) => {
    if (S.running) { toast('実行中は読み込めません', 'warn'); return; }
    S.items = items; S.columns = cols; S.csvText = text; S.rows = {}; S.doneSkus = []; S.bq = null; S.complete = null; S.gmc = {}; S.open.clear();
    const ta = $('#csv-text', root); if (ta) ta.value = text;
    paint();
  };
  $('#btn-csv-sample', root).onclick = async (e) => {
    const b = e.currentTarget; b.disabled = true; b.classList.add('loading');
    try {
      const d = await api.csvSample();
      setItems(d.items || [], d.columns || [], d.csv_text || '');
      $('#dz-file', root).textContent = '✓ サンプルCSV(aics_live_test_sample.csv)';
      toast(`サンプルCSV ${d.count} 商品を読み込みました`, 'ok');
    } catch (err) { toast('サンプルを取得できませんでした: ' + err.message, 'err'); } finally { b.disabled = false; b.classList.remove('loading'); }
  };
  const readFile = async (file) => {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('ファイルが大きすぎます(5MBまで)', 'warn'); return; }
    const buf = await file.arrayBuffer();
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { text = new TextDecoder('shift_jis').decode(buf); }
    $('#dz-file', root).textContent = `✓ ${file.name}(${fmtInt(file.size / 1024)} KB)`;
    loadText(text, file.name);
  };
  $('#csv-file', root).addEventListener('change', (e) => readFile(e.target.files[0]));
  const dz = $('#dropzone', root);
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => readFile(e.dataTransfer.files[0]));
  $('#btn-toggle-text', root).onclick = () => { S.showText = !S.showText; $('#csv-text-wrap', root).hidden = !S.showText; };
  $('#btn-reparse', root).onclick = () => loadText($('#csv-text', root).value, '再解析');
  $('#btn-csv-run', root).onclick = () => run();
  $('#btn-csv-save-bq', root).onclick = () => saveBq();
  $('#csv-rows', root).addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    const row = e.target.closest('.csv-row'); if (!row) return;
    const sku = row.dataset.sku;
    if (S.open.has(sku)) S.open.delete(sku); else { S.open.add(sku); loadGmc(sku); }
    paintRows();
  });

  // ── painting
  function paint() {
    if (stale()) return;
    paintControls(); paintProgress(); paintBq(); paintRows();
  }
  function paintControls() {
    const run = $('#btn-csv-run', root); if (!run) return;
    run.disabled = S.running || !S.items.length;
    run.classList.toggle('running', S.running);
    $('.live-txt', run).textContent = S.running ? `実行中… ${S.current ? S.current.index + 1 : 0}/${S.items.length}` : `${modelPretty()} でリアルタイム実行 (${S.items.length}件)`;
    const sb = $('#btn-csv-save-bq', root);
    sb.disabled = S.running || S.bqSaving || !S.doneSkus.length;
    sb.classList.toggle('loading', S.bqSaving);
    sb.textContent = S.bq ? '☁️ BigQuery に再保存' : '☁️ BigQuery に今すぐ保存';
    $('#chk-save-bq', root).disabled = S.running;
    const cc = $('#csv-cols', root); if (cc) cc.textContent = S.columns.length ? `${S.columns.length} 列: ${S.columns.slice(0, 8).join(', ')}${S.columns.length > 8 ? ' …' : ''}` : '';
    $('#csv-count', root).textContent = S.items.length ? `${S.items.length} 件` : '';
  }
  function paintProgress() {
    const box = $('#csv-progress', root); if (!box) return;
    if (!S.running && !S.complete) { box.innerHTML = ''; return; }
    const total = S.items.length || 1;
    const done = Object.values(S.rows).filter((r) => r.state === 'done' || r.state === 'error').length;
    const pct = S.complete ? 100 : Math.round(done / total * 100);
    const el = ((S.complete ? S.complete.elapsed_ms : performance.now() - S.t0) / 1000).toFixed(1);
    const cost = S.complete && S.complete.cost_jpy != null ? S.complete.cost_jpy : estCost(S.tin, S.tout);
    const cur = S.bqSaving ? `☁️ BigQuery (${datasetRef()}) に保存中…` : S.complete ? `✅ 完了 — ${S.complete.processed}/${S.complete.total} SKU を処理しました` : S.current ? `⚙️ ${S.current.index + 1}/${total} 件目: ${S.current.title}` : '開始しています…';
    box.innerHTML = `<div class="panel csv-prog ${S.complete ? 'done' : ''}">
      <div class="cp-top"><div class="cp-cur">${S.running ? '<span class="live-dot"></span>' : ''}<span>${esc(cur)}</span></div><div class="cp-pct">${pct}%</div></div>
      <div class="cp-bar"><div class="cp-fill" style="width:${pct}%"></div></div>
      <div class="cp-stats">
        <div><span class="k">経過時間</span><b>${el}</b> 秒</div>
        <div><span class="k">処理済</span><b>${done}</b> / ${S.items.length} SKU</div>
        <div><span class="k">トークン(入/出)</span><b>${fmtInt(S.tin)}</b> / <b>${fmtInt(S.tout)}</b></div>
        <div><span class="k">${S.complete ? 'オンライン実行コスト' : '推定コスト(オンライン)'}</span><b>${fmtJpy(cost, 2)}</b></div>
        <div><span class="k">モデル</span><b class="mono">${esc((S.complete && S.complete.model) || (state.config && state.config.model) || '')}</b></div>
      </div></div>`;
  }
  function paintBq() {
    const box = $('#csv-bq', root); if (!box) return;
    if (!S.bq) { box.innerHTML = ''; return; }
    // Backend keys may be dataset-qualified ("project.dataset.table") — normalize to the bare table name.
    const t = {};
    Object.entries(S.bq.tables || {}).forEach(([k, v]) => { t[String(k).split('.').pop()] = v; });
    box.innerHTML = `<div class="bq-card">
      <div class="bq-head"><span class="bq-ic">☁️</span><div><div class="bq-title">BigQuery 保存完了</div>
        <div class="bq-sub">データセット <span class="mono">${esc(datasetRef())}</span> に <b>${fmtInt(S.bq.skus)}</b> SKU 分を書き込みました</div></div></div>
      <div class="bq-tables">${BQ_TABLES.map(([k, lab]) => `<div class="bq-t"><div class="bq-n">${fmtInt(t[k] ?? 0)}<span>行</span></div><div class="bq-k mono">${esc(k)}</div><div class="bq-l">${esc(lab)}</div></div>`).join('')}</div>
    </div>`;
  }
  function paintRows() {
    const box = $('#csv-rows', root); if (!box) return;
    if (!S.items.length) { box.innerHTML = emptyState('📥', 'CSV がまだ読み込まれていません', '「⚡ サンプルCSV をワンクリック読込」か、CSV ファイルをドロップしてください'); return; }
    box.innerHTML = `<div class="csv-head"><span></span><span>商品</span><span>カテゴリ</span><span class="r">価格</span><span>原本属性</span><span>充足率 Before ➜ After</span><span>抽出結果</span><span>状態</span><span></span></div>` +
      S.items.map((p) => rowHtml(p)).join('');
  }
  function rowHtml(p) {
    const r = S.rows[p.sku] || { state: 'wait' };
    const open = S.open.has(p.sku);
    const keys = Object.keys(p.raw_attributes || {});
    const fb = r.fill_before ?? p.fill_before ?? 0;
    const fa = r.fill_after;
    const badge = r.state === 'run' ? '<span class="chip chip-info pulse">実行中...</span>'
      : r.state === 'error' ? `<span class="chip chip-bad" title="${esc(r.message)}">エラー</span>`
        : r.state === 'done' ? chip(r.status === 'completed' ? 'completed' : r.status) : '<span class="chip chip-mute">待機中</span>';
    return `<div class="csv-row st-${r.state} ${open ? 'open' : ''}" data-sku="${esc(p.sku)}">
      <span class="cr-chev">${open ? '▾' : '▸'}</span>
      <div class="cr-prod"><div class="cr-title" title="${esc(p.title)}">${esc(p.title)}</div><div class="muted small"><span class="mono">${esc(p.sku)}</span>${p.brand ? ' ・ ' + esc(p.brand) : ''}</div></div>
      <span><span class="cat-pill">${esc(GROUP_SHORT[p.group] || p.group_label || p.group)}</span></span>
      <span class="r nowrap">${p.price ? '¥' + fmtInt(p.price) : '—'}</span>
      <div class="cr-raw"><b>${keys.length}</b> 項目<div class="cr-raw-pills">${keys.slice(0, 3).map((k) => `<span class="kvp" title="${esc(k)}: ${esc(p.raw_attributes[k])}">${esc(k)}</span>`).join('')}${keys.length > 3 ? `<span class="kvp more">+${keys.length - 3}</span>` : ''}</div></div>
      <div class="cr-fill">
        <div class="fb-row"><span class="fb-lab">Before</span><div class="fb-track"><div class="fb-fill fb-before" style="width:${fb * 100}%"></div></div><span class="fb-num">${fmtPct(fb)}</span></div>
        <div class="fb-row"><span class="fb-lab">After</span><div class="fb-track">${fa != null ? `<div class="fb-fill fb-after" style="width:${fa * 100}%"></div>` : ''}</div><span class="fb-num fb-num-after">${fa != null ? fmtPct(fa) : '—'}</span></div>
        ${fa != null ? `<span class="delta up">+${Math.round((fa - fb) * 100)} pt</span>` : ''}
      </div>
      <div class="cr-metrics">${r.state === 'done' ? `<span title="正規化済み属性">🧩 ${fmtInt(r.attr_count)}</span><span title="機能タグ">🏷 ${fmtInt(r.tag_count)}</span><span title="GMC Q&A">💬 ${fmtInt(r.qa_count)}</span><span class="muted mono" title="レイテンシ">${fmtInt(r.latency_ms)}ms</span>` : r.state === 'run' ? '<span class="muted">Gemini 処理中…</span>' : '<span class="muted">—</span>'}</div>
      <span>${badge}</span>
      <div class="cr-act">${r.state === 'done' ? `<a class="btn btn-ghost btn-sm" href="#/studio/${encodeURIComponent(p.sku)}" title="スタジオで詳細を見る">✨ スタジオ</a><a class="btn btn-ghost btn-sm" href="#/gmc/${encodeURIComponent(p.sku)}" title="GMC 会話属性を見る">🛍 GMC</a>` : ''}</div>
    </div>${open ? `<div class="csv-detail">${detailHtml(p, r)}</div>` : ''}`;
  }
  function detailHtml(p, r) {
    const keys = Object.keys(p.raw_attributes || {});
    const before = `<div class="cd-col"><div class="sec-lab"><span class="ba-tag before">Before</span> 原本</div>
      <div class="cd-desc">${esc(p.description || '(説明文なし)')}</div>
      <table class="raw-table small"><tbody>${keys.map((k) => `<tr><th>${esc(k)}</th><td>${esc(p.raw_attributes[k])}</td></tr>`).join('') || '<tr><td class="muted">原本属性なし</td></tr>'}</tbody></table></div>`;
    if (r.state !== 'done' || !r.detail) {
      return before + `<div class="cd-col"><div class="sec-lab"><span class="ba-tag after">After</span> エンリッチ後</div>${emptyState('⏳', r.state === 'run' ? 'Gemini が処理中です…' : 'まだ実行していません', '「リアルタイム実行」を押すと結果がここに表示されます')}</div>`;
    }
    const recs = r.detail.records || [];
    const attrs = recs.filter((x) => x.kind === 'attribute');
    const tags = recs.filter((x) => x.kind === 'tag');
    const g = S.gmc[p.sku];
    const qas = g && g.gmc ? g.gmc.questions_and_answers || [] : null;
    return before + `<div class="cd-col"><div class="sec-lab"><span class="ba-tag after">After</span> エンリッチ後 <span class="muted small">${attrs.length} 属性 ・ ${tags.length} タグ</span></div>
      <div class="cd-attrs">${attrs.map((a) => `<span class="attr-pill st-${(STATUS[a.gate_status] || {}).cls || 'mute'}" title="raw: ${esc(a.raw_value)} / score ${a.score}"><span class="ap-k">${esc(a.label)}</span><b>${esc(a.value === null ? '変換不可' : fmtValue(a.value))}</b>${esc(a.unit || '')}</span>`).join('') || '<span class="muted">抽出なし</span>'}</div>
      <div class="tags" style="margin-top:8px">${tags.map((t) => `<span class="tag">${esc(t.label)}</span>`).join('')}</div>
      ${r.detail.extras && r.detail.extras.ai_summary ? `<div class="summary" style="margin-top:10px">🤖 ${esc(r.detail.extras.ai_summary)}</div>` : ''}
      <div class="sec-lab" style="margin-top:12px">🛍 GMC 会話属性 Q&amp;A <span class="muted small">question_and_answer</span></div>
      ${qas === null ? '<div class="muted small">読み込み中…</div>' : qas.length ? `<div class="qa-mini">${qas.map((q) => `<div class="qm"><div class="qm-q">Q. ${esc(q.question)}</div><div class="qm-a">A. ${esc(q.answer)} ${q.evidence_match > 0 ? '<span class="chip chip-ok">根拠確認済</span>' : '<span class="chip chip-warn">要確認</span>'}</div></div>`).join('')}</div>` : '<div class="muted small">Q&A なし</div>'}
    </div>`;
  }
  async function loadGmc(sku) {
    const r = S.rows[sku];
    if (!r || r.state !== 'done' || S.gmc[sku]) return;
    try { S.gmc[sku] = await api.gmcDetail(sku); } catch (e) { S.gmc[sku] = { gmc: { questions_and_answers: [] } }; }
    if (S.paint) S.paint.rows();
  }

  // ── run
  async function run() {
    if (S.running || !S.items.length) return;
    const save = $('#chk-save-bq', root).checked;
    Object.assign(S, { running: true, t0: performance.now(), tin: 0, tout: 0, current: null, doneSkus: [], bq: null, complete: null, rows: {}, gmc: {}, ctrl: new AbortController() });
    S.items.forEach((p) => { S.rows[p.sku] = { state: 'wait' }; });
    stepper.startLive(`CSV ${S.items.length}件`);
    const agg = { attrs: 0, tags: 0, ok: 0, auto: 0, review: 0, rejected: 0 };
    const tick = setInterval(() => { if (S.paint) S.paint.progress(); }, 200);
    S.paint && S.paint.all();
    const onEvent = (ev) => {
      switch (ev.event) {
        case 'start':
          stepper.setState(0, 'done'); stepper.setCount(0, `<b>${fmtInt(ev.total)}</b> SKU 読込`);
          break;
        case 'sku_start':
          S.current = ev;
          if (S.rows[ev.sku]) S.rows[ev.sku].state = 'run';
          stepper.setState(1, 'running'); stepper.setCount(1, `抽出中 ${ev.index + 1}/${ev.total}`);
          break;
        case 'sku_done': {
          S.rows[ev.sku] = { ...ev, state: 'done' };
          S.tin += ev.input_tokens || 0; S.tout += ev.output_tokens || 0;
          S.doneSkus.push(ev.sku);
          const recs = (ev.detail && ev.detail.records) || [];
          agg.attrs += ev.attr_count || 0; agg.tags += ev.tag_count || 0;
          agg.ok += recs.filter((x) => x.kind === 'attribute' && x.value !== null).length;
          agg.auto += recs.filter((x) => x.gate_status === 'auto_approved').length;
          agg.review += recs.filter((x) => x.gate_status === 'needs_review').length;
          agg.rejected += recs.filter((x) => x.gate_status === 'rejected').length;
          const last = ev.index + 1 >= ev.total;
          stepper.setState(1, last ? 'done' : 'running'); stepper.setCount(1, `<b>${fmtInt(agg.attrs)}</b> 属性 + <b>${fmtInt(agg.tags)}</b> タグ`);
          stepper.setState(2, 'done'); stepper.setCount(2, `<b>${fmtInt(agg.ok)}</b>/${fmtInt(agg.attrs)} OK`);
          stepper.setState(3, 'done'); stepper.setCount(3, `<span class="sc-ok">自動 <b>${fmtInt(agg.auto)}</b></span> <span class="sc-warn">要確認 <b>${fmtInt(agg.review)}</b></span>`);
          if (S.open.has(ev.sku)) loadGmc(ev.sku);
          break;
        }
        case 'sku_error':
          S.rows[ev.sku] = { state: 'error', message: ev.message };
          toast(`${ev.sku}: ${ev.message}`, 'err', 6000);
          break;
        case 'bq_saving':
          S.bqSaving = true;
          stepper.setState(4, 'running'); stepper.setCount(4, 'BigQuery 保存中…');
          break;
        case 'complete':
          S.complete = ev; S.bqSaving = false;
          if (ev.input_tokens != null) { S.tin = ev.input_tokens; S.tout = ev.output_tokens; }
          if (ev.bq_result) {
            S.bq = ev.bq_result;
            stepper.setState(4, 'done'); stepper.setCount(4, `<b>${fmtInt(ev.bq_result.skus)}</b> SKU → BigQuery`);
          } else {
            stepper.setState(4, ev.processed ? 'done' : 'error'); stepper.setCount(4, `<b>${fmtInt(ev.processed)}</b> SKU(BQ未保存)`);
          }
          break;
        case 'error':
          S.bqSaving = false;
          toast(ev.message || 'エラーが発生しました', 'err', 7000);
          break;
        default: break;
      }
      if (S.paint) S.paint.all();
    };
    try {
      await api.csvEnrich({ products: S.items, csv_text: S.csvText, save_to_bq: save }, onEvent, S.ctrl.signal);
      if (S.complete) toast(`${S.complete.processed}/${S.complete.total} SKU のエンリッチが完了しました${S.bq ? '(BigQuery 保存済)' : ''}`, 'ok', 5000);
      else toast('結果を受信できませんでした', 'warn');
    } catch (e) {
      if (e.name !== 'AbortError') toast('実行に失敗しました: ' + e.message, 'err', 7000);
    } finally {
      clearInterval(tick);
      S.running = false; S.bqSaving = false; S.current = null;
      Object.values(S.rows).forEach((r) => { if (r.state === 'run') r.state = 'error'; });
      state.products = null; // new SKUs → reload product list (studio / products)
      refreshShell();
      stepper.endLive(12000);
      if (S.paint) S.paint.all();
    }
  }

  async function saveBq() {
    if (!S.doneSkus.length || S.bqSaving) return;
    S.bqSaving = true; paint();
    stepper.startLive('BigQuery');
    stepper.setState(4, 'running'); stepper.setCount(4, 'BigQuery 保存中…');
    try {
      const res = await api.csvSaveBq(S.doneSkus);
      S.bq = { skus: res.skus, tables: res.tables };
      stepper.setState(4, 'done'); stepper.setCount(4, `<b>${fmtInt(res.skus)}</b> SKU → BigQuery`);
      toast(`BigQuery に ${res.skus} SKU を保存しました`, 'ok');
    } catch (e) {
      stepper.setState(4, 'error');
      toast('BigQuery 保存に失敗しました: ' + e.message, 'err', 7000);
    } finally { S.bqSaving = false; stepper.endLive(8000); paint(); }
  }

  S.paint = { all: paint, progress: paintProgress, rows: paintRows };
  paint();
  return () => { S.paint = null; };
}
