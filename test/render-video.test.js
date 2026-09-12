import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { toQvid, renderVideo } from '../src/render/video.js';

function sha256Hex(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

// Minimal independent parser mirroring the QVID container contract, used only to
// verify what render/video.js produced.
function parseQvid(bytes) {
  const buf = Buffer.from(bytes);
  const magic = [...buf.subarray(0, 8)];
  const headerLen = buf.readUInt32LE(8);
  const headerBytes = buf.subarray(12, 12 + headerLen);
  const header = JSON.parse(headerBytes.toString('utf8'));

  let offset = 12 + headerLen;
  const clipSvgs = [];
  for (let i = 0; i < header.clips.length; i++) {
    const len = buf.readUInt32LE(offset);
    offset += 4;
    clipSvgs.push(buf.subarray(offset, offset + len).toString('utf8'));
    offset += len;
  }

  return { magic, header, clipSvgs, totalLength: buf.length, consumedLength: offset };
}

const assets = {
  asset_a: { descriptor: { kind: 'image', format: 'svg' }, svg: '<svg id="a"/>' },
  asset_b: { descriptor: { kind: 'image', format: 'svg' }, svg: '<svg id="b" longer="true"/>' },
};

function resolveAsset(assetId) {
  const found = assets[assetId];
  if (!found) throw new Error(`unknown asset ${assetId}`);
  return found;
}

const fixedDesc = {
  kind: 'video',
  format: 'qvid',
  width: 640,
  height: 360,
  fps: 24,
  durationMs: 2000,
  clips: [
    { assetId: 'asset_a', startMs: 0, durMs: 1000, opacity: 1, z: 1 },
    { assetId: 'asset_b', startMs: 1000, durMs: 1000, opacity: 0.5 },
  ],
};

test('toQvid magic bytes and container round-trips through a parser', () => {
  const bytes = toQvid(fixedDesc, resolveAsset);
  const parsed = parseQvid(bytes);

  assert.deepEqual(parsed.magic, [0x51, 0x56, 0x49, 0x44, 0x00, 0x00, 0x00, 0x01]);
  assert.equal(parsed.consumedLength, parsed.totalLength);

  assert.equal(parsed.header.width, 640);
  assert.equal(parsed.header.height, 360);
  assert.equal(parsed.header.fps, 24);
  assert.equal(parsed.header.durationMs, 2000);
  assert.equal(parsed.header.clips.length, 2);

  assert.equal(parsed.header.clips[0].assetId, 'asset_a');
  assert.equal(parsed.header.clips[0].z, 1);
  assert.equal(parsed.header.clips[0].hash, sha256Hex(Buffer.from(assets.asset_a.svg, 'utf8')));

  assert.equal(parsed.header.clips[1].assetId, 'asset_b');
  assert.equal('z' in parsed.header.clips[1], false);
  assert.equal(parsed.header.clips[1].hash, sha256Hex(Buffer.from(assets.asset_b.svg, 'utf8')));

  assert.deepEqual(parsed.clipSvgs, [assets.asset_a.svg, assets.asset_b.svg]);
});

test('toQvid omits audio field when absent, includes it when present', () => {
  const withoutAudio = parseQvid(toQvid(fixedDesc, resolveAsset));
  assert.equal('audio' in withoutAudio.header, false);

  const withAudio = parseQvid(toQvid({ ...fixedDesc, audio: { assetId: 'asset_a' } }, resolveAsset));
  assert.deepEqual(withAudio.header.audio, { assetId: 'asset_a' });
});

test('toQvid is deterministic', () => {
  const a = toQvid(fixedDesc, resolveAsset);
  const b = toQvid(fixedDesc, resolveAsset);
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
});

test('toQvid pinned hash for a fixed descriptor', () => {
  const bytes = toQvid(fixedDesc, resolveAsset);
  assert.equal(sha256Hex(bytes), '53b6c7c500dce1d7dfc40d68febdb1170111ede2c869ea1308711def447540f6');
});

test('changing fps changes the produced bytes (and only the header)', () => {
  const a = toQvid(fixedDesc, resolveAsset);
  const b = toQvid({ ...fixedDesc, fps: 30 }, resolveAsset);
  assert.notDeepEqual(Buffer.from(a), Buffer.from(b));

  const parsedB = parseQvid(b);
  assert.equal(parsedB.header.fps, 30);
  // clip svg payloads are untouched by an fps change
  assert.deepEqual(parsedB.clipSvgs, [assets.asset_a.svg, assets.asset_b.svg]);
});

test('renderVideo dispatches qvid and throws on unknown format', () => {
  assert.deepEqual(
    Buffer.from(renderVideo(fixedDesc, resolveAsset)),
    Buffer.from(toQvid(fixedDesc, resolveAsset)),
  );
  assert.throws(() => renderVideo({ ...fixedDesc, format: 'mp4' }, resolveAsset), Error);
});
