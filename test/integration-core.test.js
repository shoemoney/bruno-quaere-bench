// Cross-module integration for the [core] workstream: seed -> world -> media.create
// -> render -> hash. Each module has its own unit test file; this one only asserts
// that they compose, and that the whole chain is a pure function of the seed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeWorld } from '../src/world.js';
import { hashArtifact, canonical } from '../src/canon.js';
import { create, convert, fidelity } from '../src/media.js';
import { toSvg, toPng, renderImage } from '../src/render/image.js';

const SEEDS = [1, 2, 3, 4, 5];

// 4 x 3 inches. Every world converts that through its own dpi and rounding rule,
// so the descriptor differs per seed while the request text stays identical.
const UNIT_PARAMS = {
  width: 4,
  height: 3,
  unit: 'in',
  background: { color: '#101820' },
  shapes: [
    { type: 'rect', x: 10, y: 12, w: 40, h: 24, color: '#ff8800', opacity: 0.5, z: 0 },
    { type: 'circle', x: 64, y: 48, r: 20, color: '#2266cc', opacity: 1, z: 1 },
    { type: 'line', x: 0, y: 0, x2: 90, y2: 70, color: '#ffffff', opacity: 0.8, z: 2 },
  ],
};

function imageFor(world, format) {
  return create(world, 'image', { ...UNIT_PARAMS, format });
}

// One seed -> the bytes and hashes the judge would compare.
function renderChain(seed) {
  const world = makeWorld(seed);
  const svgDesc = imageFor(world, 'svg');
  const pngDesc = imageFor(world, 'png');
  const svg = toSvg(svgDesc);
  const png = toPng(pngDesc);
  return {
    world,
    svgDesc,
    pngDesc,
    svg,
    png,
    svgHash: hashArtifact(svg),
    pngHash: hashArtifact(png),
  };
}

test('the seed -> world -> create -> render chain runs end to end for seeds 1..5', () => {
  for (const seed of SEEDS) {
    const { world, svgDesc, pngDesc, svg, png, svgHash, pngHash } = renderChain(seed);

    // world applied its own dpi and rounding rule to the inch measurements
    const rawWidthPx = UNIT_PARAMS.width * world.rules.dpi;
    assert.ok(svgDesc.width > 0 && svgDesc.height > 0, `seed ${seed}: non-positive canvas`);
    assert.equal(svgDesc.width % world.rules.roundTo, 0, `seed ${seed}: width off the rounding grid`);
    assert.equal(svgDesc.height % world.rules.roundTo, 0, `seed ${seed}: height off the rounding grid`);
    assert.ok(
      Math.abs(svgDesc.width - rawWidthPx) < world.rules.roundTo,
      `seed ${seed}: width ${svgDesc.width} is not the rounded form of ${rawWidthPx}`,
    );

    // zOrder is a world rule, so create decides whether z survives onto the shape
    const keepsZ = world.rules.zOrder === 'explicit';
    for (const shape of svgDesc.shapes) {
      assert.equal('z' in shape, keepsZ, `seed ${seed}: z presence must follow rules.zOrder`);
    }

    // the two descriptors differ only in format
    assert.deepEqual({ ...svgDesc, format: null }, { ...pngDesc, format: null });

    assert.ok(svg.startsWith('<svg '), `seed ${seed}: not an svg document`);
    assert.ok(svg.includes(`width="${svgDesc.width}"`), `seed ${seed}: svg lost the true width`);
    assert.equal(svg.split('<rect').length - 1, 2, `seed ${seed}: expected background rect + shape rect`);
    assert.equal(svg.split('<circle').length - 1, 1);
    assert.equal(svg.split('<line').length - 1, 1);

    assert.ok(png instanceof Uint8Array, `seed ${seed}: png must be bytes`);
    assert.deepEqual(
      [...png.slice(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
      `seed ${seed}: bad PNG signature`,
    );
    // the raster is capped at 256px on the long side, but the true dimensions ride
    // along in the tEXt chunk as canonical JSON
    const text = Buffer.from(png).toString('latin1');
    assert.ok(
      text.includes(`quaere\u0000${canonical({ width: pngDesc.width, height: pngDesc.height })}`),
      `seed ${seed}: png tEXt chunk missing the true dimensions`,
    );

    assert.match(svgHash, /^[0-9a-f]{64}$/);
    assert.match(pngHash, /^[0-9a-f]{64}$/);
    assert.notEqual(svgHash, pngHash);

    // renderImage dispatches to the same bytes the direct renderers produce
    assert.equal(renderImage(svgDesc), svg);
    assert.deepEqual(renderImage(pngDesc), png);
  }
});

test('two fresh makeWorld calls for the same seed produce identical artifact hashes', () => {
  for (const seed of SEEDS) {
    const a = renderChain(seed);
    const b = renderChain(seed);
    assert.equal(canonical(a.world), canonical(b.world), `seed ${seed}: world is not deterministic`);
    assert.equal(canonical(a.svgDesc), canonical(b.svgDesc), `seed ${seed}: descriptor is not deterministic`);
    assert.equal(a.svgHash, b.svgHash, `seed ${seed}: svg hash is not deterministic`);
    assert.equal(a.pngHash, b.pngHash, `seed ${seed}: png hash is not deterministic`);
    assert.equal(fidelity(a.svgDesc, b.svgDesc), 1, `seed ${seed}: fidelity of a descriptor against itself must be 1`);
  }
});

test('different seeds separate the artifacts they should separate', () => {
  const chains = SEEDS.map(renderChain);
  const distinctCanvases = new Set(chains.map((c) => `${c.svgDesc.width}x${c.svgDesc.height}`));
  assert.ok(distinctCanvases.size > 1, 'seeds 1..5 should not all land on the same canvas');

  // same canvas -> same bytes; different canvas -> different bytes. Either way the
  // hash is a function of the descriptor alone, never of which world produced it.
  for (const a of chains) {
    for (const b of chains) {
      const sameCanvas = a.svgDesc.width === b.svgDesc.width
        && a.svgDesc.height === b.svgDesc.height
        && canonical(a.svgDesc) === canonical(b.svgDesc);
      assert.equal(
        a.svgHash === b.svgHash,
        sameCanvas,
        `seeds ${a.world.seed}/${b.world.seed}: hash equality must track descriptor equality`,
      );
    }
  }
});

test('convert round-trips through the same render path for every seed', () => {
  for (const seed of SEEDS) {
    const world = makeWorld(seed);
    const svgDesc = imageFor(world, 'svg');
    const asPng = convert(world, svgDesc, { format: 'png' });
    assert.equal(asPng.format, 'png');
    assert.equal(asPng.width, svgDesc.width);
    assert.equal(asPng.height, svgDesc.height);
    assert.equal(hashArtifact(renderImage(asPng)), hashArtifact(toPng(imageFor(world, 'png'))));

    const backToSvg = convert(world, asPng, { format: 'svg' });
    assert.equal(canonical(backToSvg), canonical(svgDesc), `seed ${seed}: format round-trip lost data`);
  }
});
