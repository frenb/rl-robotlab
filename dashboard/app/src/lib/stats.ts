// Small-sample statistics for comparing eval trials (ported from the classic Analysis tab).

export function mean(a: number[]): number {
  if (!a.length) return NaN;
  let s = 0;
  for (const x of a) s += x;
  return s / a.length;
}

export function variance(a: number[]): number {
  if (a.length < 2) return NaN;
  const m = mean(a);
  let s = 0;
  for (const x of a) s += (x - m) * (x - m);
  return s / (a.length - 1);
}

export function quantile(sortedAsc: number[], q: number): number {
  if (!sortedAsc.length) return NaN;
  const idx = (sortedAsc.length - 1) * q;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? sortedAsc[lo] : sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (idx - lo);
}

function lnGamma(x: number): number {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of cof) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

function betacf(a: number, b: number, x: number): number {
  const MAXIT = 200;
  const EPS = 3e-10;
  const FPMIN = 1e-30;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b). */
function betai(a: number, b: number, x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}

function tCdf(t: number, df: number): number {
  if (!isFinite(t) || df <= 0) return NaN;
  const ib = 0.5 * betai(df / 2, 0.5, df / (df + t * t));
  return t >= 0 ? 1 - ib : ib;
}

function tTwoSidedP(t: number, df: number): number {
  if (!isFinite(t) || df <= 0) return NaN;
  return betai(df / 2, 0.5, df / (df + t * t));
}

/** t* with P(|T| > t*) = alpha. */
export function tCritical(df: number, alpha = 0.05): number {
  const target = 1 - alpha / 2;
  let lo = 0;
  let hi = 30;
  for (let i = 0; i < 100 && hi - lo >= 1e-7; i++) {
    const mid = 0.5 * (lo + hi);
    if (tCdf(mid, df) < target) lo = mid;
    else hi = mid;
  }
  return 0.5 * (lo + hi);
}

export interface Summary {
  n: number;
  mean: number;
  sd: number;
  median: number;
  /** 95% t-interval of the mean. */
  ci: [number, number];
}

export function summarize(xs: number[]): Summary {
  const n = xs.length;
  const m = mean(xs);
  const sd = Math.sqrt(variance(xs));
  const half = n > 1 && isFinite(sd) ? tCritical(n - 1) * (sd / Math.sqrt(n)) : NaN;
  return { n, mean: m, sd, median: quantile([...xs].sort((a, b) => a - b), 0.5), ci: [m - half, m + half] };
}

export interface Versus {
  diff: number;
  /** Welch's t-test, two-sided. */
  p: number;
  /** Hedges' g (pooled-SD effect size with small-sample correction). */
  g: number | null;
}

/** a against baseline b; null when either side has fewer than two trials. */
export function versus(a: number[], b: number[]): Versus | null {
  const na = a.length;
  const nb = b.length;
  if (na < 2 || nb < 2) return null;
  const ma = mean(a);
  const mb = mean(b);
  const va = variance(a);
  const vb = variance(b);
  const se2 = va / na + vb / nb;
  const df = (se2 * se2) / ((va * va) / (na * na * (na - 1)) + (vb * vb) / (nb * nb * (nb - 1)));
  const p = se2 > 0 ? tTwoSidedP((ma - mb) / Math.sqrt(se2), df) : ma === mb ? 1 : 0;
  const sp = Math.sqrt(((na - 1) * va + (nb - 1) * vb) / (na + nb - 2));
  const g = isFinite(sp) && sp > 0 ? ((ma - mb) / sp) * (1 - 3 / (4 * (na + nb) - 9)) : null;
  return { diff: ma - mb, p, g };
}
