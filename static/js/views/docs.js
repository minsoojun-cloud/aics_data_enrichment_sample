// ⑧ 資料から抽出 — PDF / 画像 / Excel / CSV から商品情報を抽出 → 商品IDを指定 → BigQuery に反映（再エンリッチ）
import { api } from '../api.js?v=3';
import { esc, $, $$, fmtInt, fmtPct, toast, state, productList, refreshShell } from '../ui.js?v=3';

const ACCEPT = ['.jpg', '.jpeg', '.png', '.webp', '.pdf', '.xlsx', '.csv'];
const MAX_SIZE = 30 * 1024 * 1024;
const MAX_FILES = 20;
const DOC_TYPES = { spec_sheet: '仕様書', catalog: 'カタログ', product_list: '商品リスト', manual: '取扱説明書', price_list: '価格表', flyer: 'チラシ', other: 'その他' };
const ACTIONS = { add: ['追加', 'add'], overwrite: ['上書き', 'ow'], keep: ['変更なし', 'keep'], new: ['新規', 'new'] };
const BQ_LABELS = { source_products: '原本商品データ', enriched_attributes: '抽出属性・タグ', sku_extras: '検索キーワード・AI要約', golden_records: 'ゴールデンレコード', doc_extractions: '資料抽出ログ', gmc_conversational: 'GMC 会話属性' };

// Session survives navigation (results stay visible when coming back from the studio).
const S = {
  files: [], seq: 0, gcs: '', listing: false, uploading: false,
  extract: null, products: [], apply: null, updateAics: true,
  ctrl: null, upCtrl: null, root: null, plist: [],
};

function fileKind(name, mime) {
  const n = String(name || '').toLowerCase(); const m = String(mime || '');
  if (n.endsWith('.pdf') || m.includes('pdf')) return { k: 'pdf', lab: 'PDF', ic: '📕' };
  if (n.endsWith('.xlsx') || m.includes('spreadsheet')) return { k: 'xls', lab: 'Excel', ic: '📗' };
  if (n.endsWith('.csv') || m.includes('csv')) return { k: 'csv', lab: 'CSV', ic: '📄' };
  if (/\.(jpe?g|png|webp)$/.test(n) || m.startsWith('image/')) return { k: 'img', lab: '画像', ic: '🖼' };
  return { k: 'oth', lab: 'ファイル', ic: '📎' };
}
const fmtSize = (b) => (b == null ? '—' : b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const alive = (root) => S.root === root && document.body.contains(root);

export async function render(root) {
  S.root = root;
  root.innerHTML = `
    <div class="im-hero dc-hero">
      <div class="im-hero-txt">
        <h1>📄 資料から抽出<span class="h1-sub">(仕様書・カタログ・Excel から商品情報を取り込み)</span></h1>
        <p>メーカーの<b>仕様書 PDF・カタログ画像・Excel / CSV</b> を読み込むと、Gemini が型番・スペック・説明文を<b>根拠（ページ）付き</b>で抜き出します。
        どの商品に反映するかを確認してから BigQuery に保存し、自動で再エンリッチします。</p>
      </div>
    </div>
    <div class="dc-steps" id="dc-steps"></div>
    <section class="panel dc-sec" id="dc-s1"></section>
    <section id="dc-s2"></section>
    <section id="dc-s3"></section>
    <section id="dc-s4"></section>
    <datalist id="dc-plist"></datalist>`;

  // NOTE: #view persists across routes → listeners must be removed in cleanup.
  const hClick = (e) => onClick(root, e);
  const hChange = (e) => onChange(root, e);
  const hInput = (e) => onInput(root, e);
  root.addEventListener('click', hClick);
  root.addEventListener('change', hChange);
  root.addEventListener('input', hInput);

  paintSteps(root); paintS1(root); paintS2(root); paintS3(root); paintS4(root);
  productList().then((l) => {
    S.plist = l || [];
    const dl = $('#dc-plist', root);
    if (dl && alive(root)) dl.innerHTML = S.plist.map((p) => `<option value="${esc(p.sku)}" label="${esc(p.group_label || '')}｜${esc(p.title)}">${esc(p.group_label || '')}｜${esc(p.title)}</option>`).join('');
  }).catch(() => {});

  return () => {
    root.removeEventListener('click', hClick); root.removeEventListener('change', hChange); root.removeEventListener('input', hInput);
    if (S.ctrl) S.ctrl.abort();
    if (S.upCtrl) S.upCtrl.abort();
    S.root = null;
  };
}

// ── Painting ──────────────────────────────────────────────────────────────
function curStep() {
  if (S.apply) return S.apply.complete ? 5 : 4;
  if (S.extract && S.extract.complete && S.products.length) return 3;
  if (S.extract) return 2;
  return 1;
}
function paintSteps(root) {
  const el = $('#dc-steps', root); if (!el) return;
  const cur = curStep();
  const steps = [['入力', 'ファイルを選ぶ'], ['抽出', 'Gemini が読み取り'], ['確認・商品ID指定', '反映先と差分を確認'], ['BigQuery反映', '保存＋再エンリッチ']];
  el.innerHTML = steps.map(([t, s], i) => {
    const n = i + 1; const st = n < cur ? 'done' : n === cur ? 'active' : '';
    return `${i ? '<div class="dcs-arrow"></div>' : ''}<div class="dcs ${st}"><div class="dcs-n">${n < cur ? '✓' : n}</div><div><div class="dcs-t">${esc(t)}</div><div class="dcs-s">${esc(s)}</div></div></div>`;
  }).join('');
}

function paintS1(root) {
  const el = $('#dc-s1', root); if (!el) return;
  const locked = !!(S.extract && S.extract.running) || !!(S.apply && S.apply.running);
  el.innerHTML = `
    <div class="im-sec-h"><span class="im-step">1</span><h2>資料を選ぶ</h2><span class="muted small">PDF・画像（JPG/PNG/WebP）・Excel（.xlsx）・CSV ／ 1ファイル 30MB・最大 ${MAX_FILES} ファイル</span>
      <span class="spacer"></span>${S.files.length || S.extract ? `<button class="btn btn-ghost btn-sm" data-act="reset" ${locked ? 'disabled' : ''}>↺ 最初からやり直す</button>` : ''}</div>
    <div class="dc-in-grid">
      <div class="dc-in-card">
        <div class="dc-in-h">☁️ Cloud Storage から読み込む</div>
        <div class="dc-gcs-row">
          <input class="input mono" id="dc-gcs" type="text" spellcheck="false" placeholder="gs://bucket/folder/  または  gs://bucket/spec.pdf" value="${esc(S.gcs)}" ${locked ? 'disabled' : ''}>
          <button class="btn btn-outline ${S.listing ? 'loading' : ''}" data-act="list" ${S.listing || locked ? 'disabled' : ''}>📂 一覧取得</button>
        </div>
        <div class="muted small">フォルダを指定すると、対応形式のファイルをまとめて追加します（最大 ${MAX_FILES} 件）</div>
      </div>
      <label class="dropzone dc-drop" id="dc-drop" for="dc-file">
        <input type="file" id="dc-file" multiple accept="${ACCEPT.join(',')}" hidden ${locked ? 'disabled' : ''}>
        <div class="dz-ic">📥</div>
        <div class="dz-title">ファイルをドラッグ&amp;ドロップ（複数可）</div>
        <div class="dz-sub">またはクリックして選択 ・ <span class="dc-types"><span class="ft ft-pdf">PDF</span><span class="ft ft-img">画像</span><span class="ft ft-xls">Excel</span><span class="ft ft-csv">CSV</span></span></div>
      </label>
    </div>
    <div id="dc-files"></div>`;
  const dz = $('#dc-drop', el);
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); if (!locked) dz.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('over'); }));
  dz.addEventListener('drop', (e) => { if (!locked) addFiles(root, e.dataTransfer.files); });
  paintFiles(root);
}

function paintFiles(root) {
  const el = $('#dc-files', root); if (!el) return;
  const locked = !!(S.extract && S.extract.running) || !!(S.apply && S.apply.running);
  if (!S.files.length) { el.innerHTML = '<div class="dc-files-empty">まだファイルがありません。左の GCS パスから一覧を取得するか、右にファイルをドロップしてください。</div>'; return; }
  const ready = S.files.filter((f) => f.status === 'ready').length;
  el.innerHTML = `<div class="dc-files">${S.files.map((f) => {
    const k = fileKind(f.name, f.mime);
    const st = f.status === 'uploading' ? `<div class="up-bar sm"><div class="up-fill" style="width:${Math.round((f.pct || 0) * 100)}%"></div></div><span class="small muted">${Math.round((f.pct || 0) * 100)}%</span>`
      : f.status === 'queued' ? '<span class="chip chip-mute">待機中</span>'
        : f.status === 'error' ? `<span class="chip chip-bad" title="${esc(f.message || '')}">エラー</span><span class="small dc-err">${esc(f.message || '')}</span>`
          : '<span class="chip chip-ok">✓ 準備OK</span>';
    return `<div class="dc-file st-${f.status}">
      <span class="ft ft-${k.k}">${k.ic} ${k.lab}</span>
      <div class="dcf-name"><div class="dcf-n" title="${esc(f.name)}">${esc(f.name)}</div><div class="dcf-u mono" title="${esc(f.uri || '')}">${esc(f.uri || (f.src === 'upload' ? 'アップロード待ち' : ''))}</div></div>
      <span class="dcf-src">${f.src === 'gcs' ? '☁️ GCS' : '⬆️ アップロード'}</span>
      <span class="dcf-size mono">${fmtSize(f.size)}</span>
      <div class="dcf-st">${st}</div>
      <button class="icon-btn del" data-act="rm-file" data-id="${f.id}" title="一覧から外す" aria-label="削除" ${locked || f.status === 'uploading' ? 'disabled' : ''}>✕</button>
    </div>`;
  }).join('')}</div>
  <div class="dc-files-foot"><span><b>${ready}</b> / ${S.files.length} ファイル準備OK${S.uploading ? ' ・ <span class="live-dot"></span> アップロード中…' : ''}</span><span class="spacer"></span>
    <button class="btn btn-primary btn-live" data-act="extract" ${!ready || S.uploading || locked ? 'disabled' : ''}><span class="live-ic">🔎</span><span class="live-txt">${S.extract && S.extract.complete ? 'もう一度抽出する' : `抽出開始（${ready} ファイル）`}</span></button></div>`;
}

function paintS2(root) {
  const el = $('#dc-s2', root); if (!el) return;
  const x = S.extract;
  if (!x) { el.innerHTML = ''; return; }
  const total = x.files.length || 1;
  const done = x.files.filter((f) => ['done', 'error'].includes(x.per[f.idx].status)).length;
  const pct = x.complete ? 100 : Math.round(done / total * 100);
  const tin = Object.values(x.per).reduce((a, r) => a + (r.input_tokens || 0), 0);
  const tout = Object.values(x.per).reduce((a, r) => a + (r.output_tokens || 0), 0);
  const nprod = Object.values(x.per).reduce((a, r) => a + (r.nprod || 0), 0);
  el.innerHTML = `<div class="panel dc-sec csv-prog ${x.complete ? 'done' : ''}">
    <div class="im-sec-h"><span class="im-step">2</span><h2>抽出</h2>
      <span class="im-res-st">${x.running ? '<span class="live-dot"></span> Gemini が資料を読み取っています…' : x.error ? `<span class="chip chip-bad">エラー</span> ${esc(x.error)}` : `✅ 完了 — <b>${nprod}</b> 商品を抽出しました`}</span>
      <span class="spacer"></span><span class="cp-pct">${pct}%</span></div>
    <div class="cp-bar"><div class="cp-fill" style="width:${pct}%"></div></div>
    <div class="dc-ex-table">
      <div class="dcx-h"><span>種類</span><span>ファイル</span><span>状態</span><span>資料の種類</span><span class="r">抽出商品</span><span class="r">処理時間</span><span class="r">トークン(入/出)</span></div>
      ${x.files.map((f) => {
        const r = x.per[f.idx]; const k = fileKind(f.name, f.mime);
        const st = { wait: '<span class="chip chip-mute">待機</span>', run: '<span class="chip chip-info pulse">抽出中…</span>', done: '<span class="chip chip-ok">完了</span>', error: `<span class="chip chip-bad" title="${esc(r.message || '')}">エラー</span>` }[r.status];
        return `<div class="dcx-r st-${r.status}"><span class="ft ft-${k.k}">${k.ic} ${k.lab}</span><span class="dcx-n" title="${esc(f.name)}">${esc(f.name)}${r.status === 'error' ? `<div class="small dc-err">${esc(r.message || '')}</div>` : ''}</span><span>${st}</span>
          <span>${r.document_type ? `<span class="doc-badge">${esc(DOC_TYPES[r.document_type] || r.document_type)}</span>` : '<span class="muted">—</span>'}</span>
          <span class="r">${r.status === 'done' ? `<b>${fmtInt(r.nprod)}</b> 件` : '—'}</span>
          <span class="r mono">${r.latency_ms ? (r.latency_ms / 1000).toFixed(1) + ' 秒' : '—'}</span>
          <span class="r mono">${r.input_tokens ? `${fmtInt(r.input_tokens)} / ${fmtInt(r.output_tokens)}` : '—'}</span></div>`;
      }).join('')}
    </div>
    <div class="cp-stats"><div><span class="k">モデル</span><b class="mono">${esc(x.model || (state.config && state.config.model) || '')}</b></div>
      <div><span class="k">処理済み</span><b>${done}</b> / ${x.files.length} ファイル</div><div><span class="k">抽出商品</span><b>${nprod}</b> 件</div>
      <div><span class="k">トークン(入/出)</span><b>${fmtInt(tin)}</b> / <b>${fmtInt(tout)}</b></div></div>
  </div>`;
}

function paintS3(root) {
  const el = $('#dc-s3', root); if (!el) return;
  if (!S.products.length) {
    el.innerHTML = S.extract && S.extract.complete ? '<div class="panel dc-sec"><div class="empty"><div class="empty-icon">🔍</div><div class="empty-title">商品情報が見つかりませんでした</div><div class="empty-sub">別の資料でお試しください</div></div></div>' : '';
    return;
  }
  el.innerHTML = `<div class="panel dc-sec">
    <div class="im-sec-h"><span class="im-step">3</span><h2>確認・商品IDの指定</h2><span class="muted small">抽出結果を確認し、どの商品に反映するかを選んでください（型番が一致する商品を自動で提案します）</span></div>
    <div class="dc-cards">${S.products.map((it) => `<div class="dc-card" id="dc-card-${it.key}">${cardHtml(it)}</div>`).join('')}</div>
  </div>`;
}
function paintCard(root, it) {
  const el = $(`#dc-card-${it.key}`, root);
  if (el) el.innerHTML = cardHtml(it);
}
function cardHtml(it) {
  const p = it.p;
  const locked = !!(S.apply && S.apply.running);
  const conf = p.confidence;
  const confCls = conf >= 0.9 ? 'ok' : conf >= 0.7 ? 'warn' : 'bad';
  const attrs = p.attributes || [];
  const radio = (val, inner, extra = '') => `<label class="tg-opt ${it.target === val ? 'on' : ''} ${extra}"><input type="radio" name="tg-${it.key}" data-tg="${it.key}" value="${esc(val)}" ${it.target === val ? 'checked' : ''} ${locked ? 'disabled' : ''}>${inner}</label>`;
  const matches = (p.matches || []).map((m) => radio('match:' + m.sku, `<img src="${esc(m.image_url || '')}" alt="" onerror="this.style.visibility='hidden'"><div class="tg-txt"><div class="tg-t" title="${esc(m.title)}">${esc(m.title)}</div>
      <div class="tg-m"><span class="mono">${esc(m.sku)}</span><span class="score s-${m.score >= 0.9 ? 'ok' : m.score >= 0.6 ? 'warn' : 'bad'}">一致度 ${Math.round((m.score || 0) * 100)}%</span><span class="muted">${esc(m.why || '')}</span>${p.suggested_sku === m.sku ? '<span class="chip chip-info">おすすめ</span>' : ''}</div></div>`)).join('');
  return `
    <div class="dcc-head">
      <div class="dcc-title-wrap"><div class="dcc-title">${esc(p.title || p.model_number || '（名称不明）')}</div>
        <div class="dcc-meta">${p.brand ? `<span>${esc(p.brand)}</span>` : ''}${p.model_number ? `<span class="kvp">型番 <b class="mono">${esc(p.model_number)}</b></span>` : ''}${p.jan ? `<span class="kvp">JAN <b class="mono">${esc(p.jan)}</b></span>` : ''}${p.category ? `<span class="cat-pill">${esc(p.category)}</span>` : ''}${p.price ? `<span class="kvp">価格 <b>¥${fmtInt(p.price)}</b></span>` : ''}</div></div>
      <div class="dcc-badges">${it.document_type ? `<span class="doc-badge">${esc(DOC_TYPES[it.document_type] || it.document_type)}</span>` : ''}
        ${conf != null ? `<span class="chip chip-${confCls}" title="抽出の確信度">確信度 ${Math.round(conf * 100)}%</span>` : ''}
        <span class="dcc-src" title="${esc(it.file_uri || '')}">📎 ${esc(it.file_name || '')}</span></div>
    </div>
    <div class="dcc-body">
      <div class="dcc-left">
        <div class="sec-lab">抽出した項目 <span class="muted small">${attrs.length} 件 ・ 根拠は資料の原文です</span></div>
        <div class="dcc-tbl-wrap"><table class="table dcc-tbl"><thead><tr><th>項目</th><th>値</th><th>根拠（原文）</th><th class="r">ページ</th></tr></thead><tbody>
          ${attrs.map((a) => `<tr><td><div class="dca-l">${esc(a.label || a.key)}</div>${a.label && a.key ? `<div class="dca-k mono">${esc(a.key)}</div>` : ''}</td><td class="dca-v">${esc(a.value)}</td><td class="dca-e">${a.evidence ? `<mark class="ev-mark weak">${esc(a.evidence)}</mark>` : '<span class="muted">—</span>'}</td><td class="r mono">${a.page != null && a.page !== '' ? 'p.' + esc(a.page) : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">項目なし</td></tr>'}
        </tbody></table></div>
        ${p.description ? `<div class="sec-lab" style="margin-top:12px">説明文（抜粋）</div><div class="dcc-desc">${esc(p.description.length > 220 ? p.description.slice(0, 220) + '…' : p.description)}</div>` : ''}
      </div>
      <div class="dcc-right">
        <div class="sec-lab">反映先の商品</div>
        <div class="tg-list">
          ${matches}
          ${radio('other', `<div class="tg-txt"><div class="tg-t">別の SKU を指定</div><input class="input mono tg-in" list="dc-plist" data-other="${it.key}" placeholder="SKU を入力（例: 00049890716）" value="${esc(it.other)}" ${locked ? 'disabled' : ''}></div>`)}
          ${radio('new', `<div class="tg-txt"><div class="tg-t">新規 SKU として登録</div><input class="input mono tg-in" data-new="${it.key}" value="${esc(it.newSku)}" ${locked ? 'disabled' : ''}></div>`)}
          ${radio('skip', '<div class="tg-txt"><div class="tg-t">スキップ <span class="muted small">（反映しない）</span></div></div>', 'skip')}
        </div>
        ${it.target !== 'skip' ? `
        <div class="dcc-mode"><span class="sec-lab" style="margin:0">反映方法</span>
          <div class="seg">${[['fill', '追加のみ（空欄を埋める）'], ['overwrite', '上書き']].map(([v, l]) => `<button class="seg-btn sm ${it.mode === v ? 'on' : ''}" data-act="mode" data-key="${it.key}" data-v="${v}" ${locked ? 'disabled' : ''}>${l}</button>`).join('')}</div>
          <span class="spacer"></span>
          <button class="btn btn-outline btn-sm ${it.previewLoading ? 'loading' : ''}" data-act="preview" data-key="${it.key}" ${it.previewLoading || locked ? 'disabled' : ''}>🔍 差分を確認</button></div>
        <div class="dcc-diff">${diffHtml(it)}</div>` : '<div class="dcc-skip">この商品は反映しません</div>'}
      </div>
    </div>`;
}
function diffHtml(it) {
  if (it.previewErr) return `<div class="im-note warn">差分を取得できませんでした: ${esc(it.previewErr)}</div>`;
  const pv = it.preview;
  if (!pv) return '<div class="dcc-diff-ph">「差分を確認」を押すと、反映前後（Before / After）を表示します</div>';
  const cnt = { add: 0, overwrite: 0, keep: 0, new: 0 };
  (pv.diff || []).forEach((d) => { cnt[d.action] = (cnt[d.action] || 0) + 1; });
  return `<div class="dd-sum"><b>${esc(pv.sku)}</b>${pv.is_new ? '<span class="act act-new">新規作成</span>' : ''} ・ 変更 <b>${fmtInt(pv.changes)}</b> 件
      ${Object.entries(cnt).filter(([, v]) => v).map(([k, v]) => `<span class="act act-${ACTIONS[k] ? ACTIONS[k][1] : 'keep'}">${esc(ACTIONS[k] ? ACTIONS[k][0] : k)} ${v}</span>`).join('')}</div>
    <div class="dcc-tbl-wrap"><table class="table dd-tbl"><thead><tr><th>項目</th><th>Before（現在）</th><th>After（反映後）</th><th>操作</th></tr></thead><tbody>
      ${(pv.diff || []).map((d) => {
        const a = ACTIONS[d.action] || [d.action, 'keep'];
        const ignored = d.action === 'keep' && d.before && d.after && d.before !== d.after;
        const afterCell = ignored ? `${esc(trunc(d.before))}<div class="dd-ign">資料の値「${esc(trunc(d.after, 60))}」は反映しません</div>` : d.after ? esc(trunc(d.after)) : '<span class="muted">—</span>';
        return `<tr class="dd-${a[1]}"><td class="dd-l">${esc(d.label || d.field)}</td><td class="dd-b">${d.before ? esc(trunc(d.before)) : '<span class="muted">（空欄）</span>'}</td><td class="dd-a">${afterCell}</td><td><span class="act act-${a[1]}">${esc(a[0])}</span></td></tr>`;
      }).join('') || '<tr><td colspan="4" class="muted">変更はありません</td></tr>'}
    </tbody></table></div>`;
}
const trunc = (s, n = 120) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

function targetOf(it) {
  if (it.target === 'skip') return null;
  if (it.target === 'other') return { sku: it.other.trim() || null, new_sku: null };
  if (it.target === 'new') return { sku: null, new_sku: it.newSku.trim() || null };
  return { sku: it.target.slice(6), new_sku: null };
}

function paintS4(root) {
  const el = $('#dc-s4', root); if (!el) return;
  if (!S.products.length) { el.innerHTML = ''; return; }
  const a = S.apply;
  const targets = S.products.map((it) => ({ it, t: targetOf(it) }));
  const nUpd = targets.filter((x) => x.t && x.t.sku).length;
  const nNew = targets.filter((x) => x.t && x.t.new_sku).length;
  const nSkip = targets.filter((x) => !x.t).length;
  const running = a && a.running;
  el.innerHTML = `<div class="panel dc-sec dc-apply">
    <div class="im-sec-h"><span class="im-step">4</span><h2>BigQuery に反映</h2><span class="muted small">資料の内容を商品データにマージし、Gemini で再エンリッチして保存します</span></div>
    <div class="dca-bar">
      <div class="dca-counts"><div><b>${nUpd}</b><span>既存商品を更新</span></div><div><b>${nNew}</b><span>新規登録</span></div><div class="mute"><b>${nSkip}</b><span>スキップ</span></div></div>
      <label class="chk dca-chk"><input type="checkbox" id="dc-aics" ${S.updateAics ? 'checked' : ''} ${running ? 'disabled' : ''}><span><b>AICS カタログ（<span class="mono">${esc(((state.config && state.config.source_table) || 'products_aics').split('.').pop())}</span>）も更新</b><br><span class="muted small">更新前にバックアップを自動作成します</span></span></label>
      <button class="btn btn-primary btn-live btn-lg ${running ? 'running' : ''}" data-act="apply" ${running || !(nUpd + nNew) ? 'disabled' : ''}><span class="live-ic">☁️</span><span class="live-txt">${running ? '反映中…' : `BigQueryに反映（再エンリッチ）${nUpd + nNew} 件`}</span></button>
    </div>
    ${a ? applyHtml(a) : ''}
  </div>`;
}
function applyHtml(a) {
  const rows = a.items.map((r) => {
    const s1 = r.merged ? `<span class="stg done">✓ マージ <b>${fmtInt(r.changes)}</b> 件</span>` : r.state === 'run' ? '<span class="stg run">マージ中…</span>' : '<span class="stg">マージ</span>';
    const s2 = r.enriched ? `<span class="stg done">✓ 再エンリッチ</span><div class="dap-fill"><span class="b">${fmtPct(r.enriched.fill_before)}</span><div class="fb-track"><div class="fb-fill fb-before" style="width:${(r.enriched.fill_before || 0) * 100}%"></div></div><span class="arr">➜</span><div class="fb-track"><div class="fb-fill fb-after" style="width:${(r.enriched.fill_after || 0) * 100}%"></div></div><span class="a">${fmtPct(r.enriched.fill_after)}</span></div>`
      : r.merged && !r.error ? '<span class="stg run">再エンリッチ中…</span>' : '<span class="stg">再エンリッチ</span>';
    const s3 = a.saved && !r.error ? '<span class="stg done">✓ 保存</span>' : '<span class="stg">保存</span>';
    return `<div class="dap-row ${r.error ? 'err' : r.merged ? 'on' : ''}">
      <div class="dap-sku"><div class="mono"><b>${esc(r.sku || '—')}</b>${r.isNew ? ' <span class="act act-new">新規</span>' : ''}</div><div class="small muted dap-t" title="${esc(r.title)}">${esc(r.title)}</div></div>
      <div class="dap-stages">${s1}<i>›</i><div class="dap-s2">${s2}</div><i>›</i>${s3}</div>
      <div class="dap-end">${r.error ? `<span class="chip chip-bad" title="${esc(r.error)}">エラー</span><div class="small dc-err">${esc(r.error)}</div>` : a.complete ? `<a class="btn btn-ghost btn-sm" href="#/studio/${encodeURIComponent(r.sku)}">✨ スタジオで根拠を見る</a>` : ''}</div>
    </div>`;
  }).join('');
  let done = '';
  if (a.complete || a.saved) {
    const t = {}; Object.entries((a.saved && a.saved.tables) || {}).forEach(([k, v]) => { t[String(k).split('.').pop()] = v; });
    const x = a.aics;
    done = `<div class="bq-card dc-done">
      <div class="bq-head"><span class="bq-ic">☁️</span><div><div class="bq-title">${a.complete ? 'BigQuery への反映が完了しました' : 'BigQuery に保存しました'}</div>
        <div class="bq-sub">データセット <span class="mono">${esc((a.saved && a.saved.dataset) || '')}</span>${a.complete ? ` ・ ${(a.complete.elapsed_ms / 1000).toFixed(1)} 秒` : ''}</div></div></div>
      <div class="bq-tables" style="grid-template-columns:repeat(${Math.max(1, Math.min(6, Object.keys(t).length))}, minmax(0,1fr))">${Object.entries(t).map(([k, v]) => `<div class="bq-t"><div class="bq-n">${fmtInt(v)}<span>行</span></div><div class="bq-k mono">${esc(k)}</div><div class="bq-l">${esc(BQ_LABELS[k] || '')}</div></div>`).join('')}</div>
      ${x ? `<div class="dc-aics"><span class="dc-aics-ic">🛍</span><div><b>AICS カタログ</b> <span class="mono small">${esc(x.table || '')}</span><div class="small">更新 <b>${fmtInt(x.updated)}</b> 件 ・ 新規 <b>${fmtInt(x.inserted)}</b> 件${x.backup ? ` ・ バックアップ <span class="mono">${esc(x.backup)}</span>` : ''}${x.message ? ` ・ ${esc(x.message)}` : ''}</div></div></div>` : ''}
      ${a.complete ? `<div class="dc-links">${[...new Map(a.items.filter((r) => !r.error && r.sku).map((r) => [r.sku, r])).values()].map((r) => `<a class="btn btn-outline btn-sm" href="#/studio/${encodeURIComponent(r.sku)}">✨ ${esc(r.sku)} をスタジオで確認</a>`).join('')}</div>` : ''}
    </div>`;
  }
  return `<div class="dap-list">${rows}</div>${done}`;
}

function paintAll(root) { if (!alive(root)) return; paintSteps(root); paintS1(root); paintS2(root); paintS3(root); paintS4(root); }

// ── Events ────────────────────────────────────────────────────────────────
function findItem(key) { return S.products.find((x) => String(x.key) === String(key)); }
function onClick(root, e) {
  const t = e.target.closest('[data-act]');
  if (!t || !root.contains(t) || t.disabled) return;
  switch (t.dataset.act) {
    case 'list': listGcs(root); break;
    case 'rm-file': S.files = S.files.filter((f) => String(f.id) !== t.dataset.id); paintFiles(root); break;
    case 'reset':
      Object.assign(S, { files: [], gcs: '', extract: null, products: [], apply: null });
      paintAll(root); break;
    case 'extract': extract(root); break;
    case 'mode': { const it = findItem(t.dataset.key); if (it && it.mode !== t.dataset.v) { it.mode = t.dataset.v; it.preview = null; it.previewErr = ''; paintCard(root, it); } break; }
    case 'preview': preview(root, findItem(t.dataset.key)); break;
    case 'apply': apply(root); break;
    default: break;
  }
}
function onChange(root, e) {
  const t = e.target;
  if (t.id === 'dc-file') { addFiles(root, t.files); t.value = ''; }
  else if (t.id === 'dc-aics') S.updateAics = t.checked;
  else if (t.dataset.tg) {
    const it = findItem(t.dataset.tg); if (!it) return;
    it.target = t.value; it.preview = null; it.previewErr = '';
    paintCard(root, it); paintS4(root);
    if (it.target === 'other') { const inp = $(`[data-other="${it.key}"]`, root); if (inp) inp.focus(); }
  }
}
function onInput(root, e) {
  const t = e.target;
  if (t.id === 'dc-gcs') S.gcs = t.value.trim();
  else if (t.dataset.other || t.dataset.new) {
    const it = findItem(t.dataset.other || t.dataset.new); if (!it) return;
    if (t.dataset.other) it.other = t.value; else it.newSku = t.value;
    const want = t.dataset.other ? 'other' : 'new';
    if (it.target !== want) {
      it.target = want;
      $$(`[data-tg="${it.key}"]`, root).forEach((r) => { r.checked = r.value === want; r.closest('.tg-opt').classList.toggle('on', r.value === want); });
    }
    if (it.preview) { it.preview = null; const d = $(`#dc-card-${it.key} .dcc-diff`, root); if (d) d.innerHTML = diffHtml(it); }
    paintS4(root);
  }
}

// ── Actions ───────────────────────────────────────────────────────────────
function addFiles(root, fileList) {
  const arr = Array.from(fileList || []);
  if (!arr.length) return;
  let added = 0;
  for (const f of arr) {
    const ext = '.' + (f.name.split('.').pop() || '').toLowerCase();
    if (!ACCEPT.includes(ext)) { toast(`${f.name}: 対応していない形式です`, 'warn', 4500); continue; }
    if (f.size > MAX_SIZE) { toast(`${f.name}: 30MB を超えています`, 'warn', 4500); continue; }
    if (S.files.length >= MAX_FILES) { toast(`ファイルは最大 ${MAX_FILES} 件までです`, 'warn'); break; }
    S.files.push({ id: ++S.seq, name: f.name, size: f.size, mime: f.type, src: 'upload', status: 'queued', pct: 0, file: f });
    added++;
  }
  if (added) { paintFiles(root); runUploads(root); }
}
async function runUploads(root) {
  if (S.uploading) return;
  S.uploading = true;
  S.upCtrl = new AbortController();
  try {
    for (;;) {
      const f = S.files.find((x) => x.status === 'queued');
      if (!f) break;
      f.status = 'uploading'; f.pct = 0;
      if (alive(root)) paintFiles(root);
      let last = 0;
      try {
        const d = await api.docsUpload(f.file, (p) => {
          f.pct = p;
          if (Date.now() - last > 120 && alive(root)) { last = Date.now(); paintFiles(root); }
        }, S.upCtrl.signal);
        Object.assign(f, d.file || {}, { status: 'ready', file: null, src: 'upload' });
      } catch (e) {
        if (e.name === 'AbortError') { f.status = 'queued'; break; }
        f.status = 'error'; f.message = e.message;
        toast(`${f.name}: アップロードに失敗しました（${e.message}）`, 'err', 6000);
      }
    }
  } finally {
    S.uploading = false;
    if (alive(root)) paintFiles(root);
  }
}
async function listGcs(root) {
  const inp = $('#dc-gcs', root);
  const uri = (inp ? inp.value : S.gcs).trim();
  S.gcs = uri;
  if (!/^gs:\/\/[^/]+/.test(uri)) { toast('gs:// で始まるパスを入力してください', 'warn'); return; }
  S.listing = true; paintS1(root);
  try {
    const d = await api.docsList(uri);
    const files = d.files || [];
    let added = 0;
    files.forEach((f) => {
      if (S.files.some((x) => x.uri === f.uri)) return;
      if (S.files.length >= MAX_FILES) return;
      S.files.push({ id: ++S.seq, ...f, src: 'gcs', status: 'ready' });
      added++;
    });
    toast(`${added} ファイルを追加しました${d.skipped ? `（対応外 ${d.skipped} 件はスキップ）` : ''}`, added ? 'ok' : 'warn');
  } catch (e) {
    toast('一覧を取得できませんでした: ' + e.message, 'err', 6000);
  } finally {
    S.listing = false;
    if (alive(root)) paintS1(root);
  }
}

async function extract(root) {
  const files = S.files.filter((f) => f.status === 'ready');
  if (!files.length || (S.extract && S.extract.running)) return;
  const list = files.map((f, i) => ({ idx: i, uri: f.uri, name: f.name, mime: f.mime }));
  S.extract = { running: true, files: list, per: Object.fromEntries(list.map((f) => [f.idx, { status: 'wait' }])), complete: null, model: '', error: '' };
  S.products = []; S.apply = null;
  S.ctrl = new AbortController();
  paintAll(root);
  const sec = $('#dc-s2', root); if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  let key = 0;
  const onEvent = (ev) => {
    const x = S.extract;
    switch (ev.event) {
      case 'start': x.model = ev.model || ''; break;
      case 'file_start': if (x.per[ev.index]) x.per[ev.index].status = 'run'; break;
      case 'file_done': {
        const prods = ev.products || [];
        x.per[ev.index] = { status: 'done', document_type: ev.document_type, latency_ms: ev.latency_ms, input_tokens: ev.input_tokens, output_tokens: ev.output_tokens, nprod: prods.length };
        const f = x.files[ev.index] || {};
        prods.forEach((p) => {
          const top = (p.matches || [])[0];
          const target = p.suggested_sku ? 'match:' + p.suggested_sku : top && top.score >= 0.9 ? 'match:' + top.sku : 'new';
          S.products.push({ key: ++key, p, file_uri: ev.uri || f.uri, file_name: ev.name || f.name, document_type: ev.document_type, target, other: '',
            newSku: 'DOC-' + String(p.model_number || p.jan || ('ITEM' + key)).replace(/[^A-Za-z0-9_-]/g, ''), mode: 'fill', preview: null, previewLoading: false, previewErr: '' });
        });
        break;
      }
      case 'file_error': x.per[ev.index] = { status: 'error', message: ev.message }; toast(`${ev.name}: ${ev.message}`, 'err', 6000); break;
      case 'complete': x.complete = ev; break;
      case 'error': x.error = ev.message || 'エラーが発生しました'; toast(x.error, 'err', 7000); break;
      default: break;
    }
    if (alive(root)) { paintSteps(root); paintS2(root); }
  };
  try {
    await api.docsExtract({ files: list.map(({ uri, name, mime }) => ({ uri, name, mime })) }, onEvent, S.ctrl.signal);
    if (S.extract.complete) toast(`${S.products.length} 商品の情報を抽出しました。反映先を確認してください`, S.products.length ? 'ok' : 'warn', 5000);
  } catch (e) {
    if (e.name !== 'AbortError') { S.extract.error = e.message; toast('抽出に失敗しました: ' + e.message, 'err', 7000); }
    else S.extract.error = '中断しました';
  } finally {
    S.extract.running = false;
    Object.values(S.extract.per).forEach((r) => { if (r.status === 'run' || r.status === 'wait') { r.status = 'error'; r.message = r.message || '処理されませんでした'; } });
    if (!S.extract.complete) S.extract.complete = { files: list.length, products: S.products.length };
    if (alive(root)) {
      paintAll(root);
      const s3 = $('#dc-s3', root); if (s3 && S.products.length) s3.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }
}

async function preview(root, it) {
  if (!it || it.previewLoading) return;
  const t = targetOf(it);
  if (!t) return;
  if (!t.sku && !t.new_sku) { toast(it.target === 'other' ? 'SKU を入力してください' : '新規 SKU を入力してください', 'warn'); return; }
  it.previewLoading = true; it.previewErr = ''; paintCard(root, it);
  try {
    it.preview = await api.docsPreview({ sku: t.sku, new_sku: t.new_sku, product: it.p, mode: it.mode });
  } catch (e) {
    it.previewErr = e.message;
  } finally {
    it.previewLoading = false;
    if (alive(root)) paintCard(root, it);
  }
}

async function apply(root) {
  if (S.apply && S.apply.running) return;
  const picked = S.products.map((it) => ({ it, t: targetOf(it) })).filter((x) => x.t);
  const bad = picked.find((x) => !x.t.sku && !x.t.new_sku);
  if (bad) { toast(`「${bad.it.p.title || bad.it.p.model_number}」の SKU を入力してください`, 'warn', 5000); return; }
  if (!picked.length) { toast('反映する商品がありません（すべてスキップ）', 'warn'); return; }
  const items = picked.map(({ it, t }) => ({ sku: t.sku, new_sku: t.new_sku, product: it.p, mode: it.mode, file_uri: it.file_uri, file_name: it.file_name, document_type: it.document_type || null }));
  S.apply = { running: true, items: picked.map(({ it, t }) => ({ sku: t.sku || t.new_sku, isNew: !!t.new_sku, title: it.p.title || it.p.model_number || '', state: 'wait', merged: false, changes: 0, enriched: null, error: '' })), saved: null, aics: null, complete: null };
  S.ctrl = new AbortController();
  paintAll(root);
  const sec = $('#dc-s4', root); if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const onEvent = (ev) => {
    const a = S.apply; const r = a.items[ev.index];
    switch (ev.event) {
      case 'item_start': if (r) { r.state = 'run'; if (ev.sku) r.sku = ev.sku; } break;
      case 'merged': if (r) { r.merged = true; r.changes = ev.changes; } break;
      case 'enriched': if (r) r.enriched = ev; break;
      case 'item_error': if (r) { r.error = ev.message || 'エラー'; r.state = 'error'; } toast(`${ev.sku}: ${ev.message}`, 'err', 6000); break;
      case 'saved': a.saved = ev.bq || {}; break;
      case 'aics': a.aics = ev.result || null; break;
      case 'complete': a.complete = ev; break;
      case 'error': toast(ev.message || 'エラーが発生しました', 'err', 7000); break;
      default: break;
    }
    if (alive(root)) { paintSteps(root); paintS4(root); }
  };
  try {
    await api.docsApply({ items, enrich: true, update_aics: S.updateAics }, onEvent, S.ctrl.signal);
    if (S.apply.complete) {
      const ok = S.apply.items.filter((x) => !x.error).length;
      toast(`${ok} 件を BigQuery に反映しました${S.apply.aics ? '（AICS カタログも更新）' : ''}`, 'ok', 6000);
    } else toast('完了通知を受信できませんでした', 'warn');
  } catch (e) {
    if (e.name !== 'AbortError') toast('反映に失敗しました: ' + e.message, 'err', 7000);
  } finally {
    S.apply.running = false;
    state.products = null; // product list may have new SKUs / updated fill
    refreshShell();
    if (alive(root)) paintAll(root);
  }
}
