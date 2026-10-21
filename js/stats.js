/*
 * Data Analyzer: statistics helpers.
 * Simple linear regression (one X, one Y) plus the Student t distribution
 * for p-values and confidence bands. No libraries needed.
 */
'use strict';

const Stats = (() => {
  // Natural log of the gamma function (Lanczos approximation).
  function logGamma(z) {
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
    z -= 1;
    let x = c[0];
    for (let i = 1; i < 9; i++) x += c[i] / (z + i);
    const t = z + 7.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  // Continued fraction for the incomplete beta function.
  function betacf(a, b, x) {
    const MAXIT = 300, EPS = 3e-16, FPMIN = 1e-300;
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= MAXIT; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
      c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
      d = 1 / d;
      const del = d * c;
      h *= del;
      if (Math.abs(del - 1) < EPS) break;
    }
    return h;
  }

  // Regularized incomplete beta function I_x(a, b).
  function ibeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }

  // Two-sided p-value for a t statistic with df degrees of freedom.
  function tTwoSidedP(t, df) {
    if (Number.isNaN(t) || df <= 0) return NaN;
    if (!Number.isFinite(t)) return 0;
    return ibeta(df / (df + t * t), df / 2, 0.5);
  }

  // Critical t value for a two-sided confidence level (e.g. 0.95).
  function tCritical(confidence, df) {
    const alpha = 1 - confidence;
    if (!(alpha > 0 && alpha < 1) || df <= 0) return NaN;
    let lo = 0, hi = 1;
    while (tTwoSidedP(hi, df) > alpha && hi < 1e7) hi *= 2;
    for (let i = 0; i < 200; i++) {
      const mid = (lo + hi) / 2;
      if (tTwoSidedP(mid, df) > alpha) lo = mid; else hi = mid;
      if (hi - lo < 1e-10) break;
    }
    return (lo + hi) / 2;
  }

  /*
   * Ordinary least squares with one predictor.
   * Uses centered sums (two passes) so big numbers like home values or
   * years don't lose precision.
   */
  function regress(xs, ys) {
    const n = xs.length;
    if (n < 3) return { n, error: 'Need at least 3 rows that have numbers in both columns.' };
    let mx = 0, my = 0;
    for (let i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    let sxx = 0, syy = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      const dx = xs[i] - mx, dy = ys[i] - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    if (!(sxx > 0)) return { n, error: 'Every row has the same X value, so there is no slope to measure.' };
    if (!(syy > 0)) return { n, error: 'Every row has the same Y value, so there is nothing to explain.' };
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    let sse = 0;
    for (let i = 0; i < n; i++) {
      const e = ys[i] - (intercept + slope * xs[i]);
      sse += e * e;
    }
    const df = n - 2;
    const s = Math.sqrt(sse / df);
    const r = Math.max(-1, Math.min(1, sxy / Math.sqrt(sxx * syy)));
    const r2 = Math.max(0, Math.min(1, 1 - sse / syy));
    const seSlope = s / Math.sqrt(sxx);
    const seIntercept = s * Math.sqrt(1 / n + (mx * mx) / sxx);
    let t, p;
    if (seSlope > 0) { t = slope / seSlope; p = tTwoSidedP(t, df); }
    else { t = slope === 0 ? 0 : Math.sign(slope) * Infinity; p = slope === 0 ? 1 : 0; }
    return {
      n, df, mx, my, sxx, syy, sxy, slope, intercept, r, r2, s, sse,
      rmse: Math.sqrt(sse / n), seSlope, seIntercept, t, p,
      predict: (x) => intercept + slope * x,
      // Internally studentized residual: how unusual a point is, in standard errors.
      stdResidual: (x, y) => {
        const e = y - (intercept + slope * x);
        const h = 1 / n + ((x - mx) * (x - mx)) / sxx;
        const denom = s * Math.sqrt(Math.max(1 - h, 1e-12));
        return denom > 0 ? e / denom : 0;
      },
      // Half-width of the confidence band for the average Y at x.
      bandHalfWidth: (x, tCrit) => tCrit * s * Math.sqrt(1 / n + ((x - mx) * (x - mx)) / sxx),
    };
  }

  // Pearson correlation only (cheaper than a full regression), with p-value.
  function correlate(xs, ys) {
    const m = regress(xs, ys);
    if (m.error) return m;
    return { n: m.n, r: m.r, r2: m.r2, slope: m.slope, p: m.p };
  }

  return { regress, correlate, tTwoSidedP, tCritical, ibeta, logGamma };
})();

if (typeof module !== 'undefined') module.exports = Stats;
