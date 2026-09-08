// app.js — UI glue. All numbers shown come from MemoryModel (memory-model.js).
(function () {
  'use strict';
  const MM = window.MemoryModel;

  const el = (id) => document.getElementById(id);

  const ctrlD = el('ctrlD'), ctrlN = el('ctrlN'), ctrlCap = el('ctrlCap'),
        ctrlUnlimited = el('ctrlUnlimited'), ctrlSink = el('ctrlSink'), ctrlQ = el('ctrlQ');
  const valD = el('valD'), valN = el('valN'), valCap = el('valCap'), valQ = el('valQ');
  const statusLine = el('statusLine'), captionBox = el('captionBox'), qLabel = el('qLabel');
  const presetButtons = document.querySelectorAll('button.preset');

  const chartMem = el('chartMem'), chartAcc = el('chartAcc');
  const ctxMem = chartMem.getContext('2d'), ctxAcc = chartAcc.getContext('2d');

  const COLORS = { teal: '#1F6F63', copper: '#A85C22', rule: '#C9C2AC', ink: '#1E2233', faint: '#8B8A7E' };

  const MAXN = 200;

  const presets = {
    1: { D: 10, N: 6, cap: 100, unlimited: true, sink: false, q: 0,
      caption: 'With only <b>6 facts</b> and no cache limit, both mechanisms remember every single one perfectly. There\'s nothing to forget yet — this is the calm before the storm.' },
    2: { D: 10, N: 20, cap: 8, unlimited: false, sink: false, q: 0,
      caption: 'Cap the cache at <b>8 slots</b> and push to 20 facts. Fact #0 is long gone from the cache — a hard, all-or-nothing cliff. Try the "keep fact #0 pinned" box to see StreamingLLM\'s attention-sink fix restore it.' },
    3: { D: 10, N: 60, cap: 100, unlimited: true, sink: false, q: 5,
      caption: 'Remove the cache limit again, but keep writing into the same fixed-size recurrent state. Old facts don\'t vanish — they blend together. Query fact #5: the cache still answers exactly, but the recurrent state\'s confidence has dropped and it may name a completely different fact instead — not because #5 was deleted, but because 60 facts are now superposed in the same 10-dimensional state.' },
  };

  let currentPreset = 1;

  function setControlsFromPreset(p) {
    ctrlD.value = p.D;
    ctrlN.value = p.N;
    ctrlCap.max = Math.max(100, p.cap);
    ctrlCap.value = p.cap;
    ctrlUnlimited.checked = p.unlimited;
    ctrlCap.disabled = p.unlimited;
    ctrlSink.checked = p.sink;
    ctrlQ.max = Math.max(0, p.N - 1);
    ctrlQ.value = p.q;
    captionBox.innerHTML = p.caption;
  }

  presetButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      presetButtons.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentPreset = parseInt(btn.dataset.preset, 10);
      setControlsFromPreset(presets[currentPreset]);
      render();
    });
  });

  function readState() {
    const D = parseInt(ctrlD.value, 10);
    const N = parseInt(ctrlN.value, 10);
    const unlimited = ctrlUnlimited.checked;
    const cap = unlimited ? MAXN : parseInt(ctrlCap.value, 10);
    const sink = ctrlSink.checked;
    const q = Math.min(parseInt(ctrlQ.value, 10), N - 1);
    return { D, N, cap, unlimited, sink, q };
  }

  function clearActivePresetHighlight() {
    presetButtons.forEach((b) => b.classList.remove('active'));
  }

  [ctrlD, ctrlN, ctrlCap, ctrlUnlimited, ctrlSink, ctrlQ].forEach((c) => {
    c.addEventListener('input', () => {
      clearActivePresetHighlight();
      ctrlCap.disabled = ctrlUnlimited.checked;
      const N = parseInt(ctrlN.value, 10);
      ctrlQ.max = Math.max(0, N - 1);
      if (parseInt(ctrlQ.value, 10) > N - 1) ctrlQ.value = N - 1;
      captionBox.innerHTML = 'Free play — you changed a variable by hand. Watch Fig. 1 and Fig. 2 respond.';
      render();
    });
  });

  // ---------- drawing helpers ----------
  function setupCanvas(canvas, ctx) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width || 440, h = 180;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  function drawAxes(ctx, w, h, pad) {
    ctx.strokeStyle = COLORS.rule;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t);
    ctx.lineTo(pad.l, h - pad.b);
    ctx.lineTo(w - pad.r, h - pad.b);
    ctx.stroke();
  }

  function drawLine(ctx, xs, ys, xToPx, yToPx, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    xs.forEach((x, i) => {
      const px = xToPx(x), py = yToPx(ys[i]);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  function drawMemChart(state) {
    const { w, h } = setupCanvas(chartMem, ctxMem);
    ctxMem.clearRect(0, 0, w, h);
    const pad = { l: 44, r: 10, t: 10, b: 22 };
    drawAxes(ctxMem, w, h, pad);

    const sweep = MM.memorySweep(state.D, state.cap, MAXN, 60);
    const allBytes = sweep.kvBytes.concat(sweep.recBytes);
    const minB = Math.max(1, Math.min(...allBytes));
    const maxB = Math.max(...allBytes) * 1.15;

    const xToPx = (x) => pad.l + (x / MAXN) * (w - pad.l - pad.r);
    const logMin = Math.log(minB), logMax = Math.log(maxB);
    const yToPx = (y) => {
      const ly = Math.log(Math.max(1, y));
      const t = (ly - logMin) / (logMax - logMin || 1);
      return (h - pad.b) - t * (h - pad.t - pad.b);
    };

    drawLine(ctxMem, sweep.xs, sweep.kvBytes, xToPx, yToPx, COLORS.teal);
    drawLine(ctxMem, sweep.xs, sweep.recBytes, xToPx, yToPx, COLORS.copper);

    // current-N marker
    ctxMem.strokeStyle = COLORS.ink;
    ctxMem.setLineDash([3, 3]);
    ctxMem.beginPath();
    const mx = xToPx(state.N);
    ctxMem.moveTo(mx, pad.t);
    ctxMem.lineTo(mx, h - pad.b);
    ctxMem.stroke();
    ctxMem.setLineDash([]);

    // labels
    ctxMem.fillStyle = COLORS.faint;
    ctxMem.font = '11px ui-monospace, monospace';
    ctxMem.fillText('N=' + MAXN, w - pad.r - 34, h - 6);
    ctxMem.fillText('N=0', pad.l, h - 6);
    ctxMem.save();
    ctxMem.translate(12, h / 2);
    ctxMem.rotate(-Math.PI / 2);
    ctxMem.textAlign = 'center';
    ctxMem.fillText('bytes (log)', 0, 0);
    ctxMem.restore();
  }

  function drawAccChart(state) {
    const { w, h } = setupCanvas(chartAcc, ctxAcc);
    ctxAcc.clearRect(0, 0, w, h);
    const pad = { l: 34, r: 10, t: 10, b: 22 };
    drawAxes(ctxAcc, w, h, pad);

    const sweep = MM.accuracySweep(state.D, state.cap, state.sink, MAXN, 40);
    const xToPx = (x) => pad.l + (x / MAXN) * (w - pad.l - pad.r);
    const yToPx = (y) => (h - pad.b) - y * (h - pad.t - pad.b);

    // 50% reference line
    ctxAcc.strokeStyle = COLORS.rule;
    ctxAcc.setLineDash([2, 3]);
    ctxAcc.beginPath();
    ctxAcc.moveTo(pad.l, yToPx(0.5));
    ctxAcc.lineTo(w - pad.r, yToPx(0.5));
    ctxAcc.stroke();
    ctxAcc.setLineDash([]);

    drawLine(ctxAcc, sweep.xs, sweep.kvAcc, xToPx, yToPx, COLORS.teal);
    drawLine(ctxAcc, sweep.xs, sweep.recAcc, xToPx, yToPx, COLORS.copper);

    ctxAcc.strokeStyle = COLORS.ink;
    ctxAcc.setLineDash([3, 3]);
    ctxAcc.beginPath();
    const mx = xToPx(state.N);
    ctxAcc.moveTo(mx, pad.t);
    ctxAcc.lineTo(mx, h - pad.b);
    ctxAcc.stroke();
    ctxAcc.setLineDash([]);

    ctxAcc.fillStyle = COLORS.faint;
    ctxAcc.font = '11px ui-monospace, monospace';
    ctxAcc.fillText('100%', 4, yToPx(1) + 4);
    ctxAcc.fillText('0%', 4, yToPx(0) + 4);
    ctxAcc.fillText('50%', 4, yToPx(0.5) + 4);
  }

  function renderQueryPanel(state) {
    const j = Math.max(0, Math.min(state.q, state.N - 1));
    qLabel.textContent = '#' + j;
    const facts = MM.getFacts(state.D, MAXN);

    el('swTrue').style.background = MM.vectorToColor(facts[j].value);

    const kv = MM.queryKV(facts, state.N, state.cap, state.sink, j);
    el('swKV').style.background = kv.inCache
      ? MM.vectorToColor(facts[j].value)
      : (kv.predictedIdx >= 0 ? MM.vectorToColor(facts[kv.predictedIdx].value) : '#00000000');
    el('lblKV').textContent = kv.inCache
      ? 'still in cache — exact match'
      : (kv.predictedIdx >= 0 ? `evicted — nearest surviving key is fact #${kv.predictedIdx}` : 'evicted — cache is empty');
    el('simKV').textContent = 'cosine to truth: ' + kv.sim.toFixed(3);
    const vKV = el('verdictKV');
    vKV.textContent = kv.correct ? '\u2713 correct (exact)' : '\u2717 forgotten (hard eviction)';
    vKV.className = 'verdict ' + (kv.correct ? 'ok' : 'bad');

    const rec = MM.queryRecurrent(facts, state.N, state.D, j);
    el('swRec').style.background = MM.vectorToColor(rec.estimateVector);
    el('lblRec').textContent = rec.correct
      ? 'nearest match is the right fact'
      : `nearest match is fact #${rec.predictedIdx} instead — the state confused them`;
    el('simRec').textContent = 'cosine to truth: ' + rec.sim.toFixed(3);
    const vRec = el('verdictRec');
    vRec.textContent = rec.correct ? '\u2713 correct (approximate)' : '\u2717 blended with another fact';
    vRec.className = 'verdict ' + (rec.correct ? 'ok' : 'bad');
  }

  function render() {
    const state = readState();
    valD.textContent = state.D;
    valN.textContent = state.N;
    valCap.textContent = state.unlimited ? '\u221E' : state.cap;
    valQ.textContent = state.q;
    statusLine.textContent = `D = ${state.D} \u00B7 N = ${state.N} \u00B7 cache = ${state.unlimited ? '\u221E' : state.cap}${state.sink ? ' (+sink)' : ''}`;

    drawMemChart(state);
    drawAccChart(state);
    renderQueryPanel(state);
  }

  window.addEventListener('resize', render);
  setControlsFromPreset(presets[1]);
  render();
})();
