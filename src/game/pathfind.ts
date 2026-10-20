// A* sobre la rejilla de casillas (8 vecinos, sin cortar esquinas).

export class PathGrid {
  /** 1 = transitable */
  readonly open: Uint8Array;
  private g: Float32Array;
  private parent: Int32Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private gen = 1;
  private heap: Int32Array;
  private f: Float32Array;

  constructor(readonly w: number, readonly h: number) {
    const n = w * h;
    this.open = new Uint8Array(n);
    this.g = new Float32Array(n);
    this.f = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heap = new Int32Array(n * 4);
  }

  passable(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.open[y * this.w + x] === 1;
  }

  /** Casilla transitable más cercana (búsqueda en anillos). */
  nearestOpen(x: number, y: number, maxR = 12): [number, number] | null {
    if (this.passable(x, y)) return [x, y];
    for (let r = 1; r <= maxR; r++) {
      let best: [number, number] | null = null;
      let bd = 1e9;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          if (this.passable(x + dx, y + dy)) {
            const d = dx * dx + dy * dy;
            if (d < bd) {
              bd = d;
              best = [x + dx, y + dy];
            }
          }
        }
      if (best) return best;
    }
    return null;
  }

  /** Devuelve la lista de casillas desde (sx,sy) (excluida) hasta (tx,ty), o el mejor intento. */
  find(sx: number, sy: number, tx: number, ty: number, maxNodes = 6000): [number, number][] {
    const w = this.w;
    const t = this.nearestOpen(tx, ty);
    if (!t) return [];
    [tx, ty] = t;
    if (sx === tx && sy === ty) return [];
    const gen = ++this.gen;
    const start = sy * w + sx;
    const goal = ty * w + tx;
    const H = (i: number) => {
      const dx = Math.abs((i % w) - tx);
      const dy = Math.abs(((i / w) | 0) - ty);
      return Math.max(dx, dy) + 0.414 * Math.min(dx, dy);
    };
    let hn = 0;
    const heap = this.heap;
    const f = this.f;
    const push = (i: number) => {
      let k = hn++;
      heap[k] = i;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if (f[heap[p]] <= f[heap[k]]) break;
        [heap[p], heap[k]] = [heap[k], heap[p]];
        k = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      heap[0] = heap[--hn];
      let k = 0;
      for (;;) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < hn && f[heap[l]] < f[heap[m]]) m = l;
        if (r < hn && f[heap[r]] < f[heap[m]]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k], heap[m]];
        k = m;
      }
      return top;
    };
    this.stamp[start] = gen;
    this.g[start] = 0;
    this.parent[start] = -1;
    f[start] = H(start);
    push(start);
    let best = start;
    let bestH = H(start);
    let expanded = 0;
    while (hn > 0 && expanded < maxNodes) {
      const cur = pop();
      if (this.closed[cur] === gen) continue;
      this.closed[cur] = gen;
      expanded++;
      if (cur === goal) {
        best = cur;
        break;
      }
      const h = H(cur);
      if (h < bestH) {
        bestH = h;
        best = cur;
      }
      const cx = cur % w, cy = (cur / w) | 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;
          if (!this.passable(nx, ny)) continue;
          if (dx && dy && (!this.passable(cx + dx, cy) || !this.passable(cx, cy + dy))) continue;
          const n = ny * w + nx;
          if (this.closed[n] === gen) continue;
          const ng = this.g[cur] + (dx && dy ? 1.414 : 1);
          if (this.stamp[n] !== gen || ng < this.g[n]) {
            this.stamp[n] = gen;
            this.g[n] = ng;
            this.parent[n] = cur;
            f[n] = ng + H(n);
            push(n);
          }
        }
    }
    const out: [number, number][] = [];
    for (let i = best; i !== start && i >= 0; i = this.parent[i]) out.push([i % w, (i / w) | 0]);
    out.reverse();
    return this.smooth(sx, sy, out);
  }

  /** Elimina puntos intermedios cuando hay línea de visión transitable. */
  private smooth(sx: number, sy: number, path: [number, number][]): [number, number][] {
    if (path.length < 3) return path;
    const out: [number, number][] = [];
    let ax = sx, ay = sy;
    let i = 0;
    while (i < path.length) {
      let j = path.length - 1;
      while (j > i && !this.lineOpen(ax, ay, path[j][0], path[j][1])) j--;
      out.push(path[j]);
      [ax, ay] = path[j];
      i = j + 1;
    }
    return out;
  }

  lineOpen(x0: number, y0: number, x1: number, y1: number): boolean {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2;
    for (let k = 1; k <= n; k++) {
      const t = k / n;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      // comprobar las casillas que toca un punto con algo de holgura
      for (const [ox, oy] of [[-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
        if (!this.passable(Math.floor(x + 0.5 + ox), Math.floor(y + 0.5 + oy))) return false;
      }
    }
    return true;
  }
}
