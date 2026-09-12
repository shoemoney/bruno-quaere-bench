import { deflateSync } from 'node:zlib';
import { canonical } from '../canon.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_LONG_SIDE = 256;

function fmt(n) {
  if (Object.is(n, -0)) return '0';
  return String(n);
}

function hexColor(c) {
  const s = String(c);
  return (s.startsWith('#') ? s : `#${s}`).toLowerCase();
}

function hexToRgb(hex) {
  const s = String(hex).replace('#', '');
  const full = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// list order, or by Shape.z ascending when present, stable tiebreak on list index
function zOrdered(shapes) {
  const hasZ = shapes.some((s) => typeof s.z === 'number');
  if (!hasZ) return shapes.slice();
  return shapes
    .map((s, i) => ({ s, i }))
    .sort((a, b) => {
      const za = typeof a.s.z === 'number' ? a.s.z : a.i;
      const zb = typeof b.s.z === 'number' ? b.s.z : b.i;
      if (za !== zb) return za - zb;
      return a.i - b.i;
    })
    .map((x) => x.s);
}

function shapeToSvg(shape) {
  const color = hexColor(shape.color);
  const op = fmt(shape.opacity);
  switch (shape.type) {
    case 'rect':
      return `<rect x="${fmt(shape.x)}" y="${fmt(shape.y)}" width="${fmt(shape.w)}" height="${fmt(shape.h)}" fill="${color}" opacity="${op}"/>`;
    case 'circle':
      return `<circle cx="${fmt(shape.x)}" cy="${fmt(shape.y)}" r="${fmt(shape.r)}" fill="${color}" opacity="${op}"/>`;
    case 'line':
      return `<line x1="${fmt(shape.x)}" y1="${fmt(shape.y)}" x2="${fmt(shape.x2)}" y2="${fmt(shape.y2)}" stroke="${color}" stroke-width="1" opacity="${op}"/>`;
    default:
      throw new Error(`toSvg: unknown shape type '${shape.type}'`);
  }
}

export function toSvg(desc) {
  const { width, height, background, shapes } = desc;
  let bg = '';
  if (background && background.transparent) {
    bg = '';
  } else if (background && background.color) {
    bg = `<rect x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" fill="${hexColor(background.color)}"/>`;
  }
  const body = zOrdered(shapes || []).map(shapeToSvg).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}">${bg}${body}</svg>`;
}

// -- PNG: hand-rolled CRC32, IHDR/IDAT/IEND, tEXt chunk with true dimensions --

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function ihdrChunk(w, h) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(w, 0);
  data.writeUInt32BE(h, 4);
  data[8] = 8; // bit depth
  data[9] = 6; // color type: RGBA
  data[10] = 0; // compression method
  data[11] = 0; // filter method
  data[12] = 0; // interlace method
  return chunk('IHDR', data);
}

function textChunk(keyword, text) {
  const data = Buffer.concat([Buffer.from(keyword, 'latin1'), Buffer.from([0]), Buffer.from(text, 'latin1')]);
  return chunk('tEXt', data);
}

function idatChunk(rgba, w, h) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return chunk('IDAT', deflateSync(raw, { level: 9 }));
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function clampInt(v, lo, hi) {
  return clamp(Math.trunc(v), lo, hi);
}

function computeScale(w, h) {
  const long = Math.max(w, h);
  return long > MAX_LONG_SIDE ? MAX_LONG_SIDE / long : 1;
}

function rasterDims(w, h, scale) {
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

// source-over alpha compositing, straight (non-premultiplied) alpha
function blend(buf, idx, rgb, srcA) {
  if (srcA <= 0) return;
  const dstA = buf[idx + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) {
    buf[idx] = 0;
    buf[idx + 1] = 0;
    buf[idx + 2] = 0;
    buf[idx + 3] = 0;
    return;
  }
  for (let c = 0; c < 3; c++) {
    const outC = (rgb[c] * srcA + buf[idx + c] * dstA * (1 - srcA)) / outA;
    buf[idx + c] = Math.round(clamp(outC, 0, 255));
  }
  buf[idx + 3] = Math.round(clamp(outA * 255, 0, 255));
}

function rectContains(shape, ox, oy) {
  return ox >= shape.x && ox < shape.x + shape.w && oy >= shape.y && oy < shape.y + shape.h;
}

function circleContains(shape, ox, oy) {
  const dx = ox - shape.x;
  const dy = oy - shape.y;
  return dx * dx + dy * dy <= shape.r * shape.r;
}

function bresenham(x0, y0, x1, y1) {
  const pts = [];
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
  return pts;
}

function paintShape(buf, rw, rh, scale, shape) {
  const rgb = hexToRgb(shape.color);
  const srcA = shape.opacity;
  if (shape.type === 'rect') {
    const xs0 = clampInt(Math.floor(shape.x * scale), 0, rw);
    const xs1 = clampInt(Math.ceil((shape.x + shape.w) * scale), 0, rw);
    const ys0 = clampInt(Math.floor(shape.y * scale), 0, rh);
    const ys1 = clampInt(Math.ceil((shape.y + shape.h) * scale), 0, rh);
    for (let py = ys0; py < ys1; py++) {
      for (let px = xs0; px < xs1; px++) {
        const ox = (px + 0.5) / scale;
        const oy = (py + 0.5) / scale;
        if (rectContains(shape, ox, oy)) blend(buf, (py * rw + px) * 4, rgb, srcA);
      }
    }
  } else if (shape.type === 'circle') {
    const xs0 = clampInt(Math.floor((shape.x - shape.r) * scale), 0, rw);
    const xs1 = clampInt(Math.ceil((shape.x + shape.r) * scale), 0, rw);
    const ys0 = clampInt(Math.floor((shape.y - shape.r) * scale), 0, rh);
    const ys1 = clampInt(Math.ceil((shape.y + shape.r) * scale), 0, rh);
    for (let py = ys0; py < ys1; py++) {
      for (let px = xs0; px < xs1; px++) {
        const ox = (px + 0.5) / scale;
        const oy = (py + 0.5) / scale;
        if (circleContains(shape, ox, oy)) blend(buf, (py * rw + px) * 4, rgb, srcA);
      }
    }
  } else if (shape.type === 'line') {
    const pts = bresenham(
      Math.round(shape.x * scale),
      Math.round(shape.y * scale),
      Math.round(shape.x2 * scale),
      Math.round(shape.y2 * scale),
    );
    for (const [px, py] of pts) {
      if (px >= 0 && px < rw && py >= 0 && py < rh) blend(buf, (py * rw + px) * 4, rgb, srcA);
    }
  } else {
    throw new Error(`toPng: unknown shape type '${shape.type}'`);
  }
}

export function toPng(desc) {
  const { width, height, background, shapes } = desc;
  const scale = computeScale(width, height);
  const [rw, rh] = rasterDims(width, height, scale);
  const buf = Buffer.alloc(rw * rh * 4); // starts transparent (alpha 0)

  if (background && !background.transparent && background.color) {
    const [r, g, b] = hexToRgb(background.color);
    for (let i = 0; i < rw * rh; i++) {
      buf[i * 4] = r;
      buf[i * 4 + 1] = g;
      buf[i * 4 + 2] = b;
      buf[i * 4 + 3] = 255;
    }
  }

  for (const shape of zOrdered(shapes || [])) {
    paintShape(buf, rw, rh, scale, shape);
  }

  const dimsText = canonical({ width, height }); // true (pre-raster) dimensions
  const bytes = Buffer.concat([
    PNG_SIGNATURE,
    ihdrChunk(rw, rh),
    textChunk('quaere', dimsText),
    idatChunk(buf, rw, rh),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  return new Uint8Array(bytes);
}

export function renderImage(desc) {
  if (desc.format === 'svg') return toSvg(desc);
  if (desc.format === 'png') return toPng(desc);
  throw new Error(`renderImage: unknown format '${desc.format}'`);
}
