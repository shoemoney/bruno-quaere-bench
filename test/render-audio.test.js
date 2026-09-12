import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { toWav, toQa8, renderAudio } from '../src/render/audio.js';

function sha256Hex(bytes) {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

const fixedWavDesc = {
  kind: 'audio',
  format: 'wav',
  sampleRate: 8000,
  durationMs: 100,
  notes: [{ freq: 440, startMs: 0, durMs: 100, amp: 0.5, wave: 'sine' }],
};

const fixedQa8Desc = {
  kind: 'audio',
  format: 'qa8',
  sampleRate: 8000,
  durationMs: 100,
  notes: [{ freq: 220, startMs: 0, durMs: 100, amp: 0.5, wave: 'square' }],
};

test('toWav produces correct RIFF/fmt/data header fields', () => {
  const bytes = toWav(fixedWavDesc);
  const buf = Buffer.from(bytes);
  const numSamples = Math.round((fixedWavDesc.sampleRate * fixedWavDesc.durationMs) / 1000);
  const dataSize = numSamples * 2;

  assert.equal(buf.length, 44 + dataSize);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF');
  assert.equal(buf.readUInt32LE(4), 36 + dataSize);
  assert.equal(buf.toString('ascii', 8, 12), 'WAVE');
  assert.equal(buf.toString('ascii', 12, 16), 'fmt ');
  assert.equal(buf.readUInt32LE(16), 16);
  assert.equal(buf.readUInt16LE(20), 1); // PCM
  assert.equal(buf.readUInt16LE(22), 1); // mono
  assert.equal(buf.readUInt32LE(24), fixedWavDesc.sampleRate);
  assert.equal(buf.readUInt32LE(28), fixedWavDesc.sampleRate * 2);
  assert.equal(buf.readUInt16LE(32), 2);
  assert.equal(buf.readUInt16LE(34), 16);
  assert.equal(buf.toString('ascii', 36, 40), 'data');
  assert.equal(buf.readUInt32LE(40), dataSize);
});

test('toWav is deterministic', () => {
  const a = toWav(fixedWavDesc);
  const b = toWav(fixedWavDesc);
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
});

test('toWav pinned hash for a fixed descriptor', () => {
  const bytes = toWav(fixedWavDesc);
  assert.equal(sha256Hex(bytes), '2ddcde38da04203a1ff7206f543db989c8fd5390c970a08296487951c8dc2762');
});

test('toWav clips additive overlap to int16 range', () => {
  const loudDesc = {
    kind: 'audio',
    format: 'wav',
    sampleRate: 8000,
    durationMs: 10,
    notes: [
      { freq: 100, startMs: 0, durMs: 10, amp: 1, wave: 'square' },
      { freq: 100, startMs: 0, durMs: 10, amp: 1, wave: 'square' },
      { freq: 100, startMs: 0, durMs: 10, amp: 1, wave: 'square' },
    ],
  };
  const buf = Buffer.from(toWav(loudDesc));
  // three square waves in phase sum to 3 or -3 pre-clip; must clip into int16 range.
  const first = buf.readInt16LE(44);
  assert.ok(first === 32767 || first === -32768);
});

test('durationMs beyond 30000 throws for both formats', () => {
  const tooLong = { ...fixedWavDesc, durationMs: 30001 };
  assert.throws(() => toWav(tooLong), RangeError);
  assert.throws(() => toQa8({ ...fixedQa8Desc, durationMs: 30001 }), RangeError);
});

test('durationMs at exactly 30000 does not throw', () => {
  const atCap = { ...fixedWavDesc, durationMs: 30000 };
  assert.doesNotThrow(() => toWav(atCap));
});

test('toQa8 header: magic, sampleRate, length, reserved zero bytes', () => {
  const bytes = toQa8(fixedQa8Desc);
  const buf = Buffer.from(bytes);
  const numSamples = Math.round((fixedQa8Desc.sampleRate * fixedQa8Desc.durationMs) / 1000);

  assert.equal(buf.length, 16 + numSamples);
  assert.deepEqual([...buf.subarray(0, 4)], [0x51, 0x41, 0x38, 0x00]); // 'QA8\0'
  assert.equal(buf.readUInt32LE(4), fixedQa8Desc.sampleRate);
  assert.equal(buf.readUInt32LE(8), numSamples);
  assert.deepEqual([...buf.subarray(12, 16)], [0, 0, 0, 0]);
  // samples are unsigned bytes
  for (let i = 16; i < buf.length; i++) {
    assert.ok(buf[i] >= 0 && buf[i] <= 255);
  }
});

test('toQa8 is deterministic and pinned', () => {
  const a = toQa8(fixedQa8Desc);
  const b = toQa8(fixedQa8Desc);
  assert.deepEqual(Buffer.from(a), Buffer.from(b));
  assert.equal(sha256Hex(a), '914fabf1ee81c79ebb2ceb4e44ba6bc1caa9d60fb6d33c7daf98f32eb7b3c324');
});

test('renderAudio dispatches on format', () => {
  assert.deepEqual(Buffer.from(renderAudio(fixedWavDesc)), Buffer.from(toWav(fixedWavDesc)));
  assert.deepEqual(Buffer.from(renderAudio(fixedQa8Desc)), Buffer.from(toQa8(fixedQa8Desc)));
});

test('renderAudio throws on unknown format', () => {
  assert.throws(() => renderAudio({ ...fixedWavDesc, format: 'mp3' }), Error);
});

test('wave types produce distinct output for the same note otherwise', () => {
  const base = { freq: 300, startMs: 0, durMs: 20, amp: 0.8 };
  const waves = ['sine', 'square', 'saw', 'triangle'];
  const hashes = new Set(
    waves.map((wave) => {
      const desc = { kind: 'audio', format: 'wav', sampleRate: 8000, durationMs: 20, notes: [{ ...base, wave }] };
      return sha256Hex(toWav(desc));
    }),
  );
  assert.equal(hashes.size, waves.length);
});
