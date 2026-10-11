// ③ エンリッチ・スタジオ — 原本 (Before) と エンリッチ後 (After) の比較、根拠ハイライト、ライブ実行
import { api } from '../api.js?v=3';
import {
  esc, $, $$, fmtInt, fmtPct, fmtScore, fmtValue, chip, confBar, scoreCls, tip, skeleton, errorState, emptyState,
  toast, state, productList, stepper, refreshShell, findEvidence, markText, STATUS,
} from '../ui.js?v=3';

const FIELD_LABEL = { title: 'タイトル', description: '説明文', attributes: '原本属性', '': '—' };

export async function render(root, params, stale) {
  let sku = params[0];
  let list = [];
  try { list = await productList(); } catch (e) { /* keep empty */ }
  if (stale()) return;
  if (!sku) {
    if (!list.length) { root.innerHTML = emptyState('📦', '商品がありません', 'データ投入後に再度お試しください'); return; }
    location.replace('#/studio/' + encodeURIComponent(list[0].sku));
    return;
  }
  const idx = list.findIndex((p) => p.sku === sku);
  const prev = idx > 0 ? list[idx - 1] : null;
  const next = idx >= 0 && idx < list.length - 1 ? list[idx + 1] : null;

  root.innerHTML = `
    <div class="studio-top">
      <div class="st-nav">
        <a class="btn btn-ghost btn-sm ${prev ? '' : 'disabled'}" ${prev ? `href="#/studio/${encodeURIComponent(prev.sku)}"` : ''} title="前の商品">‹ 前へ</a>
        <select id="st-select" class="select" aria-label="商品を選択">
          ${list.map((p) => `<option value="${esc(p.sku)}" ${p.sku === sku ? 'selected' : ''}>${esc(p.group_label)}|${esc(p.title)}</option>`).join('')}
          ${idx < 0 ? `<option selected value="${esc(sku)}">SKU ${esc(sku)}</option>` : ''}
        </select>
        <a class="btn btn-ghost btn-sm ${next ? '' : 'disabled'}" ${next ? `href="#/studio/${encodeURIComponent(next.sku)}"` : ''} title="次の商品">次へ ›</a>
        <span class="muted small">${idx >= 0 ? `${idx + 1} / ${list.length}` : ''}</span>
      </div>
      <div class="st-actions">
        <span id="st-status"></span>
        <a class="btn btn-outline btn-sm" href="#/images/${encodeURIComponent(sku)}" title="この商品の季節訴求画像を生成">🎨 季節画像を作る</a>
        <a class="btn btn-outline btn-sm" href="#/gmc/${encodeURIComponent(sku)}" title="GMC 会話属性を確認">🛍 GMC 会話属性</a>
        <button class="btn btn-primary btn-live" id="btn-live"><span class="live-ic">▶</span><span class="live-txt">Geminiでライブ実行</span></button>
      </div>
    </div>
    <div class="studio">
      <section class="panel src" id="src">${skeleton(1, 'skel-panel')}</section>
      <section class="panel aft" id="aft">${skeleton(1, 'skel-panel')}</section>
    </div>`;
  $('#st-select', root).addEventListener('change', (e) => { location.hash = '#/studio/' + encodeURIComponent(e.target.value); });

  const ctx = { root, sku, detail: null, pinned: null, ctrl: null, running: false, popover: null, timer: null };

  try {
    ctx.detail = await api.product(sku);
  } catch (e) {
    if (stale()) return;
    $('.studio', root).innerHTML = errorState(e, 'st-retry');
    const r = $('#st-retry', root); if (r) r.onclick = () => render(root, params, stale);
    return;
  }
  if (stale()) return;
  paintAll(ctx);
  $('#btn-live', root).addEventListener('click', () => liveRun(ctx));

  const onDocClick = (e) => {
    if (ctx.popover && !ctx.popover.contains(e.target) && !e.target.closest('.acard, .tagpill')) closePopover(ctx);
  };
  const onKey = (e) => { if (e.key === 'Escape') closePopover(ctx); };
  document.addEventListener('mousedown', onDocClick);
  document.addEventListener('keydown', onKey);
  const onScroll = () => closePopover(ctx);
  $('#aft', root).addEventListener('scroll', onScroll, { passive: true });

  return () => {
    document.removeEventListener('mousedown', onDocClick);
    document.removeEventListener('keydown', onKey);
    closePopover(ctx);
    if (ctx.ctrl) ctx.ctrl.abort();
    clearInterval(ctx.timer);
    if (ctx.running || stepper.live) stepper.endLive();
  };
}

// ── Painting ───────────────────────────────────────────────────────────────
function paintAll(ctx) {
  paintSource(ctx);
  paintAfter(ctx);
  paintStatus(ctx);
}

function paintStatus(ctx) {
  const d = ctx.detail;
  $('#st-status', ctx.root).innerHTML = `${chip(d.status)} <span class="ba-mini">充足率 <b class="b">${fmtPct(d.fill_before)}</b> ➜ <b class="a">${fmtPct(d.fill_after)}</b></span>`;
}

function paintSource(ctx) {
  const { product: p } = ctx.detail;
  const attrs = p.raw_attributes || {};
  const keys = Object.keys(attrs);
  $('#src', ctx.root).innerHTML = `
    <div class="panel-head sticky"><h2><span class="ba-tag before">Before</span> 原本データ</h2>
      <span class="muted small">商品マスタ(未加工)</span></div>
    <div class="ev-note" id="ev-note" hidden></div>
    <div class="src-scroll" id="src-scroll">
      <div class="src-prod">
        <div class="src-img"><img src="${esc(p.image_url)}" alt="" onerror="this.style.visibility='hidden'"></div>
        <div class="src-info">
          <div class="src-title" data-src="title">${esc(p.title)}</div>
          <div class="src-meta">
            <span><span class="k">ブランド</span>${esc(p.brand || '—')}</span>
            <span><span class="k">価格</span>${p.price ? '¥' + fmtInt(p.price) : '—'}</span>
            <span><span class="k">SKU</span>${esc(p.sku)}</span>
          </div>
          <div class="src-cat">${esc(p.category || p.group_label || '')}</div>
          ${p.product_url && p.product_url !== '#' ? `<a class="ext" href="${esc(p.product_url)}" target="_blank" rel="noopener">商品ページを見る ↗</a>` : ''}
        </div>
      </div>
      <div class="src-sec"><div class="src-lab">説明文 <span class="muted small">description</span></div>
        <div class="src-desc" data-src="description">${esc(p.description || '(説明文なし)')}</div></div>
      <div class="src-sec"><div class="src-lab">原本属性 <span class="muted small">raw_attributes ・ ${keys.length} 項目</span></div>
        ${keys.length ? `<table class="raw-table"><tbody>${keys.map((k) => `<tr data-row="${esc(k)}"><th>${esc(k)}</th><td data-src="attributes" data-key="${esc(k)}">${esc(fmtRaw(attrs[k]))}</td></tr>`).join('')}</tbody></table>`
          : '<div class="muted">原本属性はありません</div>'}
      </div>
    </div>`;
  // Register raw texts for highlight re-rendering
  ctx.srcEls = $$('[data-src]', $('#src', ctx.root)).map((el) => ({ el, field: el.dataset.src, text: el.dataset.src === 'description' && !p.description ? '' : el.textContent }));
}

function fmtRaw(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function recordsByKey(d) {
  const m = {};
  (d.records || []).forEach((r) => { if (r.kind !== 'tag') m[r.attr_key] = r; });
  return m;
}

function paintAfter(ctx, { flash = false } = {}) {
  const d = ctx.detail;
  const byKey = recordsByKey(d);
  const targets = d.targets || [];
  const seen = new Set(targets.map((t) => t.key));
  const extra = Object.values(byKey).filter((r) => !seen.has(r.attr_key)).map((r) => ({ key: r.attr_key, label: r.label, unit: r.unit, type: typeof r.value }));
  const all = [...targets, ...extra];
  const tags = (d.records || []).filter((r) => r.kind === 'tag');
  const cnt = { ok: 0, warn: 0, bad: 0 };
  (d.records || []).forEach((r) => { const c = (STATUS[r.gate_status] || {}).cls; if (c === 'ok' || c === 'info') cnt.ok++; else if (c === 'warn') cnt.warn++; else if (c === 'bad' || c === 'dark') cnt.bad++; });
  const filled = all.filter((t) => byKey[t.key]).length;
  const ex = d.extras || {};

  $('#aft', ctx.root).innerHTML = `
    <div class="panel-head sticky"><h2><span class="ba-tag after">After</span> エンリッチ後</h2>
      <div class="aft-sum"><span class="cnt ok">🟢 ${cnt.ok}</span><span class="cnt warn">🟡 ${cnt.warn}</span><span class="cnt bad">🔴 ${cnt.bad}</span>
      <span class="muted small">${filled}/${all.length} 属性を抽出</span></div></div>
    <div class="aft-scroll" id="aft-scroll">
      <div class="livelog" id="livelog" hidden></div>
      <div class="hint">💡 カードにマウスを乗せると、AI が根拠にした原本の箇所が <mark class="ev-mark">黄色</mark> で光ります。クリックでスコア内訳を表示。</div>
      <div class="agrid ${flash ? 'flash' : ''}">
        ${all.map((t) => attrCard(t, byKey[t.key])).join('') || emptyState('🧩', '対象属性がありません')}
      </div>
      <div class="aft-sec"><div class="sec-lab">機能タグ ${tip('?', '標準タグ辞書から、原本に根拠のある機能だけを付与します。検索の絞り込みに使えます')}</div>
        <div class="tags big">${tags.length ? tags.map((r) => `<button class="tagpill st-${(STATUS[r.gate_status] || {}).cls || 'mute'}" data-key="${esc(r.attr_key)}"><span>${esc(r.label)}</span><span class="tp-score">${fmtScore(r.score)}</span></button>`).join('') : '<span class="muted">タグなし</span>'}</div></div>
      <div class="aft-sec two">
        <div><div class="sec-lab">検索キーワード <span class="muted small">AI 生成</span></div>
          <div class="kw">${(ex.search_keywords || []).map((k) => `<span class="kwpill">🔍 ${esc(k)}</span>`).join('') || '<span class="muted">—</span>'}</div></div>
        <div><div class="sec-lab">AI 要約 <span class="muted small">AI 生成</span></div>
          <div class="summary">${ex.ai_summary ? esc(ex.ai_summary) : '<span class="muted">—</span>'}</div></div>
      </div>
      <details class="jsonview">
        <summary>{ } 生成JSON ${tip('responseSchema', 'Gemini に「この形の JSON で答えて」と型を指定する機能。自由文ではなく、そのままシステムに取り込める構造化データが得られます')} <span class="muted small">${(d.records || []).length} records</span></summary>
        <div class="json-actions"><button class="btn btn-ghost btn-sm" id="copy-json">コピー</button></div>
        <pre class="json" id="json-pre">${jsonHtml(d.records || [])}</pre>
      </details>
    </div>`;
  bindAfter(ctx);
}

function attrCard(t, r) {
  if (!r) {
    return `<div class="acard missing" data-key="${esc(t.key)}"><div class="ac-head"><span class="ac-label">${esc(t.label)}</span>${chip('missing')}</div>
      <div class="ac-val"><span class="v">—</span><span class="u">${esc(t.unit || '')}</span></div><div class="ac-raw">原本に記載なし</div><div class="conf"><div class="conf-track"></div><span class="conf-num">—</span></div></div>`;
  }
  const cls = (STATUS[r.gate_status] || {}).cls || 'mute';
  return `<div class="acard st-${cls}" data-key="${esc(r.attr_key)}" tabindex="0">
    <div class="ac-head"><span class="ac-label">${esc(r.label || t.label)}</span>${chip(r.gate_status)}</div>
    <div class="ac-val ${r.gate_status === 'rejected' || r.gate_status === 'human_rejected' ? 'struck' : ''}"><span class="v">${r.value === null || r.value === undefined ? '<span class="nullv">変換不可</span>' : esc(fmtValue(r.value, t.type))}</span><span class="u">${esc(r.unit || t.unit || '')}</span></div>
    <div class="ac-raw" title="${esc(r.raw_value)}">raw: ${esc(r.raw_value ?? '—')}</div>
    ${confBar(r.score)}
  </div>`;
}

function jsonHtml(obj) {
  const s = JSON.stringify(obj, null, 2);
  return esc(s)
    .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="jk">$1</span>$2')
    .replace(/(:\s*)(&quot;.*?&quot;)/g, '$1<span class="js">$2</span>')
    .replace(/(:\s*)(-?\d+(?:\.\d+)?|true|false|null)/g, '$1<span class="jn">$2</span>');
}

function findRec(ctx, key) { return (ctx.detail.records || []).find((r) => r.attr_key === key); }

function bindAfter(ctx) {
  const aft = $('#aft', ctx.root);
  $$('.acard:not(.missing), .tagpill', aft).forEach((el) => {
    const key = el.dataset.key;
    el.addEventListener('mouseenter', () => { if (!ctx.pinned) highlight(ctx, findRec(ctx, key)); });
    el.addEventListener('focus', () => { if (!ctx.pinned) highlight(ctx, findRec(ctx, key)); });
    el.addEventListener('mouseleave', () => { if (!ctx.pinned) clearHighlight(ctx); });
    el.addEventListener('click', () => {
      if (ctx.pinned === key) { closePopover(ctx); return; }
      pin(ctx, key, el);
    });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') el.click(); });
  });
  $$('.acard.missing', aft).forEach((el) => el.addEventListener('mouseenter', () => { if (!ctx.pinned) clearHighlight(ctx); }));
  const cp = $('#copy-json', aft);
  if (cp) cp.onclick = (e) => {
    e.preventDefault();
    const txt = JSON.stringify(ctx.detail.records || [], null, 2);
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject()).then(() => toast('JSON をコピーしました', 'ok')).catch(() => toast('コピーできませんでした', 'warn'));
  };
}

// ── Evidence highlight ────────────────────────────────────────────────────
function clearHighlight(ctx) {
  (ctx.srcEls || []).forEach((s) => { if (s.marked) { s.el.innerHTML = esc(s.text); s.marked = false; } s.el.closest('tr')?.classList.remove('row-hit'); });
  const n = $('#ev-note', ctx.root); if (n) n.hidden = true;
}

function highlight(ctx, rec) {
  clearHighlight(ctx);
  if (!rec) return;
  const note = $('#ev-note', ctx.root);
  const els = [...(ctx.srcEls || [])].sort((a, b) => (b.field === rec.source_field) - (a.field === rec.source_field));
  const hits = [];
  let mode = null;
  for (const s of els) {
    const r = findEvidence(s.text, rec.evidence);
    if (r) { s.el.innerHTML = markText(s.text, r); s.marked = true; hits.push(s); mode = mode || r.mode; }
  }
  let valueOnly = false;
  if (!hits.length && rec.raw_value !== null && rec.raw_value !== undefined && String(rec.raw_value).length >= 2) {
    for (const s of els) {
      const r = findEvidence(s.text, String(rec.raw_value));
      if (r) { s.el.innerHTML = markText(s.text, r, 'ev-mark weak'); s.marked = true; hits.push(s); valueOnly = true; }
    }
  }
  hits.forEach((s) => s.el.closest('tr')?.classList.add('row-hit'));
  if (hits.length) {
    const first = hits[0];
    const mark = first.el.querySelector('mark') || first.el;
    const sc = $('#src-scroll', ctx.root);
    if (sc) {
      const mr = mark.getBoundingClientRect(); const cr = sc.getBoundingClientRect();
      if (mr.top < cr.top + 20 || mr.bottom > cr.bottom - 20) sc.scrollTo({ top: sc.scrollTop + (mr.top - cr.top) - cr.height / 3, behavior: 'smooth' });
    }
    if (valueOnly) {
      note.className = 'ev-note warn';
      note.innerHTML = `⚠ 根拠文「${esc(rec.evidence || '—')}」は原本に見つかりません。値「${esc(rec.raw_value)}」のみ一致(${esc(FIELD_LABEL[first.field] || first.field)})`;
    } else {
      note.className = 'ev-note ok';
      note.innerHTML = `📍 <b>${esc(rec.label)}</b> の根拠: ${esc(FIELD_LABEL[first.field] || first.field)} ・ ${mode === 'exact' ? '完全一致' : '表記ゆれを吸収して一致'}`;
    }
  } else {
    note.className = 'ev-note bad';
    note.innerHTML = `⚠ 根拠が原本に見つかりません — AI の根拠「${esc(rec.evidence || '(なし)')}」は原本に存在しないため、人の確認が必要です`;
  }
  note.hidden = false;
}

function pin(ctx, key, el) {
  closePopover(ctx, { keepHighlight: true });
  ctx.pinned = key;
  $$('.acard.pinned, .tagpill.pinned', ctx.root).forEach((x) => x.classList.remove('pinned'));
  el.classList.add('pinned');
  const rec = findRec(ctx, key);
  highlight(ctx, rec);
  openPopover(ctx, rec, el);
}

function closePopover(ctx, { keepHighlight = false } = {}) {
  if (ctx.popover) { ctx.popover.remove(); ctx.popover = null; }
  if (!keepHighlight) {
    ctx.pinned = null;
    $$('.acard.pinned, .tagpill.pinned', ctx.root).forEach((x) => x.classList.remove('pinned'));
    clearHighlight(ctx);
  }
}

// ── Detail popover (score breakdown + HITL) ────────────────────────────────
function openPopover(ctx, rec, anchor) {
  if (!rec) return;
  const w = (state.config && state.config.weights) || { evidence: 0.5, self: 0.3, token: 0.2 };
  const noTok = rec.token_conf === null || rec.token_conf === undefined;
  const wn = (state.config && state.config.weights_no_token) || { evidence: 0.6, self: 0.4 };
  const we = noTok ? wn.evidence : w.evidence, ws = noTok ? wn.self : w.self, wt = noTok ? 0 : w.token;
  const thr = (state.config && state.config.threshold) || 0.9;
  const comp = [
    ['根拠一致', 'evidence_match', rec.evidence_match, we, 'AI が示した根拠テキストが原本に実在するか(1.0 完全一致 / 0.8 表記ゆれ / 0.5 値のみ / 0 なし)'],
    ['自己確信度', 'self_conf', rec.self_conf, ws, 'Gemini 自身が申告した確からしさ'],
    ['トークン確率', 'token_conf', noTok ? null : rec.token_conf, wt, '生成時の各トークンの確率(logprobs)から算出。取得できない場合は重みを再配分'],
  ];
  const rows = comp.map(([lab, key, v, wt2, help]) => {
    const has = v !== null && v !== undefined;
    return `<div class="sb-row"><div class="sb-lab">${tip(lab, help)}<span class="muted small">${key}</span></div>
      <div class="sb-bar"><div class="sb-fill conf-${scoreCls(v)}" style="width:${has ? v * 100 : 0}%"></div></div>
      <div class="sb-v">${has ? fmtScore(v) : '—'}</div><div class="sb-w">×${wt2 ? wt2.toFixed(1) : '—'}</div><div class="sb-c">${has && wt2 ? '+' + (v * wt2).toFixed(3) : '—'}</div></div>`;
  }).join('');
  const gateLab = rec.gate === 'gate1' ? '第1関門(ルール)' : rec.gate === 'gate2' ? '第2関門(AIスコア)' : (rec.gate || '—');
  const needs = rec.gate_status === 'needs_review';
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.innerHTML = `
    <div class="pop-head"><div><div class="pop-title">${esc(rec.label)}</div><div class="muted small">${esc(rec.attr_key)}</div></div>${chip(rec.gate_status)}<button class="icon-btn pop-x" aria-label="閉じる">✕</button></div>
    <div class="pop-val"><span class="v">${esc(fmtValue(rec.value))}</span><span class="u">${esc(rec.unit || '')}</span><span class="pop-raw">← raw「${esc(rec.raw_value ?? '—')}」</span></div>
    ${rec.norm_note ? `<div class="pop-note">🔧 正規化: ${esc(rec.norm_note)}</div>` : ''}
    <div class="pop-ev"><span class="k">根拠</span>「${esc(rec.evidence || '—')}」<span class="muted small">(${esc(FIELD_LABEL[rec.source_field] || rec.source_field || '—')})</span></div>
    <div class="pop-sec">スコア内訳 ${noTok ? `<span class="muted small">(トークン確率なし → 重み ${we.toFixed(1)} / ${ws.toFixed(1)} に再配分)</span>` : ''}</div>
    <div class="sb">${rows}
      <div class="sb-total"><span>複合スコア</span>${confBar(rec.score)}<span class="muted small">基準 ${thr.toFixed(2)}</span></div></div>
    <div class="pop-gate gate-${(STATUS[rec.gate_status] || {}).cls || 'mute'}"><b>${esc(gateLab)}</b> ${esc(rec.reason || '')}</div>
    ${rec.reviewed ? `<div class="muted small">人手レビュー: ${esc(rec.reviewed.action)} ${esc(rec.reviewed.comment || '')}</div>` : ''}
    ${needs ? `<div class="pop-hitl"><div class="pop-sec">この項目をレビュー</div>
      <div class="hitl-btns"><button class="btn btn-ok btn-sm" data-act="approve">✓ 承認</button><button class="btn btn-outline btn-sm" data-act="edit">✎ 修正して承認</button><button class="btn btn-bad btn-sm" data-act="reject">✕ 却下</button></div>
      <div class="edit-row" hidden><input class="input" id="pop-edit" value="${esc(rec.value ?? '')}"><span class="muted">${esc(rec.unit || '')}</span><button class="btn btn-primary btn-sm" data-act="edit-save">保存</button></div></div>` : ''}
    <div class="pop-foot muted small">model ${esc(rec.model || '—')} ・ job ${esc(rec.job_id || '—')}</div>`;
  document.body.appendChild(pop);
  ctx.popover = pop;
  // position: keep the popover over the After panel so the highlighted evidence (left) stays visible
  const r = anchor.getBoundingClientRect();
  const aft = $('#aft', ctx.root).getBoundingClientRect();
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  const minLeft = Math.min(aft.left + 8, window.innerWidth - pw - 8);
  let left;
  if (r.right + 12 + pw <= window.innerWidth - 8) left = r.right + 12;
  else if (r.left - 12 - pw >= minLeft) left = r.left - 12 - pw;
  else left = Math.max(minLeft, Math.min(r.left, window.innerWidth - pw - 8));
  const top = Math.max(70, Math.min(r.top - 10, window.innerHeight - ph - 12));
  pop.style.left = left + 'px';
  pop.style.top = top + 'px';
  requestAnimationFrame(() => pop.classList.add('show'));
  $('.pop-x', pop).onclick = () => closePopover(ctx);
  if (needs) {
    const act = async (action, value) => {
      $$('.hitl-btns button, [data-act="edit-save"]', pop).forEach((b) => { b.disabled = true; });
      try {
        const body = { action, comment: 'studio' };
        if (action === 'edit') body.value = value;
        const res = await api.review(rec.sku, rec.attr_key, body);
        Object.assign(rec, res.record || {});
        toast(`「${rec.label}」を${{ approve: '承認', edit: '修正して承認', reject: '却下' }[action]}しました(残り ${fmtInt(res.remaining)} 件)`, 'ok');
        closePopover(ctx);
        paintAfter(ctx);
        state.products = null;
        refreshShell();
      } catch (e) {
        toast(e.message, 'err');
        $$('.hitl-btns button, [data-act="edit-save"]', pop).forEach((b) => { b.disabled = false; });
      }
    };
    $$('[data-act]', pop).forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.act;
      if (a === 'edit') { $('.edit-row', pop).hidden = false; $('#pop-edit', pop).focus(); return; }
      if (a === 'edit-save') { act('edit', coerce($('#pop-edit', pop).value, rec.value)); return; }
      act(a);
    }));
    $('#pop-edit', pop).addEventListener('keydown', (e) => { if (e.key === 'Enter') act('edit', coerce(e.target.value, rec.value)); });
  }
}

export function coerce(v, orig) {
  const s = String(v).trim();
  if (typeof orig === 'number') { const n = Number(s.replace(/[,，]/g, '')); return isNaN(n) ? s : n; }
  if (typeof orig === 'boolean') return /^(true|1|あり|はい|yes)$/i.test(s);
  return s;
}

// ── Live run (POST + SSE) ──────────────────────────────────────────────────
async function liveRun(ctx) {
  if (ctx.running) return;
  closePopover(ctx);
  ctx.running = true;
  const btn = $('#btn-live', ctx.root);
  btn.disabled = true; btn.classList.add('running');
  const t0 = performance.now();
  const setBtn = () => { $('.live-txt', btn).textContent = `Gemini 実行中… ${((performance.now() - t0) / 1000).toFixed(1)}s`; };
  setBtn();
  ctx.timer = setInterval(setBtn, 100);
  const log = $('#livelog', ctx.root);
  log.hidden = false;
  log.innerHTML = `<div class="ll-head"><span class="live-dot"></span>ライブ実行ログ <span class="muted small">SKU ${esc(ctx.sku)}</span></div><div class="ll-body" id="ll-body"></div>`;
  $('#aft-scroll', ctx.root).scrollTop = 0;
  const body = $('#ll-body', log);
  const line = (html, cls = '') => {
    const t = ((performance.now() - t0) / 1000).toFixed(1).padStart(5, ' ');
    body.insertAdjacentHTML('beforeend', `<div class="ll ${cls}"><span class="ll-t">+${t}s</span><span class="ll-m">${html}</span></div>`);
    body.scrollTop = body.scrollHeight;
  };
  stepper.startLive(ctx.sku);
  $$('.agrid, .tags.big', ctx.root).forEach((x) => x.classList.add('stale'));
  const done = { stage1: null, stage3: null };
  let gotResult = false;
  let current = 0;
  ctx.ctrl = new AbortController();
  const onEvent = (ev) => {
    if (!ctx.running) return;
    switch (ev.event) {
      case 'start':
        stepper.setState(0, 'done'); stepper.setCount(0, '<b>1</b> SKU 読込');
        line(`▶ 開始 ・ モデル <b>${esc(ev.model || '')}</b>`);
        break;
      case 'stage': {
        const s = ev.stage;
        if ((s === 'stage1' || s === 'stage3') && ev.status === 'running') {
          current = 1; stepper.setState(1, 'running'); stepper.setCount(1, '抽出中…');
          line(s === 'stage1' ? '② Stage1: 属性を抽出中(responseSchema 指定)…' : '② Stage3: 機能タグを付与中…', 'run');
        } else if ((s === 'stage1' || s === 'stage3') && ev.status === 'done') {
          done[s] = ev;
          line(s === 'stage1'
            ? `✓ Stage1 完了 ・ <b>${fmtInt(ev.count)}</b> 属性 ・ ${fmtInt(ev.latency_ms)} ms ・ 入力 ${fmtInt(ev.input_tokens)} / 出力 ${fmtInt(ev.output_tokens)} tokens`
            : `✓ Stage3 完了 ・ <b>${fmtInt(ev.count)}</b> タグ ・ ${fmtInt(ev.latency_ms)} ms`, 'ok');
          if (done.stage1 && done.stage3) {
            stepper.setState(1, 'done'); stepper.setCount(1, `<b>${fmtInt(done.stage1.count)}</b> 属性 + <b>${fmtInt(done.stage3.count)}</b> タグ`);
            current = 2; stepper.setState(2, 'running'); stepper.setCount(2, '正規化中…');
          }
        } else if (s === 'normalize') {
          if (!(done.stage1 && done.stage3)) { stepper.setState(1, 'done'); }
          stepper.setState(2, 'done');
          const ok = (ev.count || 0) - (ev.failed || 0);
          stepper.setCount(2, `<b>${fmtInt(ok)}</b>/${fmtInt(ev.count)} OK`);
          line(`✓ ③ 単位正規化 ・ ${fmtInt(ok)}/${fmtInt(ev.count)} 件 OK${ev.failed ? ` ・ <span class="warn-text">${fmtInt(ev.failed)} 件 変換不可</span>` : ''}`, 'ok');
          current = 3; stepper.setState(3, 'running'); stepper.setCount(3, '判定中…');
        } else if (s === 'gate') {
          const m = ev.summary || {};
          stepper.setState(2, 'done');
          stepper.setState(3, 'done');
          stepper.setCount(3, `<span class="sc-ok">自動 <b>${fmtInt(m.auto_approved)}</b></span> <span class="sc-warn">要確認 <b>${fmtInt(m.needs_review)}</b></span>${m.rejected ? ` <span class="sc-bad">棄却 <b>${fmtInt(m.rejected)}</b></span>` : ''}`);
          line(`✓ ④ 判定 ・ 🟢 自動承認 ${fmtInt(m.auto_approved)} ・ 🟡 要レビュー ${fmtInt(m.needs_review)} ・ 🔴 棄却 ${fmtInt(m.rejected)}`, 'ok');
          current = 4; stepper.setState(4, 'running'); stepper.setCount(4, '保存中…');
        }
        break;
      }
      case 'result':
        gotResult = true;
        STEPS_DONE();
        stepper.setCount(4, '<b>1</b> SKU 更新');
        line(`🏁 ⑤ ゴールデンレコードを更新しました(合計 ${((performance.now() - t0) / 1000).toFixed(1)} 秒)`, 'ok strong');
        if (ev.detail) {
          ctx.detail = ev.detail;
          const keepLog = log.innerHTML;
          paintSource(ctx);
          paintAfter(ctx, { flash: true });
          paintStatus(ctx);
          const nl = $('#livelog', ctx.root); nl.hidden = false; nl.innerHTML = keepLog; nl.classList.add('finished');
        }
        break;
      case 'error':
        stepper.setState(current, 'error');
        line(`⛔ エラー: ${esc(ev.message || '')}`, 'err');
        toast('ライブ実行でエラーが発生しました: ' + (ev.message || ''), 'err', 6000);
        break;
      default:
        break;
    }
  };
  function STEPS_DONE() { [0, 1, 2, 3, 4].forEach((i) => stepper.setState(i, 'done')); }
  try {
    await api.enrich(ctx.sku, onEvent, ctx.ctrl.signal);
    if (gotResult) toast('ライブ実行が完了しました', 'ok');
    else if (ctx.running) { stepper.setState(current, 'error'); line('⚠ 結果を受信できませんでした', 'err'); }
  } catch (e) {
    if (e.name !== 'AbortError' && ctx.running) {
      stepper.setState(current, 'error');
      line(`⛔ ${esc(e.message)}`, 'err');
      toast('ライブ実行に失敗しました: ' + e.message, 'err', 6000);
    }
  } finally {
    clearInterval(ctx.timer);
    $$('.agrid.stale, .tags.stale', ctx.root).forEach((x) => x.classList.remove('stale'));
    if (ctx.running) {
      ctx.running = false;
      const b = $('#btn-live', ctx.root);
      if (b) { b.disabled = false; b.classList.remove('running'); $('.live-txt', b).textContent = 'もう一度ライブ実行'; }
      const ll = $('.ll-head .live-dot', ctx.root); if (ll) ll.classList.add('off');
      state.products = null;
      refreshShell();
      stepper.endLive(10000);
    }
  }
}
