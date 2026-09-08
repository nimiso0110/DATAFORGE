// memory-model.js
// Real, deterministic computation backing the DataForge Pathway-track explainer.
// No animation, no pre-rendered numbers: every function here is called live by app.js
// in response to slider input, and recomputes from scratch.
//
// Two memory mechanisms are modeled at toy scale:
//   1. kvRetrieve   - a Transformer-style key/value cache with sliding-window eviction
//                     (optionally with a pinned "attention sink", cf. Xiao et al. 2023).
//   2. recurrent state - a fixed-size D x D fast-weight matrix updated additively,
//                     S <- S + value * key^T, retrieval = S . query
//                     (the family of mechanism BDH-CQ's paper relates its own
//                     contextual memory to; NOT a reimplementation of BDH/BDH-CQ).
//
// Everything is seeded so a given (seed, D, N) always produces the same facts.

(function (global) {
  'use strict';

  // ---- seeded RNG (mulberry32) ----
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function gaussianPair(rng) {
    // Box-Muller
    let u1 = 0, u2 = 0;
    while (u1 === 0) u1 = rng();
    u2 = rng();
    const mag = Math.sqrt(-2.0 * Math.log(u1));
    return [mag * Math.cos(2 * Math.PI * u2), mag * Math.sin(2 * Math.PI * u2)];
  }

  function randUnitVector(rng, D) {
    const v = new Float64Array(D);
    for (let i = 0; i < D; i += 2) {
      const [a, b] = gaussianPair(rng);
      v[i] = a;
      if (i + 1 < D) v[i + 1] = b;
    }
    let norm = 0;
    for (let i = 0; i < D; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < D; i++) v[i] /= norm;
    return v;
  }

  const BASE_SEED = 20260906; // fixed so every visitor sees a reproducible run

  // Cache of generated facts, keyed by D (facts depend on D because vector length changes).
  const factCache = new Map();

  function getFacts(D, maxN) {
    const key = D;
    let entry = factCache.get(key);
    if (!entry || entry.length < maxN) {
      const rng = mulberry32(BASE_SEED + D * 7919);
      const facts = [];
      for (let i = 0; i < maxN; i++) {
        facts.push({ key: randUnitVector(rng, D), value: randUnitVector(rng, D) });
      }
      factCache.set(key, facts);
      entry = facts;
    }
    return entry;
  }

  function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  function cosine(a, b) {
    const d = dot(a, b);
    let na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { na += a[i] * a[i]; nb += b[i] * b[i]; }
    na = Math.sqrt(na); nb = Math.sqrt(nb);
    if (na === 0 || nb === 0) return 0;
    return d / (na * nb);
  }

  // ---- KV cache retained-index set ----
  function retainedIndices(N, cap, sinkOn) {
    // returns a Set of fact indices [0, N) still present in the cache
    const retained = new Set();
    if (cap >= N) {
      for (let i = 0; i < N; i++) retained.add(i);
      return retained;
    }
    const windowStart = N - cap;
    for (let i = windowStart; i < N; i++) retained.add(i);
    if (sinkOn) retained.add(0);
    return retained;
  }

  // ---- recurrent fast-weight state built from facts[0..N) ----
  function buildRecurrentState(facts, N, D) {
    // S[i][j] as a flat Float64Array, row-major: S += value (outer) key
    const S = new Float64Array(D * D);
    for (let n = 0; n < N; n++) {
      const k = facts[n].key, v = facts[n].value;
      for (let i = 0; i < D; i++) {
        const vi = v[i];
        if (vi === 0) continue;
        const rowOff = i * D;
        for (let j = 0; j < D; j++) S[rowOff + j] += vi * k[j];
      }
    }
    return S;
  }

  function matVec(S, D, q) {
    const out = new Float64Array(D);
    for (let i = 0; i < D; i++) {
      let s = 0;
      const rowOff = i * D;
      for (let j = 0; j < D; j++) s += S[rowOff + j] * q[j];
      out[i] = s;
    }
    return out;
  }

  // Nearest-neighbour decode of an estimate vector against the true value list [0..N)
  function decodeNearest(estimate, facts, N) {
    let bestIdx = -1, bestSim = -Infinity;
    for (let i = 0; i < N; i++) {
      const s = cosine(estimate, facts[i].value);
      if (s > bestSim) { bestSim = s; bestIdx = i; }
    }
    return { idx: bestIdx, sim: bestSim };
  }

  // ---- single-query answers, used by the "truth beside estimate" panel ----
  function queryKV(facts, N, cap, sinkOn, j) {
    const retained = retainedIndices(N, cap, sinkOn);
    if (!retained.has(j)) {
      // key j itself isn't stored -> find nearest surviving key to key_j (a "confabulated" answer)
      let bestIdx = -1, bestSim = -Infinity;
      retained.forEach((i) => {
        const s = cosine(facts[j].key, facts[i].key);
        if (s > bestSim) { bestSim = s; bestIdx = i; }
      });
      return { inCache: false, predictedIdx: bestIdx, sim: bestIdx >= 0 ? cosine(facts[j].value, facts[bestIdx].value) : 0, correct: false };
    }
    // key j is present -> exact retrieval
    return { inCache: true, predictedIdx: j, sim: 1.0, correct: true };
  }

  function queryRecurrent(facts, N, D, j) {
    const S = buildRecurrentState(facts, N, D);
    const q = facts[j].key;
    const estimate = matVec(S, D, q);
    const { idx, sim } = decodeNearest(estimate, facts, N);
    const simToTruth = cosine(estimate, facts[j].value);
    return { predictedIdx: idx, sim: simToTruth, decodeSim: sim, correct: idx === j, estimateVector: estimate };
  }

  // ---- sweeps for the two charts (subsampled for speed; still real computation) ----
  function accuracySweep(D, cap, sinkOn, maxN, pointsWanted) {
    const facts = getFacts(D, maxN);
    const points = Math.min(pointsWanted || 40, maxN);
    const xs = [];
    const kvAcc = [];
    const recAcc = [];
    for (let p = 1; p <= points; p++) {
      const n = Math.max(1, Math.round((p / points) * maxN));
      xs.push(n);
      // sample up to 20 query indices evenly across [0, n)
      const samples = Math.min(20, n);
      let kvCorrect = 0, recCorrect = 0;
      const S = buildRecurrentState(facts, n, D);
      for (let s = 0; s < samples; s++) {
        const j = Math.floor((s / samples) * n);
        const kvRes = queryKV(facts, n, cap, sinkOn, j);
        if (kvRes.correct) kvCorrect++;
        const est = matVec(S, D, facts[j].key);
        const { idx } = decodeNearest(est, facts, n);
        if (idx === j) recCorrect++;
      }
      kvAcc.push(kvCorrect / samples);
      recAcc.push(recCorrect / samples);
    }
    return { xs, kvAcc, recAcc };
  }

  function memorySweep(D, cap, maxN, points) {
    const P = Math.min(points || 60, maxN);
    const xs = [];
    const kvBytes = [];
    const recBytes = [];
    const FLOAT_BYTES = 4; // float32 typical
    const recurrentBytes = D * D * FLOAT_BYTES;
    for (let p = 1; p <= P; p++) {
      const n = Math.max(1, Math.round((p / P) * maxN));
      xs.push(n);
      const stored = Math.min(n, cap);
      kvBytes.push(stored * 2 * D * FLOAT_BYTES);
      recBytes.push(recurrentBytes);
    }
    return { xs, kvBytes, recBytes };
  }

  function vectorToColor(v) {
    // map first 3 dims (or fewer) to an RGB swatch, robust to sign/scale
    const clamp = (x) => Math.max(0, Math.min(255, Math.round(x)));
    const scale = (x) => 128 + x * 100;
    const r = v.length > 0 ? scale(v[0]) : 128;
    const g = v.length > 1 ? scale(v[1]) : 128;
    const b = v.length > 2 ? scale(v[2]) : 128;
    return `rgb(${clamp(r)},${clamp(g)},${clamp(b)})`;
  }

  global.MemoryModel = {
    getFacts,
    retainedIndices,
    buildRecurrentState,
    matVec,
    decodeNearest,
    queryKV,
    queryRecurrent,
    accuracySweep,
    memorySweep,
    vectorToColor,
    cosine,
  };
})(window);
