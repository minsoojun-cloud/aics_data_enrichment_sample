// ⑤ バッチ & コスト
import { api, goldenCsvUrl, isMock } from '../api.js?v=3';
import { esc, $, $$, fmtInt, fmtPct, fmtJpy, fmtDate, fmtValue, skeleton, emptyState, errorState, toast, openModal, state, tip, refreshShell } from '../ui.js?v=3';

const JOB_STATE = {
  JOB_STATE_SUCCEEDED: ['SUCCEEDED', 'ok', '完了'],
  JOB_STATE_RUNNING: ['RUNNING', 'run', '実行中'],
  JOB_STATE_PENDING: ['PENDING', 'pend', '待機中'],
  JOB_STATE_QUEUED: ['QUEUED', 'pend', '待機中'],
  JOB_STATE_FAILED: ['FAILED', 'bad', '失敗'],
  JOB_STATE_CANCELLED: ['CANCELLED', 'mute', '取消'],
  JOB_STATE_EXPIRED: ['EXPIRED', 'mute', '期限切れ'],
};
const MIN = 100, MAX = 1000000;
const toSkus = (pos) => { const v = Math.pow(10, Math.log10(MIN) + (Math.log10(MAX) - Math.log10(MIN)) * pos / 1000); return roundNice(v); };
const toPos = (n) => Math.round((Math.log10(n) - Math.log10(MIN)) / (Math.log10(MAX) - Math.log10(MIN)) * 1000);
function roundNice(v) { const p = Math.pow(10, Math.max(0, Math.floor(Math.log10(v)) - 1)); return Math.round(v / p) * p; }
let simSkus = 200000;

export async function render(root, _params, stale) {
  root.innerHTML = `
    <div class="page-head"><div><h1>バッチ &amp; コスト</h1><p class="sub">全商品を一括処理する Batch Prediction の状況と、全量展開時の費用試算</p></div>
      <div class="head-actions"><button class="btn btn-outline" id="b-refresh">↻ 状態を更新</button><button class="btn btn-primary" id="b-new">＋ 新規バッチ投入</button></div></div>
    <div class="grid-batch">
      <div class="panel"><div class="panel-head"><h2>Batch ジョブ ${tip('?', 'Vertex AI Batch Prediction: 大量の商品をまとめて処理する方式。オンライン実行の半額で処理できます')}</h2><span class="muted small" id="b-upd"></span></div>
        <div id="b-jobs">${skeleton(3, 'skel-row')}</div></div>
      <div class="panel sim"><div class="panel-head"><h2>コストシミュレーター</h2><span class="chip chip-info">Batch = オンラインの50%オフ</span></div>
        <div class="sim-body">
          <div class="sim-in">
            <div class="sim-skus"><input class="input sim-num" id="sim-num" type="text" inputmode="numeric" value="${fmtInt(simSkus)}"><span>SKU</span></div>
            <input type="range" min="0" max="1000" step="1" id="sim-range" value="${toPos(simSkus)}" aria-label="SKU数">
            <div class="sim-scale"><span>100</span><span>1,000</span><span>1万</span><span>10万</span><span>100万</span></div>
            <div class="sim-presets"><button class="fchip" data-n="10000">1万</button><button class="fchip" data-n="200000">20万</button><button class="fchip" data-n="1000000">100万</button></div>
          </div>
          <div class="sim-out" id="sim-out">${skeleton(2, 'skel-row')}</div>
        </div>
      </div>
    </div>
    <div class="panel"><div class="panel-head"><h2>ゴールデンレコード ${tip('?', '承認済みの属性・タグ・検索キーワード・要約をまとめた、そのまま商品マスタや検索に使えるデータ')}</h2>
      <div class="head-actions">${goldenCsvUrl ? `<a class="btn btn-primary btn-sm" href="${goldenCsvUrl}" download>⬇ CSV エクスポート</a>` : '<button class="btn btn-primary btn-sm" disabled title="モックでは無効">⬇ CSV エクスポート</button>'}</div></div>
      <div id="golden">${skeleton(3, 'skel-row')}</div></div>`;

  // Jobs
  const paintJobs = (jobs) => {
    $('#b-upd', root).textContent = '最終更新 ' + fmtDate(new Date().toISOString());
    const box = $('#b-jobs', root);
    if (!jobs.length) { box.innerHTML = emptyState('🗂️', 'バッチジョブはまだありません', '「新規バッチ投入」から実行できます'); return; }
    box.innerHTML = `<table class="table"><thead><tr><th>ジョブ</th><th>状態</th><th class="r">SKU</th><th class="r">トークン(入/出)</th><th class="r">コスト</th><th>作成</th></tr></thead><tbody>
      ${jobs.map((j) => {
        const st = JOB_STATE[j.state] || [String(j.state || '').replace('JOB_STATE_', '') || '—', 'mute', ''];
        return `<tr><td><div class="job-name">${esc(j.display_name || '—')}</div><div class="muted small mono" title="${esc(j.job_id)}">${esc(String(j.job_id || '').split('/').pop())} ・ ${esc(j.model || '')}</div></td>
          <td><span class="jstate js-${st[1]}">${st[1] === 'run' ? '<span class="spin"></span>' : ''}${esc(st[0])}</span><div class="muted small">${esc(st[2])}${j.ingested ? ' ・ 取込済' : ''}</div></td>
          <td class="r"><b>${fmtInt(j.sku_count)}</b></td>
          <td class="r mono small">${fmtInt(j.input_tokens)} / ${fmtInt(j.output_tokens)}</td>
          <td class="r"><b>${j.cost_jpy ? fmtJpy(j.cost_jpy, 2) : '—'}</b>${j.cost_jpy && j.sku_count ? `<div class="muted small">${fmtJpy(j.cost_jpy / j.sku_count, 3)}/SKU</div>` : ''}</td>
          <td class="small">${fmtDate(j.created_at)}</td></tr>`;
      }).join('')}</tbody></table>`;
  };
  const loadJobs = async (refresh = false) => {
    const btn = $('#b-refresh', root);
    if (refresh) { btn.disabled = true; btn.classList.add('loading'); }
    try {
      const d = refresh ? await api.batchRefresh() : await api.batchJobs();
      if (stale()) return;
      paintJobs(d.jobs || []);
      if (refresh) { toast('ジョブ状態を更新しました', 'ok'); refreshShell(); loadGolden(); }
    } catch (e) {
      if (stale()) return;
      if (refresh) toast('更新に失敗しました: ' + e.message, 'err');
      else $('#b-jobs', root).innerHTML = errorState(e);
    } finally { if (btn) { btn.disabled = false; btn.classList.remove('loading'); } }
  };
  $('#b-refresh', root).onclick = () => loadJobs(true);
  $('#b-new', root).onclick = () => {
    const groups = (state.config && state.config.groups) || {};
    openModal('新規バッチ投入', `
      <p class="muted">Vertex AI Batch Prediction にジョブを投入します。完了まで数分〜数十分かかります。</p>
      <label class="field"><span>カテゴリ</span><select class="select" id="nb-group"><option value="">すべて</option>${Object.entries(groups).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}</select></label>
      <label class="field"><span>件数上限 (SKU)</span><input class="input" id="nb-limit" type="number" min="1" max="100000" value="10"></label>
      <div class="field-note" id="nb-est"></div>`, {
      okLabel: '投入する',
      onOk: async (m) => {
        const limit = parseInt($('#nb-limit', m).value, 10);
        if (!(limit > 0)) { toast('件数を正しく入力してください', 'warn'); return false; }
        const group = $('#nb-group', m).value || null;
        const res = await api.batchSubmit({ group, limit });
        toast(`バッチを投入しました: ${res.job ? res.job.display_name : ''}`, 'ok');
        loadJobs(false);
        return true;
      },
    });
    const est = async () => {
      const n = parseInt($('#nb-limit').value, 10) || 0;
      if (n <= 0) return;
      try { const e = await api.costEstimate(n); const el = $('#nb-est'); if (el) el.innerHTML = `推定費用: <b>${fmtJpy(e.total_jpy_measured, 2)}</b>(実測単価 ${fmtJpy(e.per_sku_jpy_measured, 3)}/SKU)`; } catch (_) { /* ignore */ }
    };
    $('#nb-limit').addEventListener('input', est); est();
  };

  // Simulator
  let simSeq = 0;
  const paintSim = async (n) => {
    simSkus = n;
    const my = ++simSeq;
    $('#sim-num', root).value = fmtInt(n);
    $('#sim-range', root).value = toPos(n);
    $$('.sim-presets .fchip', root).forEach((b) => b.classList.toggle('on', +b.dataset.n === n));
    let e;
    try { e = await api.costEstimate(n); } catch (err) {
      if (my === simSeq && !stale()) $('#sim-out', root).innerHTML = errorState(err);
      return;
    }
    if (my !== simSeq || stale()) return;
    const mx = Math.max(e.total_jpy_measured || 0, e.total_jpy_slide || 0, 1e-9);
    const online = (e.total_jpy_measured || 0) * 2;
    $('#sim-out', root).innerHTML = `
      <div class="sim-big">
        <div class="sb-card main"><div class="muted">実測ベース(Batch)</div><div class="num">${fmtJpy(e.total_jpy_measured)}</div><div class="muted small">${fmtJpy(e.per_sku_jpy_measured, 3)} / SKU</div></div>
        <div class="sb-card"><div class="muted">提案書の試算</div><div class="num sub">${fmtJpy(e.total_jpy_slide)}</div><div class="muted small">${fmtJpy(e.per_sku_jpy_slide, 3)} / SKU</div></div>
      </div>
      <div class="sim-bars">
        <div class="sbar"><span class="lab">実測</span><div class="trk"><div class="fill m" style="width:${(e.total_jpy_measured / mx) * 100}%"></div></div></div>
        <div class="sbar"><span class="lab">試算</span><div class="trk"><div class="fill s" style="width:${(e.total_jpy_slide / mx) * 100}%"></div></div></div>
      </div>
      <div class="sim-notes">
        <div>📦 ${fmtInt(n)} SKU を処理 ・ 平均 入力 ${fmtInt(e.avg_input_tokens)} / 出力 ${fmtInt(e.avg_output_tokens)} tokens/SKU</div>
        <div>💡 Batch Prediction はオンラインの <b>50%オフ</b>(同条件のオンライン実行なら 約 ${fmtJpy(online)})</div>
        <div class="muted small">算定基準: ${esc(e.basis || '')} ・ 20万件 ≈ ${fmtJpy(200000 * (e.per_sku_jpy_measured || 0))}(提案書 ≈ ${fmtJpy(200000 * (e.per_sku_jpy_slide || 0.061))})</div>
      </div>`;
  };
  let simT;
  $('#sim-range', root).addEventListener('input', (e) => {
    const n = toSkus(+e.target.value);
    $('#sim-num', root).value = fmtInt(n);
    clearTimeout(simT); simT = setTimeout(() => paintSim(n), 120);
  });
  $('#sim-num', root).addEventListener('change', (e) => {
    const n = Math.max(1, Math.min(10000000, parseInt(String(e.target.value).replace(/[^\d]/g, ''), 10) || MIN));
    paintSim(n);
  });
  $$('.sim-presets .fchip', root).forEach((b) => b.addEventListener('click', () => paintSim(+b.dataset.n)));

  // Golden
  const loadGolden = async () => {
    const box = $('#golden', root);
    let d;
    try { d = await api.golden({}); } catch (e) { if (!stale()) box.innerHTML = errorState(e); return; }
    if (stale()) return;
    const items = d.items || [];
    if (!items.length) { box.innerHTML = emptyState('⭐', 'ゴールデンレコードはまだありません', 'エンリッチ・承認が完了した商品がここに並びます'); return; }
    const groups = (state.config && state.config.groups) || {};
    const show = items.slice(0, 8);
    box.innerHTML = `<div class="muted small gold-cnt">${fmtInt(items.length)} SKU${items.length > show.length ? `(先頭 ${show.length} 件を表示)` : ''}</div>
      <table class="table gold"><thead><tr><th>商品</th><th>主要属性</th><th>機能タグ</th><th class="r">充足率</th><th>更新</th></tr></thead><tbody>
      ${show.map((g) => {
        const attrs = Object.entries(g.attributes || {}).slice(0, 5);
        const more = Object.keys(g.attributes || {}).length - attrs.length;
        return `<tr><td><a href="#/studio/${encodeURIComponent(g.sku)}" class="gold-title">${esc(g.title)}</a><div class="muted small">${esc(groups[g.group] || g.group)} ・ ${esc(g.sku)}</div></td>
          <td><div class="kv">${attrs.map(([k, v]) => `<span class="kvp" title="${esc(k)}">${esc(label(k))} <b>${esc(fmtValue(v && v.value))}${esc(v && v.unit || '')}</b></span>`).join('')}${more > 0 ? `<span class="kvp more">+${more}</span>` : ''}</div></td>
          <td><div class="tags">${(g.feature_tags || []).slice(0, 4).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></td>
          <td class="r nowrap"><span class="muted">${fmtPct(g.fill_rate_before)}</span> ➜ <b class="after-text">${fmtPct(g.fill_rate_after)}</b></td>
          <td class="small nowrap">${fmtDate(g.updated_at)}</td></tr>`;
      }).join('')}</tbody></table>`;
  };

  await Promise.all([loadJobs(false), paintSim(simSkus), loadGolden()]);
  void isMock;
  return () => clearTimeout(simT);
}

const LABELS = { width_mm: '幅', height_mm: '高さ', depth_mm: '奥行', weight_kg: '重量', total_capacity_l: '容量', freezer_capacity_l: '冷凍', fridge_capacity_l: '冷蔵', vegetable_capacity_l: '野菜', power_consumption_w: '消費電力', annual_power_kwh: '年間電力', annual_cost_jpy: '電気代', energy_rating: '省エネ', power_supply_v: '電圧', door_count: 'ドア', door_type: 'ドア', blade_count: '羽根', battery_hours: '連続', charging_hours: '充電', airflow_levels: '風量', noise_db: '運転音', cooling_capacity_kw: '冷房', heating_capacity_kw: '暖房', apf: 'APF', is_cordless: 'コードレス', motor_type: 'モーター', household_size: '世帯', cooling_tatami_min: '畳(下)', cooling_tatami_max: '畳(上)' };
const label = (k) => LABELS[k] || k;
