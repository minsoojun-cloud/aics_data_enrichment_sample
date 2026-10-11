// ④ HITL レビュー
import { api } from '../api.js?v=3';
import { esc, $, $$, fmtInt, fmtScore, fmtValue, chip, confBar, skeleton, emptyState, errorState, toast, setReviewBadge, refreshShell, findEvidence, markText, tip, state } from '../ui.js?v=3';
import { coerce } from './studio.js?v=3';

function reasonKind(rec) {
  const r = rec.reason || '';
  if ((rec.evidence_match ?? 1) === 0 || /見つかりません|根拠/.test(r)) return { icon: '🔍', title: '根拠が原本に見つかりません', cls: 'bad' };
  if (/正規化/.test(r) || rec.value === null || rec.value === undefined) return { icon: '📐', title: '単位の正規化(標準単位への変換)に失敗', cls: 'warn' };
  if (/物理|限界|整合/.test(r)) return { icon: '📏', title: 'ルール上の矛盾の可能性', cls: 'bad' };
  return { icon: '🤔', title: 'AI の確信度が基準未満', cls: 'warn' };
}

export async function render(root, _params, stale) {
  root.innerHTML = `
    <div class="page-head"><div><h1>HITL レビュー ${tip('?', 'Human-in-the-Loop: AI が自信を持てなかった項目だけを人が確認する仕組み')}</h1>
      <p class="sub">AI が判断に迷った項目だけを確認します。<span class="kbd">A</span> 承認 <span class="kbd">E</span> 修正 <span class="kbd">R</span> 却下 <span class="kbd">J</span>/<span class="kbd">K</span> 移動</p></div>
      <div class="rv-counter" id="rv-counter"></div></div>
    <div class="reviews"><aside class="panel rq" id="rq">${skeleton(6, 'skel-row')}</aside><section class="panel rv" id="rv">${skeleton(1, 'skel-panel')}</section></div>`;

  const ctx = { items: [], i: 0, busy: false, editing: false };
  try {
    const d = await api.reviews({});
    ctx.items = d.items || [];
  } catch (e) {
    if (stale()) return;
    $('.reviews', root).innerHTML = errorState(e, 'rv-retry');
    $('#rv-retry', root).onclick = () => render(root, _params, stale);
    return;
  }
  if (stale()) return;
  setReviewBadge(ctx.items.length);

  const paintQueue = () => {
    $('#rv-counter', root).innerHTML = `残り <b>${fmtInt(ctx.items.length)}</b> 件`;
    const rq = $('#rq', root);
    if (!ctx.items.length) { rq.innerHTML = `<div class="rq-head">レビュー待ち</div>` + emptyState('🎉', 'レビュー待ちはありません', 'すべての項目が判定済みです'); return; }
    rq.innerHTML = `<div class="rq-head">レビュー待ち <span class="muted small">不確かな順</span></div><div class="rq-list">` + ctx.items.map((it, i) => `
      <button class="rq-item ${i === ctx.i ? 'on' : ''}" data-i="${i}">
        <img src="${esc(it.product.image_url)}" alt="" onerror="this.style.visibility='hidden'">
        <div class="rq-txt"><div class="rq-attr">${esc(it.rec.label)} <span class="rq-val">${esc(fmtValue(it.rec.value))}${esc(it.rec.unit || '')}</span></div>
          <div class="rq-prod">${esc(it.product.title)}</div></div>
        <span class="rq-score conf-${it.rec.score >= 0.7 ? 'warn' : 'bad'}-text">${fmtScore(it.rec.score)}</span>
      </button>`).join('') + '</div>';
    $$('.rq-item', rq).forEach((b) => b.addEventListener('click', () => { ctx.i = +b.dataset.i; paint(); }));
    const on = $('.rq-item.on', rq); if (on) on.scrollIntoView({ block: 'nearest' });
  };

  const paintCard = () => {
    const rv = $('#rv', root);
    ctx.editing = false;
    if (!ctx.items.length) {
      rv.innerHTML = emptyState('✅', 'お疲れさまでした!', 'レビュー待ちの項目はすべて処理されました。ダッシュボードで結果を確認できます') + '<div class="center"><a class="btn btn-primary" href="#/dashboard">ダッシュボードへ</a></div>';
      return;
    }
    const it = ctx.items[ctx.i];
    const r = it.rec;
    const rk = reasonKind(r);
    const range = findEvidence(it.source_text || '', r.evidence);
    let srcHtml; let evNote = '';
    if (range) srcHtml = markText(it.source_text, range);
    else {
      const vr = r.raw_value ? findEvidence(it.source_text || '', String(r.raw_value)) : null;
      srcHtml = markText(it.source_text || '', vr, 'ev-mark weak');
      evNote = `<div class="ev-note inline ${vr ? 'warn' : 'bad'}">⚠ 根拠「${esc(r.evidence || '—')}」が原本に見つかりません${vr ? `(値「${esc(r.raw_value)}」のみ一致)` : ''}</div>`;
    }
    rv.innerHTML = `
      <div class="rv-prod"><img src="${esc(it.product.image_url)}" alt="" onerror="this.style.visibility='hidden'">
        <div><div class="muted small">${esc(it.product.group_label)} ・ SKU ${esc(r.sku)} ・ ${ctx.i + 1} / ${ctx.items.length}</div>
        <a class="rv-title" href="#/studio/${encodeURIComponent(r.sku)}">${esc(it.product.title)}</a></div></div>
      <div class="rv-reason ${rk.cls}"><span class="rr-ic">${rk.icon}</span><div><div class="rr-title">要レビュー理由: ${esc(rk.title)}</div><div class="rr-sub">${esc(r.reason || '')}</div></div></div>
      <div class="rv-main">
        <div class="rv-ai">
          <div class="sec-lab">${esc(r.kind === 'tag' ? '機能タグ' : '属性')}: <b>${esc(r.label)}</b> <span class="muted small">${esc(r.attr_key)}</span></div>
          <div class="rv-value"><span class="v ${r.value === null || r.value === undefined ? 'nullv' : ''}">${r.value === null || r.value === undefined ? '変換できず' : esc(fmtValue(r.value))}</span><span class="u">${esc(r.unit || '')}</span></div>
          <div class="ac-raw">raw: ${esc(r.raw_value ?? '—')}${r.norm_note ? ` ・ ${esc(r.norm_note)}` : ''}</div>
          <div class="rv-score"><span class="muted small">複合スコア</span>${confBar(r.score)}</div>
          <div class="rv-sub3"><span>根拠一致 <b>${fmtScore(r.evidence_match)}</b></span><span>自己確信度 <b>${fmtScore(r.self_conf)}</b></span><span>トークン確率 <b>${fmtScore(r.token_conf)}</b></span></div>
          <div class="pop-ev"><span class="k">AIの根拠</span>「${esc(r.evidence || '—')}」</div>
        </div>
        <div class="rv-src"><div class="sec-lab">原本テキスト <span class="muted small">根拠箇所をハイライト</span></div>${evNote}<pre class="src-text" id="rv-src">${srcHtml}</pre></div>
      </div>
      <div class="rv-actions">
        <button class="btn btn-ok btn-lg" data-act="approve">✓ 承認 <span class="kbd">A</span></button>
        <button class="btn btn-outline btn-lg" data-act="edit">✎ 修正して承認 <span class="kbd">E</span></button>
        <button class="btn btn-bad btn-lg" data-act="reject">✕ 却下 <span class="kbd">R</span></button>
        <span class="spacer"></span>
        <button class="btn btn-ghost" data-act="prev">‹ 前 <span class="kbd">K</span></button>
        <button class="btn btn-ghost" data-act="next">次 › <span class="kbd">J</span></button>
      </div>
      <div class="edit-row big" id="rv-edit" hidden><span class="muted">正しい値:</span><input class="input" id="rv-edit-in" value="${esc(r.value ?? '')}"><span class="muted">${esc(r.unit || '')}</span>
        <button class="btn btn-primary" data-act="edit-save">保存して承認 <span class="kbd">Enter</span></button><button class="btn btn-ghost" data-act="edit-cancel">キャンセル <span class="kbd">Esc</span></button></div>`;
    const m = $('#rv-src mark', rv); if (m) m.scrollIntoView({ block: 'center' });
    $$('[data-act]', rv).forEach((b) => b.addEventListener('click', () => handle(b.dataset.act)));
    $('#rv-edit-in', rv).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handle('edit-save'); }
      if (e.key === 'Escape') { e.preventDefault(); handle('edit-cancel'); }
    });
  };

  const paint = () => { paintQueue(); paintCard(); };

  async function act(action, value) {
    if (ctx.busy || !ctx.items.length) return;
    ctx.busy = true;
    const it = ctx.items[ctx.i];
    $$('#rv [data-act]', root).forEach((b) => { b.disabled = true; });
    try {
      const body = { action, comment: '' };
      if (action === 'edit') body.value = value;
      const res = await api.review(it.rec.sku, it.rec.attr_key, body);
      const lab = { approve: '承認', edit: '修正して承認', reject: '却下' }[action];
      toast(`「${it.rec.label}」を${lab}しました`, action === 'reject' ? 'warn' : 'ok');
      ctx.items.splice(ctx.i, 1);
      if (ctx.i >= ctx.items.length) ctx.i = Math.max(0, ctx.items.length - 1);
      setReviewBadge(typeof res.remaining === 'number' ? res.remaining : ctx.items.length);
      state.products = null;
      $('#rv', root).classList.add('swipe');
      setTimeout(() => { $('#rv', root)?.classList.remove('swipe'); }, 250);
      paint();
      refreshShell();
    } catch (e) {
      toast(e.message, 'err');
      $$('#rv [data-act]', root).forEach((b) => { b.disabled = false; });
    } finally { ctx.busy = false; }
  }

  function handle(a) {
    if (!ctx.items.length) return;
    const rv = $('#rv', root);
    if (a === 'approve') act('approve');
    else if (a === 'reject') act('reject');
    else if (a === 'edit') { ctx.editing = true; $('#rv-edit', rv).hidden = false; const inp = $('#rv-edit-in', rv); inp.focus(); inp.select(); }
    else if (a === 'edit-cancel') { ctx.editing = false; $('#rv-edit', rv).hidden = true; }
    else if (a === 'edit-save') act('edit', coerce($('#rv-edit-in', rv).value, ctx.items[ctx.i].rec.value));
    else if (a === 'next') { ctx.i = Math.min(ctx.items.length - 1, ctx.i + 1); paint(); }
    else if (a === 'prev') { ctx.i = Math.max(0, ctx.i - 1); paint(); }
  }

  const onKey = (e) => {
    if (e.target.matches('input, textarea, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.modal-back')) return;
    const k = e.key.toLowerCase();
    const map = { a: 'approve', e: 'edit', r: 'reject', j: 'next', k: 'prev', arrowdown: 'next', arrowup: 'prev' };
    if (map[k]) { e.preventDefault(); handle(map[k]); }
  };
  document.addEventListener('keydown', onKey);
  paint();
  return () => document.removeEventListener('keydown', onKey);
}
