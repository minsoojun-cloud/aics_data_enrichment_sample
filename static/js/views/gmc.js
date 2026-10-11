// ⑦ GMC 会話属性 (Google Merchant Center Conversational Attributes)
import { api, gmcTsvUrl, gmcCsvUrl, GMC_SPEC_URL, GMC_SPEC_URL_JA } from '../api.js?v=3';
import {
  esc, $, $$, fmtInt, fmtScore, fmtDate, confBar, tip, skeleton, emptyState, errorState, toast, state, findEvidence,
} from '../ui.js?v=3';
import { modelPretty } from './csv.js?v=3';

const GROUP_SHORT = { fridge: '冷蔵庫', aircon: 'エアコン', fan: '扇風機', handy: 'ハンディファン' };
const REL_TYPES = ['similar_to', 'often_bought_with', 'accessory', 'substitute'];
const REL_LABEL = { similar_to: '類似商品', often_bought_with: 'よく一緒に購入', accessory: 'アクセサリー', substitute: '代替品' };
const filt = { group: '', q: '' };

// Mirror of backend rebuild_gmc_strings (for live preview while editing)
function feedStrings(g) {
  const clean = (s) => String(s ?? '').replace(/"/g, "'");
  return {
    variant_option: (g.variant_options || []).filter((v) => v.name && v.value).map((v) => `${String(v.name).replace(/,/g, '・').replace(/:/g, '：')}:${String(v.value).replace(/,/g, '・').replace(/:/g, '：')}`).join(','),
    question_and_answer: (g.questions_and_answers || []).filter((q) => q.question && q.answer).map((q) => `"${clean(q.question)}":"${clean(q.answer)}"`).join(', '),
    product_highlight: (g.product_highlights || []).filter((h) => String(h).trim()).map((h) => `"${clean(h)}"`).join(', '),
    product_detail: (g.product_details || []).filter((d) => d.attribute && d.value).map((d) => `${d.section || '仕様'}:${d.attribute}:"${clean(d.value)}"`).join(', '),
    related_product: (g.related_products || []).filter((r) => r.identifier).map((r) => `${r.relationship_type || 'similar_to'}:${r.identifier_type || 'id'}:${r.identifier}`).join(','),
  };
}

function markMany(text, evs) {
  const ranges = [];
  evs.forEach((ev, i) => { const r = findEvidence(text, ev); if (r) ranges.push({ ...r, i }); });
  ranges.sort((a, b) => a.start - b.start);
  let out = ''; let pos = 0;
  ranges.forEach((r) => {
    if (r.start < pos) return;
    out += esc(text.slice(pos, r.start)) + `<mark class="ev-mark" data-ev="${r.i}">` + esc(text.slice(r.start, r.end)) + '</mark>';
    pos = r.end;
  });
  return out + esc(text.slice(pos));
}

const evBadge = (em) => (em >= 0.8 ? `<span class="chip chip-ok">根拠一致: ${fmtScore(em)} 🟢</span>` : em > 0 ? `<span class="chip chip-warn">部分一致: ${fmtScore(em)} 🟡</span>` : '<span class="chip chip-warn">要確認 🟡</span>');

export async function render(root, params, stale) {
  const groups = (state.config && state.config.groups) || GROUP_SHORT;
  root.innerHTML = `
    <div class="page-head gmc-head">
      <div><h1>Google Merchant Center 会話属性 <span class="h1-sub">(Conversational Attributes)</span></h1>
        <div class="spec-links">
          <a class="spec-badge" href="${GMC_SPEC_URL}" target="_blank" rel="noopener">📘 Google Merchant Center 公式仕様 (Answer #17085370) ↗</a>
          <a class="spec-badge ja" href="${GMC_SPEC_URL_JA}" target="_blank" rel="noopener">日本語ヘルプ ↗</a>
          <span class="muted small">AI モード / 会話型ショッピングで商品が正しく回答されるための補助フィード属性</span>
        </div></div>
      <div class="head-actions"><a class="btn btn-outline" href="${gmcTsvUrl}" download>⬇ GMC 補助フィード出力 (TSV)</a><a class="btn btn-primary" href="${gmcCsvUrl}" download>⬇ GMC フィード出力 (CSV)</a></div>
    </div>
    <div class="kpis gmc-kpis" id="gmc-kpis">${skeleton(4, 'skel-kpi')}</div>
    <div class="gmc-layout">
      <aside class="panel gmc-list">
        <div class="gl-filters">
          <div class="chip-group">${[['', 'すべて'], ...Object.keys(groups).map((k) => [k, GROUP_SHORT[k] || groups[k]])].map(([k, v]) => `<button class="fchip ${filt.group === k ? 'on' : ''}" data-g="${esc(k)}">${esc(v)}</button>`).join('')}</div>
          <div class="search small"><span class="search-ic">🔍</span><input id="gl-q" type="search" placeholder="SKU / 商品名 / グループタイトル検索" value="${esc(filt.q)}"></div>
        </div>
        <div class="gl-items" id="gl-items">${skeleton(6, 'skel-row')}</div>
      </aside>
      <section class="gmc-main" id="gmc-main">${skeleton(1, 'skel-panel')}</section>
    </div>`;

  const ctx = { items: [], sku: params[0] || null, detail: null, g: null, dirty: false, busy: false };

  const loadList = async (keepSel = true) => {
    let d;
    try { d = await api.gmcList({ group: filt.group, q: filt.q }); } catch (e) {
      if (stale()) return;
      $('#gl-items', root).innerHTML = errorState(e); $('#gmc-kpis', root).innerHTML = ''; return;
    }
    if (stale()) return;
    ctx.items = d.items || [];
    paintKpis(d);
    paintList();
    if (!keepSel || !ctx.sku) {
      const first = ctx.items.find((i) => i.qa_count > 0) || ctx.items[0];
      if (first && !ctx.sku) select(first.sku, { replace: true });
    }
  };

  function paintKpis(d) {
    const s = d.stats || {};
    const tot = s.total_skus || 0;
    $('#gmc-kpis', root).innerHTML = `
      <div class="kpi"><div class="kpi-label">対象 SKU 数</div><div class="kpi-big">${fmtInt(tot)}<span class="kpi-unit">件</span></div><div class="kpi-foot"><span class="muted">モデル <span class="mono">${esc(d.model || '')}</span></span></div></div>
      <div class="kpi"><div class="kpi-label">${tip('生成 Q&A 総数', 'question_and_answer: 買い物客の質問と、原本に根拠のある回答のペア')} <span class="mono muted small">question_and_answer</span></div><div class="kpi-big">${fmtInt(s.total_qas)}<span class="kpi-unit">問</span></div>
        <div class="kpi-foot col"><span>平均 <b>${s.avg_qas_per_sku ?? '—'}</b> 問/SKU ・ 自動承認 <b class="ok-text">${fmtInt(s.auto_approved_qas)}</b> 件</span><span class="muted">要確認 ${fmtInt(s.needs_review_qas)} 件</span></div></div>
      <div class="kpi"><div class="kpi-label">${tip('バリエーション構造化', 'variant_option: カラーや容量などバリエーションの軸を name:value で構造化')} <span class="mono muted small">variant_option</span></div><div class="kpi-big">${fmtInt(s.variant_option_skus)}<span class="kpi-unit">/ ${fmtInt(tot)} SKU</span></div>
        <div class="kpi-foot"><div class="mini-track"><div class="mini-fill" style="width:${tot ? (s.variant_option_skus / tot) * 100 : 0}%"></div></div><span class="muted">カバー率 ${tot ? Math.round(s.variant_option_skus / tot * 100) : 0}%</span></div></div>
      <div class="kpi"><div class="kpi-label">${tip('関連商品・ハイライト', 'related_product: 類似品・よく一緒に買われる商品 / product_highlight: 商品の要点')} <span class="mono muted small">related_product / highlight</span></div><div class="kpi-big">${fmtInt(s.related_product_skus)}<span class="kpi-unit">SKU</span></div>
        <div class="kpi-foot col"><span>関連紐付け済 ・ ハイライト <b>${fmtInt(s.highlight_skus)}</b> SKU</span></div></div>`;
  }

  function paintList() {
    const box = $('#gl-items', root);
    if (!ctx.items.length) { box.innerHTML = emptyState('🛍', '該当する SKU がありません', '絞り込み条件を変更してください'); return; }
    box.innerHTML = ctx.items.map((i) => `
      <button class="gl-item ${i.sku === ctx.sku ? 'on' : ''}" data-sku="${esc(i.sku)}">
        <img src="${esc(i.image_url)}" alt="" onerror="this.style.visibility='hidden'">
        <div class="gl-txt"><div class="gl-title" title="${esc(i.title)}">${esc(i.title)}</div>
          <div class="gl-meta"><span class="mono">${esc(i.sku)}</span><span class="cat-pill">${esc(GROUP_SHORT[i.group] || i.group_label)}</span></div>
          <div class="gl-badges"><span class="gb ${i.qa_count ? 'qa' : 'none'}">Q&amp;A ${fmtInt(i.qa_count)}件</span><span class="gb vo">variant ${fmtInt((i.variant_options || []).length)}</span>${i.qa_needs_review ? `<span class="gb warn">要確認 ${i.qa_needs_review}</span>` : ''}</div></div>
      </button>`).join('');
    $$('.gl-item', box).forEach((b) => b.addEventListener('click', () => select(b.dataset.sku)));
    const on = $('.gl-item.on', box); if (on) on.scrollIntoView({ block: 'nearest' });
  }

  async function select(sku, { replace = false } = {}) {
    if (ctx.dirty && sku !== ctx.sku && !window.confirm('保存していない編集内容があります。破棄して移動しますか？')) return;
    ctx.sku = sku; ctx.dirty = false;
    const h = '#/gmc/' + encodeURIComponent(sku);
    if (location.hash !== h) history[replace ? 'replaceState' : 'pushState'](null, '', h);
    $$('.gl-item', root).forEach((b) => b.classList.toggle('on', b.dataset.sku === sku));
    const main = $('#gmc-main', root);
    main.innerHTML = skeleton(1, 'skel-panel');
    try { ctx.detail = await api.gmcDetail(sku); } catch (e) {
      if (!stale() && ctx.sku === sku) main.innerHTML = errorState(e);
      return;
    }
    if (stale() || ctx.sku !== sku) return;
    ctx.g = JSON.parse(JSON.stringify(ctx.detail.gmc || {}));
    paintMain();
  }

  // ── Right pane ─────────────────────────────────────────────────────────
  function paintMain() {
    const { product: p } = ctx.detail;
    const g = ctx.g;
    const fs = feedStrings(g);
    const hasData = (g.questions_and_answers || []).length || (g.variant_options || []).length || (g.product_highlights || []).length;
    const main = $('#gmc-main', root);
    main.innerHTML = `
      <div class="panel gm-bar">
        <img src="${esc(p.image_url)}" alt="" onerror="this.style.visibility='hidden'">
        <div class="gm-bar-txt"><div class="gm-title">${esc(p.title)}</div>
          <div class="muted small"><span class="mono">${esc(p.sku)}</span> ・ ${esc(p.brand || '')} ・ <a href="#/studio/${encodeURIComponent(p.sku)}">✨ エンリッチ・スタジオへ</a>${g.updated_at ? ` ・ 更新 ${fmtDate(g.updated_at)}` : ''}${g.model ? ` ・ <span class="mono">${esc(g.model)}</span>` : ''}</div></div>
        <span class="dirty-pill" id="dirty-pill" ${ctx.dirty ? '' : 'hidden'}>● 未保存の編集</span>
        <button class="btn btn-outline" id="btn-gmc-regen" title="${esc(modelPretty())} で会話属性を再生成"><span class="live-ic">▶</span> ${esc(modelPretty())} で再生成</button>
        <button class="btn btn-primary" id="btn-gmc-save" title="編集内容を BigQuery (gmc_conversational) に保存">💾 BigQuery に保存</button>
      </div>
      ${hasData ? '' : `<div class="banner">🛍 <div><b>この SKU の会話属性はまだ生成されていません。</b> 「再生成」を押すと Gemini が原本から Q&amp;A・バリエーション・ハイライトを生成します。</div></div>`}

      <div class="panel ai-mode">
        <div class="panel-head"><h2>Google 検索 AI モード / 会話型ショッピング プレビュー</h2><span class="muted small">この SKU の会話属性が、AI の回答にどう使われるかのシミュレーション</span></div>
        ${aiPreview(p, g)}
      </div>

      <div class="gspec-grid">
        ${card('question_and_answer', '1', '会話型Q&amp;A・根拠テキスト検証付き', qaCard(g), fs.question_and_answer, 'wide')}
        ${card('item_group_title', '2', 'バリエーション共通親タイトル', `
          <div class="muted small">個別SKU固有のカラー等を除いた親モデル名。バリエーションをまとめて AI が比較・回答するための単位です。</div>
          <label class="field"><span class="mono">item_group_id</span><input class="input" data-f="item_group_id" value="${esc(g.item_group_id || '')}"></label>
          <label class="field"><span class="mono">item_group_title</span><input class="input" data-f="item_group_title" value="${esc(g.item_group_title || '')}"></label>`, null)}
        ${card('variant_option', '3', 'バリエーション軸 name:value', voCard(g), fs.variant_option)}
        ${card('related_product', '4', '関連商品 relationship_type:identifier_type:identifier', rpCard(g), fs.related_product)}
        ${card('product_highlight / product_detail', '5', '商品ハイライト &amp; 構造化スペック section:attribute:"value"', hlCard(g), fs.product_highlight, 'wide', fs.product_detail)}
        ${card('popularity_rank / document_link', '6', '人気度 (0〜100) &amp; 取扱説明書リンク', `
          <label class="field"><span class="mono">popularity_rank</span>
            <div class="rank-row"><input class="input rank-in" type="number" min="0" max="100" step="0.5" data-f="popularity_rank" value="${g.popularity_rank ?? ''}">
            <div class="rank-gauge"><div class="rank-fill" style="width:${Math.max(0, Math.min(100, Number(g.popularity_rank) || 0))}%"></div></div><b class="rank-num">${g.popularity_rank ?? '—'}</b></div></label>
          <label class="field"><span class="mono">document_link</span><input class="input" type="url" data-f="document_link" value="${esc(g.document_link || '')}" placeholder="https://..."></label>
          ${g.document_link ? `<a class="small" href="${esc(g.document_link)}" target="_blank" rel="noopener">リンクを開く ↗</a>` : ''}`, null)}
      </div>

      <div class="panel gm-src">
        <div class="panel-head"><h2>原本テキスト <span class="muted small">(Source Grounding 照合ビュー)</span></h2><span class="muted small">Q&amp;A・バリエーションの根拠を <mark class="ev-mark">黄色</mark> で表示(Q&amp;A カードにマウスを乗せると該当箇所が強調)</span></div>
        <div class="gm-src-grid">
          <pre class="src-text" id="gm-src-text">${markMany(ctx.detail.source_text || '', [...(g.questions_and_answers || []).map((q) => q.evidence), ...(g.variant_options || []).map((v) => v.evidence)])}</pre>
          <div class="gm-feed">
            <div class="sec-lab">GMC 補助フィード行プレビュー <button class="btn btn-ghost btn-sm" id="copy-tsv">TSV をコピー</button><button class="btn btn-ghost btn-sm" id="copy-json">JSON をコピー</button></div>
            <div class="feed-table-wrap"><table class="table feed-table"><tbody>${Object.entries(feedRow(p, g)).map(([k, v]) => `<tr><th class="mono">${esc(k)}</th><td>${esc(v)}</td></tr>`).join('')}</tbody></table></div>
          </div>
        </div>
      </div>`;
    bindMain();
  }

  function feedRow(p, g) {
    const fs = feedStrings(g);
    const base = ctx.detail.feed_row || {};
    return { ...base, id: p.sku, item_group_id: g.item_group_id || '', title: p.title, item_group_title: g.item_group_title || '', ...fs, popularity_rank: g.popularity_rank ?? '', document_link: g.document_link || '' };
  }

  function card(key, no, sub, body, feed, cls = '', feed2 = null) {
    const k = key.split(' ')[0];
    return `<div class="panel gspec ${cls}">
      <div class="gspec-head"><span class="gspec-no">${no}</span><div><div class="gspec-key mono">${esc(key)}</div><div class="gspec-sub">${sub}</div></div>
        <a class="gspec-attr mono" href="${GMC_SPEC_URL}" target="_blank" rel="noopener" title="公式仕様">[${esc(k)}]</a></div>
      <div class="gspec-body">${body}</div>
      ${feed !== null ? `<div class="feed-box"><div class="fb-h"><span class="mono">${esc(k)}</span> フィード値 <button class="btn btn-ghost btn-sm copy-feed" data-k="${esc(k)}">コピー</button></div><code class="feed-str" data-k="${esc(k)}">${esc(feed || '(空)')}</code></div>` : ''}
      ${feed2 !== null ? `<div class="feed-box"><div class="fb-h"><span class="mono">product_detail</span> フィード値 <button class="btn btn-ghost btn-sm copy-feed" data-k="product_detail">コピー</button></div><code class="feed-str" data-k="product_detail">${esc(feed2 || '(空)')}</code></div>` : ''}
    </div>`;
  }

  function qaCard(g) {
    const qas = g.questions_and_answers || [];
    return `<div class="qa-list">${qas.map((q, i) => `
      <div class="qa-item st-${q.status === 'auto_approved' ? 'ok' : 'warn'}" data-i="${i}">
        <div class="qa-no">Q${i + 1}</div>
        <div class="qa-fields">
          <input class="input qa-q" data-qa="${i}" data-k="question" value="${esc(q.question)}" placeholder="質問">
          <textarea class="input qa-a" data-qa="${i}" data-k="answer" rows="2" placeholder="回答">${esc(q.answer)}</textarea>
          <div class="qa-meta">${q.evidence_match != null ? evBadge(q.evidence_match) : '<span class="chip chip-mute">未検証(保存時に照合)</span>'}
            <span class="qa-ev">根拠「<input class="qa-ev-in" data-qa="${i}" data-k="evidence" value="${esc(q.evidence || '')}" placeholder="原本からの引用">」</span>
            ${q.score != null ? `<span class="qa-score">${confBar(q.score)}</span>` : ''}</div>
        </div>
        <button class="icon-btn del" data-del-qa="${i}" title="削除">🗑</button>
      </div>`).join('') || '<div class="muted">Q&amp;A はまだありません</div>'}</div>
      <button class="btn btn-ghost btn-sm" id="add-qa">＋ Q&amp;Aを追加</button>`;
  }
  function voCard(g) {
    const vos = g.variant_options || [];
    return `<div class="vo-list">${vos.map((v, i) => `<div class="vo-item"><input class="input" data-vo="${i}" data-k="name" value="${esc(v.name)}" placeholder="軸 (例: カラー)"><span class="vo-sep">:</span><input class="input" data-vo="${i}" data-k="value" value="${esc(v.value)}" placeholder="値">
      ${v.evidence_match != null ? (v.evidence_match >= 0.8 ? '<span class="chip chip-ok" title="根拠一致">🟢</span>' : '<span class="chip chip-warn" title="要確認">🟡</span>') : ''}<button class="icon-btn del" data-del-vo="${i}" title="削除">🗑</button></div>`).join('') || '<div class="muted small">バリエーション軸なし</div>'}</div>
      <button class="btn btn-ghost btn-sm" id="add-vo">＋ 軸を追加</button>`;
  }
  function rpCard(g) {
    const rps = g.related_products || [];
    return `<div class="rp-list">${rps.map((r, i) => `<div class="rp-item">
        <select class="select rp-type" data-rp="${i}" data-k="relationship_type">${REL_TYPES.map((t) => `<option value="${t}" ${t === r.relationship_type ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <div class="rp-txt"><div class="mono small">${esc(r.identifier_type || 'id')}:${esc(r.identifier)}</div>
          ${ctx.items.some((x) => x.sku === r.identifier) || r.identifier_type === 'id' ? `<a href="#/gmc/${encodeURIComponent(r.identifier)}" class="rp-link" data-jump="${esc(r.identifier)}">${esc(r.title || r.identifier)}</a>` : `<span>${esc(r.title || r.identifier)}</span>`}</div>
        <span class="rel-badge rel-${esc(r.relationship_type)}">${esc(REL_LABEL[r.relationship_type] || r.relationship_type)}</span>
        <button class="icon-btn del" data-del-rp="${i}" title="削除">🗑</button></div>`).join('') || '<div class="muted small">関連商品なし</div>'}</div>
      <div class="rp-add"><select class="select" id="rp-new-type">${REL_TYPES.map((t) => `<option>${t}</option>`).join('')}</select><input class="input" id="rp-new-id" placeholder="関連 SKU (id)"><button class="btn btn-ghost btn-sm" id="add-rp">＋ 追加</button></div>`;
  }
  function hlCard(g) {
    const hls = g.product_highlights || [];
    const dts = g.product_details || [];
    return `<div class="hl-grid"><div>
        <div class="sec-lab">product_highlight <span class="muted small">(商品の要点・最大6件)</span></div>
        <div class="hl-list">${hls.map((h, i) => `<div class="hl-item"><span class="hl-dot">✓</span><input class="input" data-hl="${i}" value="${esc(h)}"><button class="icon-btn del" data-del-hl="${i}" title="削除">🗑</button></div>`).join('') || '<div class="muted small">ハイライトなし</div>'}</div>
        <button class="btn btn-ghost btn-sm" id="add-hl" ${hls.length >= 6 ? 'disabled' : ''}>＋ ハイライトを追加</button></div>
      <div><div class="sec-lab">product_detail <span class="muted small">(ゴールデンレコードから自動生成)</span></div>
        <div class="pd-wrap"><table class="table pd-table"><thead><tr><th>section</th><th>attribute</th><th>value</th></tr></thead><tbody>${dts.map((d) => `<tr><td class="muted">${esc(d.section)}</td><td>${esc(d.attribute)}</td><td><b>${esc(d.value)}</b></td></tr>`).join('') || '<tr><td colspan="3" class="muted">承認済み属性なし</td></tr>'}</tbody></table></div></div></div>`;
  }

  function aiPreview(p, g) {
    const qas = (g.questions_and_answers || []).slice(0, 3);
    const vos = g.variant_options || [];
    const q0 = qas[0] ? qas[0].question : `${g.item_group_title || p.title} の特長は？`;
    return `<div class="aim">
      <div class="aim-search"><span class="aim-g"><i></i><i></i><i></i><i></i></span><span class="aim-q">${esc(q0)}</span><span class="aim-mode">AI モード</span></div>
      <div class="aim-body">
        <div class="aim-prod">
          <div class="aim-img"><img src="${esc(p.image_url)}" alt="" onerror="this.style.visibility='hidden'"></div>
          <div class="aim-info"><div class="aim-group muted small">item_group_title</div><div class="aim-title">${esc(g.item_group_title || p.title)}</div>
            <div class="aim-price">${p.price ? '¥' + fmtInt(p.price) : ''} <span class="muted small">公式ストア</span></div>
            <div class="aim-vars">${vos.map((v, i) => `<span class="aim-var ${i === 0 ? 'on' : ''}">${esc(v.name)}:<b>${esc(v.value)}</b></span>`).join('') || '<span class="muted small">variant_option なし</span>'}</div>
            <ul class="aim-hl">${(g.product_highlights || []).slice(0, 4).map((h) => `<li>${esc(h)}</li>`).join('')}</ul></div>
        </div>
        <div class="aim-chat">${qas.map((q) => `<div class="bub user">${esc(q.question)}</div><div class="bub ai"><span class="ai-spark">✦</span><div>${esc(q.answer)}<div class="bub-meta">${q.evidence_match > 0 ? '<span class="chip chip-ok">✓ 根拠確認済</span>' : '<span class="chip chip-warn">要確認</span>'}<span class="muted small">出典: 商品マスタ情報</span></div></div></div>`).join('') || '<div class="muted">Q&amp;A を追加するとここに会話プレビューが表示されます</div>'}</div>
        ${(g.related_products || []).length ? `<div class="aim-rel"><span class="muted small">関連商品:</span>${g.related_products.map((r) => `<a class="aim-rel-chip" href="#/gmc/${encodeURIComponent(r.identifier)}" data-jump="${esc(r.identifier)}"><span class="rel-badge rel-${esc(r.relationship_type)}">${esc(r.relationship_type)}</span>${esc((r.title || r.identifier).slice(0, 28))}</a>`).join('')}</div>` : ''}
      </div></div>`;
  }

  function setDirty() {
    ctx.dirty = true;
    const d = $('#dirty-pill', root); if (d) d.hidden = false;
    const fs = feedStrings(ctx.g);
    $$('.feed-str', root).forEach((el) => { if (fs[el.dataset.k] !== undefined) el.textContent = fs[el.dataset.k] || '(空)'; });
  }

  function bindMain() {
    const main = $('#gmc-main', root);
    main.addEventListener('input', (e) => {
      const t = e.target; const g = ctx.g;
      if (t.dataset.f) { g[t.dataset.f] = t.dataset.f === 'popularity_rank' ? (t.value === '' ? null : Number(t.value)) : t.value; if (t.dataset.f === 'popularity_rank') { const f = $('.rank-fill', main); if (f) f.style.width = Math.max(0, Math.min(100, Number(t.value) || 0)) + '%'; $('.rank-num', main).textContent = t.value || '—'; } }
      else if (t.dataset.qa) { const q = g.questions_and_answers[+t.dataset.qa]; q[t.dataset.k] = t.value; q.evidence_match = null; q.score = null; q.status = null; }
      else if (t.dataset.vo) { const v = g.variant_options[+t.dataset.vo]; v[t.dataset.k] = t.value; if (t.dataset.k === 'value') v.evidence = t.value; }
      else if (t.dataset.hl) g.product_highlights[+t.dataset.hl] = t.value;
      else return;
      setDirty();
    });
    main.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.rp) { ctx.g.related_products[+t.dataset.rp][t.dataset.k] = t.value; setDirty(); paintMain(); }
    });
    main.addEventListener('click', (e) => {
      const t = e.target.closest('button, a'); if (!t) return;
      const g = ctx.g;
      const del = (arr, i) => { g[arr].splice(i, 1); setDirty(); paintMain(); };
      if (t.dataset.delQa) del('questions_and_answers', +t.dataset.delQa);
      else if (t.dataset.delVo) del('variant_options', +t.dataset.delVo);
      else if (t.dataset.delRp) del('related_products', +t.dataset.delRp);
      else if (t.dataset.delHl) del('product_highlights', +t.dataset.delHl);
      else if (t.id === 'add-qa') { (g.questions_and_answers = g.questions_and_answers || []).push({ question: '', answer: '', evidence: '', confidence: 0.95 }); setDirty(); paintMain(); $$('.qa-q', main).pop()?.focus(); }
      else if (t.id === 'add-vo') { (g.variant_options = g.variant_options || []).push({ name: '', value: '' }); setDirty(); paintMain(); }
      else if (t.id === 'add-hl') { (g.product_highlights = g.product_highlights || []).push(''); setDirty(); paintMain(); }
      else if (t.id === 'add-rp') {
        const id = $('#rp-new-id', main).value.trim(); if (!id) { toast('関連 SKU を入力してください', 'warn'); return; }
        const hit = ctx.items.find((x) => x.sku === id);
        (g.related_products = g.related_products || []).push({ relationship_type: $('#rp-new-type', main).value, identifier_type: 'id', identifier: id, title: hit ? hit.title : id });
        setDirty(); paintMain();
      } else if (t.dataset.jump) { e.preventDefault(); select(t.dataset.jump); }
      else if (t.classList.contains('copy-feed')) copy(feedStrings(g)[t.dataset.k] || '', `${t.dataset.k} をコピーしました`);
      else if (t.id === 'copy-tsv') { const row = feedRow(ctx.detail.product, g); copy(Object.keys(row).join('\t') + '\n' + Object.values(row).map((v) => String(v ?? '').replace(/[\t\n]/g, ' ')).join('\t'), 'TSV 行をコピーしました'); }
      else if (t.id === 'copy-json') copy(JSON.stringify(feedRow(ctx.detail.product, g), null, 2), 'JSON をコピーしました');
      else if (t.id === 'btn-gmc-regen') regen(t);
      else if (t.id === 'btn-gmc-save') save(t);
    });
    // Hover a Q&A → emphasise its evidence in the source view
    $$('.qa-item', main).forEach((el) => {
      el.addEventListener('mouseenter', () => {
        const m = $(`#gm-src-text mark[data-ev="${el.dataset.i}"]`, main);
        if (!m) return;
        m.classList.add('hot');
        const pre = $('#gm-src-text', main); // scroll inside the source pane only (never the page)
        if (pre) pre.scrollTo({ top: Math.max(0, m.offsetTop - pre.offsetTop - pre.clientHeight / 3), behavior: 'smooth' });
      });
      el.addEventListener('mouseleave', () => $$('#gm-src-text mark.hot', main).forEach((m) => m.classList.remove('hot')));
    });
  }

  function copy(txt, msg) {
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => toast(msg, 'ok')).catch(() => toast('コピーできませんでした', 'warn'));
  }

  async function regen(btn) {
    if (ctx.busy) return;
    if (ctx.dirty && !window.confirm('未保存の編集内容は破棄されます。再生成しますか？')) return;
    ctx.busy = true; btn.disabled = true; btn.classList.add('running');
    const sku = ctx.sku;
    try {
      const res = await api.gmcGenerate(sku);
      if (stale() || ctx.sku !== sku) return;
      ctx.detail = res; ctx.g = JSON.parse(JSON.stringify(res.gmc || {})); ctx.dirty = false;
      paintMain();
      $('.gspec-grid', root)?.classList.add('flash');
      toast(`会話属性を再生成しました(${fmtInt(res.latency_ms)} ms ・ 入力 ${fmtInt(res.input_tokens)} / 出力 ${fmtInt(res.output_tokens)} tokens)`, 'ok', 5000);
      loadList(true);
    } catch (e) { toast('再生成に失敗しました: ' + e.message, 'err', 6000); } finally {
      ctx.busy = false; const b = $('#btn-gmc-regen', root); if (b) { b.disabled = false; b.classList.remove('running'); }
    }
  }

  async function save(btn) {
    if (ctx.busy) return;
    const g = ctx.g;
    const rank = g.popularity_rank;
    if (rank !== null && rank !== undefined && rank !== '' && (rank < 0 || rank > 100)) { toast('popularity_rank は 0〜100 で入力してください', 'warn'); return; }
    ctx.busy = true; btn.disabled = true; btn.classList.add('loading');
    const sku = ctx.sku;
    try {
      const body = {
        item_group_id: g.item_group_id || '', item_group_title: g.item_group_title || '', document_link: g.document_link || '',
        popularity_rank: rank === '' ? null : rank,
        variant_options: (g.variant_options || []).filter((v) => v.name && v.value).map((v) => ({ name: v.name, value: v.value, evidence: v.evidence || v.value })),
        questions_and_answers: (g.questions_and_answers || []).filter((q) => q.question && q.answer).map((q) => ({ question: q.question, answer: q.answer, evidence: q.evidence || '', confidence: q.confidence ?? 0.95 })),
        product_highlights: (g.product_highlights || []).filter((h) => String(h).trim()),
        related_products: (g.related_products || []).filter((r) => r.identifier),
      };
      const res = await api.gmcUpdate(sku, body);
      if (stale() || ctx.sku !== sku) return;
      ctx.detail = res; ctx.g = JSON.parse(JSON.stringify(res.gmc || {})); ctx.dirty = false;
      paintMain();
      toast('編集内容を BigQuery (gmc_conversational) に保存しました', 'ok');
      loadList(true);
    } catch (e) { toast('保存に失敗しました: ' + e.message, 'err', 6000); } finally {
      ctx.busy = false; const b = $('#btn-gmc-save', root); if (b) { b.disabled = false; b.classList.remove('loading'); }
    }
  }

  // filters
  $$('.gl-filters .fchip', root).forEach((b) => b.addEventListener('click', () => {
    filt.group = b.dataset.g;
    $$('.gl-filters .fchip', root).forEach((x) => x.classList.toggle('on', x === b));
    loadList(true);
  }));
  let t;
  $('#gl-q', root).addEventListener('input', (e) => { clearTimeout(t); t = setTimeout(() => { filt.q = e.target.value.trim(); loadList(true); }, 300); });
  const onBeforeUnload = (e) => { if (ctx.dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onBeforeUnload);

  await loadList(false);
  if (ctx.sku && !ctx.detail) await select(ctx.sku, { replace: true });
  else if (!ctx.sku && !ctx.items.length) $('#gmc-main', root).innerHTML = emptyState('🛍', 'SKU がありません', 'CSV ライブテストやバッチで商品を投入してください');
  return () => { clearTimeout(t); window.removeEventListener('beforeunload', onBeforeUnload); };
}
