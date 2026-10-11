// ① ダッシュボード
import { api } from '../api.js?v=3';
import { esc, fmtInt, fmtPct, fmtJpy, tip, skeleton, errorState, state, setReviewBadge, stepper } from '../ui.js?v=3';

export async function render(root, _params, stale) {
  root.innerHTML = `
    <div class="page-head"><div><h1>ダッシュボード</h1><p class="sub">Gemini による商品属性エンリッチメントの成果を一目で確認できます</p></div>
    <button class="btn btn-outline" id="dash-reload">↻ 最新に更新</button></div>
    <div class="kpis">${skeleton(4, 'skel-kpi')}</div>
    <div class="grid-2">${skeleton(2, 'skel-panel')}</div>`;
  const load = async () => {
    let d;
    try { d = await api.dashboard(); } catch (e) {
      if (stale()) return;
      root.querySelector('.kpis').outerHTML = errorState(e, 'dash-retry');
      const r = root.querySelector('#dash-retry'); if (r) r.onclick = () => render(root, _params, stale);
      return;
    }
    if (stale()) return;
    state.dashboard = d;
    setReviewBadge(d.totals.needs_review);
    if (!stepper.live) stepper.setGlobal(d.funnel);
    paint(root, d);
  };
  root.querySelector('#dash-reload').onclick = load;
  await load();
}

function paint(root, d) {
  const fr = d.fill_rate || {};
  const delta = (fr.after || 0) - (fr.before || 0);
  const cost = d.cost || {};
  const costDiff = cost.slide_per_sku_jpy && cost.per_sku_jpy != null ? (cost.per_sku_jpy - cost.slide_per_sku_jpy) / cost.slide_per_sku_jpy : null;
  const t = d.totals || {};
  const f = d.funnel || {};
  const thr = (state.config && state.config.threshold) || 0.9;

  const kpis = `
  <div class="kpis">
    <div class="kpi kpi-hero">
      <div class="kpi-label">${tip('属性充足率', '商品ごとに必要な属性(幅・重量・容量など)のうち、値が入っている割合')}</div>
      <div class="kpi-ba">
        <span class="kpi-before">${t.processed ? fmtPct(fr.before) : '—'}</span>
        <span class="kpi-arrow">➜</span>
        <span class="kpi-after">${t.processed ? fmtPct(fr.after) : '—'}</span>
      </div>
      <div class="kpi-foot">${t.processed ? `<span class="delta up">▲ ${(delta * 100).toFixed(0)} pt 改善</span>` : '<span>エンリッチ後に表示</span>'}<span class="muted">${fmtInt(t.processed)} / ${fmtInt(t.skus)} SKU 処理済</span></div>
    </div>
    <div class="kpi">
      <div class="kpi-label">${tip('自動承認率', `AI スコアが ${thr.toFixed(2)} 以上で、人の確認なしにそのまま採用できた属性の割合`)}</div>
      <div class="kpi-big">${fmtPct(d.auto_approve_rate)}</div>
      <div class="donut-row">${donut(d.auto_approve_rate)}<div class="kpi-foot col"><span><b>${fmtInt(t.auto_approved)}</b> 件 自動承認</span><span class="muted">全 ${fmtInt(t.attributes)} 属性 + ${fmtInt(t.tags)} タグ</span></div></div>
    </div>
    <a class="kpi kpi-link" href="#/reviews">
      <div class="kpi-label">${tip('レビュー待ち', 'AI が自信を持てなかった項目。人(HITL)が確認して承認・修正・却下します')}</div>
      <div class="kpi-big warn-text">${fmtInt(t.needs_review)}<span class="kpi-unit">件</span></div>
      <div class="kpi-foot"><span class="muted">人手で承認 ${fmtInt(t.human_approved)} / 却下 ${fmtInt(t.human_rejected)}</span><span class="go">レビューする →</span></div>
    </a>
    <div class="kpi">
      <div class="kpi-label">${tip('1SKUあたりコスト', 'Batch Prediction(オンライン料金の50%オフ)で実測したトークン量から算出')}</div>
      <div class="kpi-big">${cost.per_sku_jpy != null ? fmtJpy(cost.per_sku_jpy, 3) : '<span class="muted">未計測</span>'}</div>
      <div class="kpi-foot col"><span class="nowrap">提案書 <b>${fmtJpy(cost.slide_per_sku_jpy, 3)}</b>${costDiff !== null ? ` 比 <span class="delta ${costDiff <= 0 ? 'up' : 'down'}">${costDiff <= 0 ? '▼' : '▲'} ${Math.abs(costDiff * 100).toFixed(0)}%</span>` : ''}</span>
      <span class="muted">${cost.skus_measured ? `実測 ${fmtInt(cost.skus_measured)} SKU・合計 ${fmtJpy(cost.total_jpy)}(${esc(cost.basis === 'batch' ? 'Batch' : cost.basis || '')})` : 'バッチ完了後に実測値を表示'}</span></div>
    </div>
  </div>`;
  const banner = !t.processed ? `<div class="banner">🚀 <div><b>まだエンリッチ結果がありません。</b> エンリッチ・スタジオで「▶ Geminiでライブ実行」を押すか、バッチ & コスト画面から一括処理を投入してください。</div><a class="btn btn-primary btn-sm" href="#/studio">スタジオを開く</a></div>` : '';

  // Funnel
  const fmax = Math.max(f.extracted || 0, 1);
  const frow = (label, n, cls, sub = '') => `<div class="fn-row"><div class="fn-lab">${label}</div><div class="fn-track">${n ? `<div class="fn-bar ${cls}" style="width:${Math.max(2, (n / fmax) * 100)}%"><span>${fmtInt(n)}</span></div>` : '<div class="fn-zero">0</div>'}</div><div class="fn-sub">${sub}</div></div>`;
  const funnel = `
  <div class="panel">
    <div class="panel-head"><h2>判定ファネル</h2><span class="muted">${fmtInt(f.source_skus)} SKU から抽出した属性の行方</span></div>
    <div class="funnel">
      ${frow('② 抽出属性', f.extracted, 'fn-blue', '')}
      ${frow('③ 正規化 OK', f.normalized, 'fn-blue2', fmtPct(f.normalized / fmax))}
      ${frow('④ 第1関門 通過', f.gate1_passed, 'fn-blue3', fmtPct(f.gate1_passed / fmax))}
      <div class="fn-split">
        <div class="fn-split-lab">第2関門 判定結果</div>
        <div class="fn-stack">
          ${(f.auto_approved || f.needs_review || f.rejected) ? seg(f.auto_approved, 'ok', '自動承認') + seg(f.needs_review, 'warn', '要レビュー') + seg(f.rejected, 'bad', '棄却') : '<div class="fn-seg seg-empty">まだ判定データがありません</div>'}
        </div>
        <div class="fn-legend">
          <span><i class="lg ok"></i>🟢 自動承認 <b>${fmtInt(f.auto_approved)}</b></span>
          <a href="#/reviews"><i class="lg warn"></i>🟡 要レビュー <b>${fmtInt(f.needs_review)}</b></a>
          <span><i class="lg bad"></i>🔴 棄却 <b>${fmtInt(f.rejected)}</b></span>
        </div>
      </div>
      <div class="fn-golden">⑤ ゴールデンレコード <b>${fmtInt(f.golden_skus)}</b> SKU <span class="muted">(${fmtPct((f.golden_skus || 0) / Math.max(f.source_skus || 1, 1))})</span></div>
    </div>
  </div>`;

  function seg(n, cls, lab) {
    const tot = (f.auto_approved || 0) + (f.needs_review || 0) + (f.rejected || 0) || 1;
    const w = (n || 0) / tot * 100;
    if (!n) return '';
    return `<div class="fn-seg seg-${cls}" style="flex:${Math.max(w, 0.8)}" title="${esc(lab)} ${fmtInt(n)}">${w > 7 ? fmtInt(n) : ''}</div>`;
  }

  // By group
  const groups = (d.by_group || []).map((g) => `
    <div class="bg-row">
      <div class="bg-name"><b>${esc(g.label)}</b><span class="muted">${fmtInt(g.processed)}/${fmtInt(g.skus)} SKU</span></div>
      <div class="bg-bars">
        <div class="bg-bar"><div class="bg-fill before" style="width:${(g.fill_before || 0) * 100}%"></div><span>${fmtPct(g.fill_before)}</span></div>
        <div class="bg-bar"><div class="bg-fill after" style="width:${(g.fill_after || 0) * 100}%"></div><span class="strong">${fmtPct(g.fill_after)}</span></div>
      </div>
      <div class="bg-meta">${g.processed ? `<span class="delta up">+${(((g.fill_after || 0) - (g.fill_before || 0)) * 100).toFixed(0)}pt</span>` : '<span class="muted">未処理</span>'}<span class="muted">自動承認 ${fmtPct(g.auto_rate)} ・ タグ ${Number(g.avg_tags_after || 0).toFixed(1)}/SKU</span></div>
    </div>`).join('');
  const byGroup = `
  <div class="panel">
    <div class="panel-head"><h2>カテゴリ別 属性充足率</h2><span class="legend"><i class="lg before"></i>Before(原本) <i class="lg after"></i>After(エンリッチ後)</span></div>
    <div class="bygroup">${groups || '<div class="muted">データなし</div>'}</div>
  </div>`;

  const gates = `
  <div class="panel gates-panel">
    <div class="panel-head"><h2>3段階ゲート <span class="muted small">— AI に任せきりにしない品質管理</span></h2></div>
    <div class="gates">
      <div class="gate-card g1"><div class="gate-no">第1関門</div><div class="gate-title">ルール検査</div><div class="gate-desc">物理的にありえない値(例: 冷蔵庫の重さ 3,000kg)や単位の矛盾を自動で棄却</div><div class="gate-stat">棄却 <b>${fmtInt(f.rejected)}</b></div></div>
      <div class="gate-arrow">➜</div>
      <div class="gate-card g2"><div class="gate-no">第2関門</div><div class="gate-title">AI スコア ≥ ${thr.toFixed(2)}</div><div class="gate-desc">根拠の一致・AI の自己確信度・トークン確率を合成したスコアで自動承認</div><div class="gate-stat">自動承認 <b>${fmtInt(f.auto_approved)}</b></div></div>
      <div class="gate-arrow">➜</div>
      <a class="gate-card g3" href="#/reviews"><div class="gate-no">第3関門</div><div class="gate-title">人による確認 (HITL)</div><div class="gate-desc">スコアが基準未満・根拠が原本にない項目だけを担当者が確認</div><div class="gate-stat">レビュー待ち <b>${fmtInt(f.needs_review)}</b></div></a>
    </div>
  </div>`;

  root.innerHTML = root.querySelector('.page-head').outerHTML + banner + kpis + `<div class="grid-2">${funnel}${byGroup}</div>` + gates;
  root.querySelector('#dash-reload').onclick = () => render(root, [], () => false);
  requestAnimationFrame(() => root.classList.add('ready'));
}

function donut(r) {
  const v = Math.max(0, Math.min(1, r || 0));
  const C = 2 * Math.PI * 22;
  return `<svg class="donut" viewBox="0 0 56 56"><circle cx="28" cy="28" r="22" class="d-bg"/><circle cx="28" cy="28" r="22" class="d-fg" stroke-dasharray="${(C * v).toFixed(1)} ${C.toFixed(1)}" transform="rotate(-90 28 28)"/></svg>`;
}
