import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { toSvg, toPng, renderImage } from '../src/render/image.js';

function sha256(bytesOrString) {
  return createHash('sha256').update(bytesOrString).digest('hex');
}

// -- four fixed descriptors, pinned by hash --

const descA = {
  kind: 'image', format: 'svg',
  width: 20, height: 10,
  background: { color: '#112233' },
  shapes: [
    { type: 'rect', x: 1, y: 1, w: 5, h: 4, color: '#ff0000', opacity: 1 },
    { type: 'circle', x: 12, y: 5, r: 3, color: '#00ff00', opacity: 0.5 },
  ],
};

const descB = {
  kind: 'image', format: 'png',
  width: 16, height: 16,
  background: { transparent: true },
  shapes: [
    { type: 'circle', x: 8, y: 8, r: 6, color: '#3366cc', opacity: 0.8 },
    { type: 'line', x: 0, y: 0, x2: 15, y2: 15, color: '#000000', opacity: 1 },
  ],
};

const descC = {
  kind: 'image', format: 'png',
  width: 300, height: 100,
  background: { color: '#ffffff' },
  shapes: [
    { type: 'rect', x: 0, y: 0, w: 300, h: 100, color: '#ff0000', opacity: 0.6, z: 1 },
    { type: 'rect', x: 50, y: 20, w: 100, h: 60, color: '#0000ff', opacity: 0.6, z: 0 },
  ],
};

const descD = {
  kind: 'image', format: 'svg',
  width: 8, height: 8,
  background: { transparent: true },
  shapes: [
    { type: 'line', x: 0, y: 0, x2: 7, y2: 7, color: '#abcdef', opacity: 0.3 },
  ],
};

const PINNED = {
  A: '71fa73b8260e620086a9bb22d110af0af5680a0f981735ce1aa650cf17751efc',
  B: '3542bb8998bda8d64aaf182324719b0d2b6de4ffa6ab1a29761a78ca849f8387',
  C: 'fc784bce16d3c5c956005fbf856a318135088ba1ac7267eaa73c1803fa17e68e',
  D: 'da2e84795348056045d81831f043f77a51221e38b59155c4f74119a3b990fb9c',
};

test('renderImage: pinned sha256 hashes for fixed descriptors', () => {
  assert.equal(sha256(renderImage(descA)), PINNED.A);
  assert.equal(sha256(renderImage(descB)), PINNED.B);
  assert.equal(sha256(renderImage(descC)), PINNED.C);
  assert.equal(sha256(renderImage(descD)), PINNED.D);
});

test('renderImage: dispatches on desc.format', () => {
  assert.equal(renderImage(descA), toSvg(descA));
  assert.deepEqual(renderImage(descC), toPng(descC));
  assert.throws(() => renderImage({ ...descA, format: 'bogus' }));
});

test('determinism: repeated calls produce identical bytes', () => {
  const svg1 = toSvg(descA);
  const svg2 = toSvg(descA);
  const svg3 = toSvg(descA);
  assert.equal(svg1, svg2);
  assert.equal(svg2, svg3);

  const png1 = toPng(descC);
  const png2 = toPng(descC);
  const png3 = toPng(descC);
  assert.equal(sha256(png1), sha256(png2));
  assert.equal(sha256(png2), sha256(png3));
});

test('toSvg: fixed attribute order, background rect, opacity attribute', () => {
  const svg = toSvg(descA);
  assert.equal(
    svg,
    '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10" viewBox="0 0 20 10">' +
      '<rect x="0" y="0" width="20" height="10" fill="#112233"/>' +
      '<rect x="1" y="1" width="5" height="4" fill="#ff0000" opacity="1"/>' +
      '<circle cx="12" cy="5" r="3" fill="#00ff00" opacity="0.5"/>' +
      '</svg>',
  );
});

test('toSvg: no background rect when transparent', () => {
  const svg = toSvg(descD);
  assert.ok(!svg.includes('<rect x="0" y="0" width="8" height="8"'));
  assert.match(svg, /^<svg[^>]*><line /);
});

test('toSvg: shapes painted by Shape.z ascending, stable tiebreak on list index', () => {
  const base = {
    kind: 'image', format: 'svg', width: 10, height: 10,
    background: { transparent: true },
    shapes: [
      { type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#111111', opacity: 1, z: 2 },
      { type: 'rect', x: 1, y: 1, w: 1, h: 1, color: '#222222', opacity: 1, z: 0 },
      { type: 'rect', x: 2, y: 2, w: 1, h: 1, color: '#333333', opacity: 1, z: 1 },
    ],
  };
  const svg = toSvg(base);
  const order = ['#222222', '#333333', '#111111'];
  const positions = order.map((c) => svg.indexOf(c));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
});

test('toSvg: without any Shape.z, paints in list order', () => {
  const base = {
    kind: 'image', format: 'svg', width: 10, height: 10,
    background: { transparent: true },
    shapes: [
      { type: 'rect', x: 0, y: 0, w: 1, h: 1, color: '#aaaaaa', opacity: 1 },
      { type: 'rect', x: 1, y: 1, w: 1, h: 1, color: '#bbbbbb', opacity: 1 },
    ],
  };
  const svg = toSvg(base);
  assert.ok(svg.indexOf('#aaaaaa') < svg.indexOf('#bbbbbb'));
});

test('PNG: chunk structure and CRC validity', () => {
  const bytes = Buffer.from(toPng(descC));
  assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

  const chunks = [];
  let off = 8;
  while (off < bytes.length) {
    const len = bytes.readUInt32BE(off);
    const type = bytes.subarray(off + 4, off + 8).toString('ascii');
    const data = bytes.subarray(off + 8, off + 8 + len);
    const crcStored = bytes.readUInt32BE(off + 8 + len);
    const crcExpected = zlib.crc32(Buffer.concat([Buffer.from(type, 'ascii'), data]));
    assert.equal(crcStored, crcExpected, `CRC mismatch for chunk ${type}`);
    chunks.push({ type, data });
    off += 12 + len;
  }
  assert.equal(off, bytes.length, 'chunks must exactly cover the file');

  const types = chunks.map((c) => c.type);
  assert.equal(types[0], 'IHDR');
  assert.equal(types.at(-1), 'IEND');
  assert.ok(types.includes('IDAT'));
  assert.ok(types.includes('tEXt'));

  const ihdr = chunks[0].data;
  assert.equal(ihdr.length, 13);
  const rw = ihdr.readUInt32BE(0);
  const rh = ihdr.readUInt32BE(4);
  assert.equal(ihdr[8], 8, 'bit depth 8');
  assert.equal(ihdr[9], 6, 'color type RGBA');
  assert.ok(Math.max(rw, rh) <= 256, 'long side scaled to <= 256px');

  const textC = chunks.find((c) => c.type === 'tEXt');
  const nul = textC.data.indexOf(0);
  const keyword = textC.data.subarray(0, nul).toString('latin1');
  const text = textC.data.subarray(nul + 1).toString('latin1');
  assert.equal(keyword, 'quaere');
  assert.deepEqual(JSON.parse(text), { width: 300, height: 100 });
});

test('PNG: long side is capped at 256px for a large descriptor', () => {
  const big = { ...descC, width: 3000, height: 1000 };
  const bytes = Buffer.from(toPng(big));
  const ihdrOff = bytes.indexOf(Buffer.from('IHDR', 'ascii')) + 4;
  const w = bytes.readUInt32BE(ihdrOff);
  const h = bytes.readUInt32BE(ihdrOff + 4);
  assert.equal(Math.max(w, h), 256);
  assert.equal(w, 256);
  assert.equal(h, Math.round(1000 * (256 / 3000)));
});

test('PNG: transparent background is alpha 0 where no shape paints', () => {
  const bytes = Buffer.from(toPng(descD.width === 8 ? { ...descD, format: 'png' } : descD));
  // corner far from the diagonal line should stay fully transparent
  const idatChunk = (() => {
    let off = 8;
    while (off < bytes.length) {
      const len = bytes.readUInt32BE(off);
      const type = bytes.subarray(off + 4, off + 8).toString('ascii');
      if (type === 'IDAT') return bytes.subarray(off + 8, off + 8 + len);
      off += 12 + len;
    }
    throw new Error('no IDAT');
  })();
  const raw = zlib.inflateSync(idatChunk);
  const stride = 8 * 4 + 1;
  const row0 = raw.subarray(0, stride);
  // pixel (7,0) is the far corner from the (0,0)-(7,7) diagonal line
  const px7 = row0.subarray(1 + 7 * 4, 1 + 7 * 4 + 4);
  assert.equal(px7[3], 0, 'untouched pixel stays alpha 0 on a transparent background');
});

test('z-order affects encoded bytes', () => {
  const reordered = {
    ...descC,
    shapes: [descC.shapes[1], descC.shapes[0]],
  };
  // same z values regardless of list order -> identical composite
  assert.equal(sha256(renderImage(descC)), sha256(renderImage(reordered)));

  const noZ = {
    ...descC,
    shapes: descC.shapes.map(({ z, ...rest }) => rest),
  };
  const noZReordered = {
    ...noZ,
    shapes: [...noZ.shapes].reverse(),
  };
  assert.notEqual(sha256(renderImage(noZ)), sha256(renderImage(noZReordered)));
});

test('opacity affects encoded bytes', () => {
  const changed = {
    ...descC,
    shapes: descC.shapes.map((s, i) => (i === 0 ? { ...s, opacity: 0.9 } : s)),
  };
  assert.notEqual(sha256(renderImage(descC)), sha256(renderImage(changed)));
  assert.notEqual(toSvg(descA), toSvg({
    ...descA,
    shapes: descA.shapes.map((s, i) => (i === 1 ? { ...s, opacity: 0.9 } : s)),
  }));
});
