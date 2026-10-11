// ② 商品一覧
import { api } from '../api.js?v=3';
import { esc, fmtInt, chip, fillBars, skeleton, emptyState, errorState, state } from '../ui.js?v=3';

const filters = { group: '', status: '', q: '' };
const STATUS_OPTS = [['', 'すべて'], ['completed', '🟢 完了'], ['needs_review', '🟡 要レビュー'], ['not_processed', '⚪ 未処理']];

export async function render(root, _params, stale) {
  const groups = (state.config && state.config.groups) || {};
  root.innerHTML = `
    <div class="page-head"><div><h1>商品一覧</h1><p class="sub">商品を選ぶと、原本とエンリッチ後を並べて確認できます</p></div>
      <div class="search"><span class="search-ic">🔍</span><input id="p-q" type="search" placeholder="商品名・ブランド・SKU で検索" value="${esc(filters.q)}"></div></div>
    <div class="filters">
      <div class="chip-group"><span class="fg-lab">カテゴリ</span>
        ${[['', 'すべて'], ...Object.entries(groups)].map(([k, v]) => `<button class="fchip ${filters.group === k ? 'on' : ''}" data-f="group" data-v="${esc(k)}">${esc(v)}</button>`).join('')}
      </div>
      <div class="chip-group"><span class="fg-lab">状態</span>
        ${STATUS_OPTS.map(([k, v]) => `<button class="fchip ${filters.status === k ? 'on' : ''}" data-f="status" data-v="${esc(k)}">${esc(v)}</button>`).join('')}
      </div>
      <div class="p-count" id="p-count"></div>
    </div>
    <div class="pgrid" id="pgrid">${skeleton(8, 'skel-card')}</div>`;

  let seq = 0;
  const load = async () => {
    const my = ++seq;
    const grid = root.querySelector('#pgrid');
    grid.innerHTML = skeleton(8, 'skel-card');
    let d;
    try { d = await api.products({ group: filters.group, status: filters.status, q: filters.q }); } catch (e) {
      if (stale() || my !== seq) return;
      grid.innerHTML = errorState(e, 'p-retry');
      grid.querySelector('#p-retry').onclick = load;
      return;
    }
    if (stale() || my !== seq) return;
    const items = d.items || [];
    if (!filters.group && !filters.status && !filters.q) state.products = items;
    root.querySelector('#p-count').innerHTML = `<b>${fmtInt(d.total ?? items.length)}</b> 件`;
    if (!items.length) { grid.innerHTML = emptyState('📦', '該当する商品がありません', '絞り込み条件を変更してください'); return; }
    grid.innerHTML = items.map(card).join('');
  };

  root.querySelectorAll('.fchip').forEach((b) => b.addEventListener('click', () => {
    filters[b.dataset.f] = b.dataset.v;
    root.querySelectorAll(`.fchip[data-f="${b.dataset.f}"]`).forEach((x) => x.classList.toggle('on', x === b));
    load();
  }));
  let t;
  root.querySelector('#p-q').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { filters.q = e.target.value.trim(); load(); }, 300);
  });
  await load();
  return () => clearTimeout(t);
}

function card(p) {
  const tags = (p.tags || []).slice(0, 4);
  const more = (p.tags || []).length - tags.length;
  return `<a class="pcard" href="#/studio/${encodeURIComponent(p.sku)}">
    <div class="pcard-img"><img loading="lazy" src="${esc(p.image_url)}" alt="" onerror="this.style.visibility='hidden'"><span class="pcard-status">${chip(p.status)}</span>${p.image_count > 0 ? `<span class="pcard-imgcnt" title="保存済みの画像（生成画像を含む）">🖼 ${fmtInt(p.image_count)}</span>` : ''}</div>
    <div class="pcard-body">
      <div class="pcard-meta"><span class="cat-pill">${esc(p.group_label)}</span><span class="muted">${esc(p.brand)}</span></div>
      <div class="pcard-title" title="${esc(p.title)}">${esc(p.title)}</div>
      <div class="pcard-price">${p.price ? '¥' + fmtInt(p.price) : ''}<span class="muted small"> SKU ${esc(p.sku)}</span></div>
      ${fillBars(p.fill_before, p.fill_after)}
      <div class="pcard-counts">
        <span class="cnt ok" title="自動承認">🟢 ${fmtInt(p.auto_approved)}</span>
        <span class="cnt warn" title="要レビュー">🟡 ${fmtInt(p.needs_review)}</span>
        <span class="cnt bad" title="棄却">🔴 ${fmtInt(p.rejected)}</span>
        <span class="muted small">/ ${fmtInt(p.attr_count)} 属性</span>
      </div>
      <div class="tags">${tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}${more > 0 ? `<span class="tag tag-more">+${more}</span>` : ''}</div>
    </div>
  </a>`;
}
