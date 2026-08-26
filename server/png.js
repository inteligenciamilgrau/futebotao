// Encoder PNG mínimo + superfície de desenho, sem dependência nenhuma.
// Usa apenas zlib do próprio Node. Serve para gerar o "frame" que a IA enxerga.

import zlib from 'node:zlib';

/* ---------- CRC32 ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/* ---------- Fonte 3x5 (só o necessário para rótulos e placar) ---------- */
// Cada glifo: 5 linhas, 3 bits por linha (bit 2 = coluna esquerda).
const FONT = {
  '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [7, 1, 7, 4, 7], '3': [7, 1, 7, 1, 7],
  '4': [5, 5, 7, 1, 1], '5': [7, 4, 7, 1, 7], '6': [7, 4, 7, 5, 7], '7': [7, 1, 1, 1, 1],
  '8': [7, 5, 7, 5, 7], '9': [7, 5, 7, 1, 7],
  'A': [7, 5, 7, 5, 5], 'B': [6, 5, 6, 5, 6], 'C': [7, 4, 4, 4, 7], 'D': [6, 5, 5, 5, 6],
  'E': [7, 4, 7, 4, 7], 'F': [7, 4, 7, 4, 4], 'G': [7, 4, 5, 5, 7], 'H': [5, 5, 7, 5, 5],
  'I': [7, 2, 2, 2, 7], 'L': [4, 4, 4, 4, 7], 'M': [5, 7, 7, 5, 5], 'N': [5, 7, 7, 7, 5],
  'O': [7, 5, 5, 5, 7], 'P': [7, 5, 7, 4, 4], 'R': [7, 5, 6, 5, 5], 'S': [7, 4, 7, 1, 7],
  'T': [7, 2, 2, 2, 2], 'U': [5, 5, 5, 5, 7], 'V': [5, 5, 5, 5, 2], 'X': [5, 5, 2, 5, 5],
  'Y': [5, 5, 2, 2, 2], 'Z': [7, 1, 2, 4, 7],
  '-': [0, 0, 7, 0, 0], ':': [0, 2, 0, 2, 0], '.': [0, 0, 0, 0, 2], ' ': [0, 0, 0, 0, 0],
  '+': [0, 2, 7, 2, 0], '/': [1, 1, 2, 4, 4], '>': [4, 2, 1, 2, 4], '<': [1, 2, 4, 2, 1],
  '(': [1, 2, 2, 2, 1], ')': [4, 2, 2, 2, 4], '!': [2, 2, 2, 0, 2], '?': [7, 1, 3, 0, 2],
  '=': [0, 7, 0, 7, 0], '#': [5, 7, 5, 7, 5], '*': [5, 2, 7, 2, 5], ',': [0, 0, 0, 2, 4],
};

export const TEXT_W = (s, scale) => s.length * 4 * scale - scale;   // 3px + 1 de espaço
export const TEXT_H = (scale) => 5 * scale;

/* ---------- Superfície ---------- */
export class Surface {
  constructor(width, height, bg = [0, 0, 0]) {
    this.w = width;
    this.h = height;
    this.data = Buffer.alloc(width * height * 3);
    this.fill(bg);
  }

  fill([r, g, b]) {
    for (let i = 0; i < this.data.length; i += 3) {
      this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b;
    }
  }

  px(x, y, [r, g, b], alpha = 1) {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 3;
    if (alpha >= 1) { this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; return; }
    if (alpha <= 0) return;
    const inv = 1 - alpha;
    this.data[i] = this.data[i] * inv + r * alpha;
    this.data[i + 1] = this.data[i + 1] * inv + g * alpha;
    this.data[i + 2] = this.data[i + 2] * inv + b * alpha;
  }

  rect(x, y, w, h, color, alpha = 1) {
    const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.w, Math.round(x + w)), y1 = Math.min(this.h, Math.round(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.px(xx, yy, color, alpha);
  }

  strokeRect(x, y, w, h, color, t = 1) {
    this.rect(x, y, w, t, color);
    this.rect(x, y + h - t, w, t, color);
    this.rect(x, y, t, h, color);
    this.rect(x + w - t, y, t, h, color);
  }

  /** Disco com borda anti-serrilhada. */
  circle(cx, cy, r, fillColor, edgeColor = null, edgeW = 0) {
    const R = r + edgeW + 1;
    const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(this.w - 1, Math.ceil(cx + R));
    const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(this.h - 1, Math.ceil(cy + R));
    const rIn = r - (edgeW > 0 ? edgeW : 0);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (edgeColor && edgeW > 0) {
          if (d <= rIn - 0.5) this.px(x, y, fillColor);
          else if (d <= rIn + 0.5) this.px(x, y, fillColor, rIn + 0.5 - d);
          if (d > rIn - 0.5 && d <= r - 0.5) this.px(x, y, edgeColor);
          else if (d > r - 0.5 && d <= r + 0.5) this.px(x, y, edgeColor, r + 0.5 - d);
        } else {
          if (d <= r - 0.5) this.px(x, y, fillColor);
          else if (d <= r + 0.5) this.px(x, y, fillColor, r + 0.5 - d);
        }
      }
    }
  }

  /** Retângulo girado. Usado para o goleiro caixa. */
  rotRect(cx, cy, w, h, ang, fill, edge = null, edgeW = 1.5) {
    const cos = Math.cos(-ang), sin = Math.sin(-ang);
    const raio = Math.hypot(w, h) / 2 + edgeW + 1;
    const x0 = Math.max(0, Math.floor(cx - raio)), x1 = Math.min(this.w - 1, Math.ceil(cx + raio));
    const y0 = Math.max(0, Math.floor(cy - raio)), y1 = Math.min(this.h - 1, Math.ceil(cy + raio));
    const hw = w / 2, hh = h / 2;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const lx = dx * cos - dy * sin;
        const ly = dx * sin + dy * cos;
        const alx = Math.abs(lx), aly = Math.abs(ly);
        if (alx <= hw && aly <= hh) {
          const naBorda = edge && (alx > hw - edgeW || aly > hh - edgeW);
          this.px(x, y, naBorda ? edge : fill);
        } else if (edge && alx <= hw + edgeW && aly <= hh + edgeW) {
          this.px(x, y, edge, 0.6);
        }
      }
    }
  }

  ring(cx, cy, r, color, t = 1) {
    const x0 = Math.max(0, Math.floor(cx - r - t)), x1 = Math.min(this.w - 1, Math.ceil(cx + r + t));
    const y0 = Math.max(0, Math.floor(cy - r - t)), y1 = Math.min(this.h - 1, Math.ceil(cy + r + t));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const d = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r);
      if (d <= t / 2) this.px(x, y, color);
      else if (d <= t / 2 + 0.6) this.px(x, y, color, (t / 2 + 0.6 - d) / 0.6);
    }
  }

  line(x0, y0, x1, y1, color, t = 1, alpha = 1) {
    const dx = x1 - x0, dy = y1 - y0;
    const n = Math.max(2, Math.ceil(Math.hypot(dx, dy) * 2));
    const half = t / 2;
    for (let i = 0; i <= n; i++) {
      const x = x0 + (dx * i) / n, y = y0 + (dy * i) / n;
      if (t <= 1) { this.px(x, y, color, alpha); continue; }
      for (let oy = -half; oy <= half; oy += 0.5)
        for (let ox = -half; ox <= half; ox += 0.5) this.px(x + ox, y + oy, color, alpha);
    }
  }

  /** Seta com ponta (usada para direção de ataque e último chute). */
  arrow(x0, y0, x1, y1, color, t = 2) {
    this.line(x0, y0, x1, y1, color, t);
    const a = Math.atan2(y1 - y0, x1 - x0);
    const head = 6 + t * 2;
    for (const s of [-1, 1]) {
      const ax = x1 - head * Math.cos(a - (s * Math.PI) / 7);
      const ay = y1 - head * Math.sin(a - (s * Math.PI) / 7);
      this.line(x1, y1, ax, ay, color, t);
    }
  }

  text(str, x, y, scale, color, alpha = 1) {
    let cx = Math.round(x);
    for (const ch of String(str).toUpperCase()) {
      const g = FONT[ch] || FONT['?'];
      for (let row = 0; row < 5; row++) {
        const bits = g[row];
        for (let col = 0; col < 3; col++) {
          if (bits & (1 << (2 - col)))
            this.rect(cx + col * scale, y + row * scale, scale, scale, color, alpha);
        }
      }
      cx += 4 * scale;
    }
  }

  textCenter(str, cx, cy, scale, color, alpha = 1) {
    this.text(str, cx - TEXT_W(String(str), scale) / 2, cy - TEXT_H(scale) / 2, scale, color, alpha);
  }

  toPNG() {
    const raw = Buffer.alloc(this.h * (this.w * 3 + 1));
    for (let y = 0; y < this.h; y++) {
      const off = y * (this.w * 3 + 1);
      raw[off] = 0;                                   // filtro None
      this.data.copy(raw, off + 1, y * this.w * 3, (y + 1) * this.w * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.w, 0);
    ihdr.writeUInt32BE(this.h, 4);
    ihdr[8] = 8;    // bit depth
    ihdr[9] = 2;    // color type: truecolor RGB
    ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}
