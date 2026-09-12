// Audio rendering: AudioDescriptor -> WAV or QA8 bytes. Pure functions of the descriptor.

const MAX_DURATION_MS = 30000;

function assertDuration(durationMs) {
  if (durationMs > MAX_DURATION_MS) {
    throw new RangeError(`durationMs ${durationMs} exceeds max ${MAX_DURATION_MS}`);
  }
}

function frac(x) {
  return x - Math.floor(x);
}

// cycles: how many full periods have elapsed (freq * t). Waveforms live in [-1, 1].
function waveValue(wave, cycles) {
  const f = frac(cycles);
  switch (wave) {
    case 'sine':
      return Math.sin(2 * Math.PI * cycles);
    case 'square':
      return f < 0.5 ? 1 : -1;
    case 'saw':
      return 2 * f - 1;
    case 'triangle':
      return 4 * Math.abs(f - Math.floor(f + 0.5)) - 1;
    default:
      throw new Error(`unknown wave type: ${wave}`);
  }
}

// Additive mix of every active note at integer sample index i. Result can exceed
// [-1, 1] when notes overlap; callers clip at their target bit depth.
function mixSample(notes, i, sampleRate) {
  const tMs = (i * 1000) / sampleRate;
  const t = i / sampleRate;
  let sum = 0;
  for (const note of notes) {
    if (tMs < note.startMs || tMs >= note.startMs + note.durMs) continue;
    sum += note.amp * waveValue(note.wave, note.freq * t);
  }
  return sum;
}

function mixToInt16(desc) {
  assertDuration(desc.durationMs);
  const numSamples = Math.round((desc.sampleRate * desc.durationMs) / 1000);
  const samples = new Int16Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const sum = mixSample(desc.notes, i, desc.sampleRate);
    let v = Math.round(sum * 32767);
    if (v > 32767) v = 32767;
    if (v < -32768) v = -32768;
    samples[i] = v;
  }
  return samples;
}

const QA8_MAGIC = Buffer.from([0x51, 0x41, 0x38, 0x00]); // 'QA8\0'

export function toWav(desc) {
  const samples = mixToInt16(desc);
  const numSamples = samples.length;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size (PCM)
  buf.writeUInt16LE(1, 20); // audio format: PCM
  buf.writeUInt16LE(1, 22); // channels: mono
  buf.writeUInt32LE(desc.sampleRate, 24);
  buf.writeUInt32LE(desc.sampleRate * 2, 28); // byte rate (mono, 16-bit)
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    buf.writeInt16LE(samples[i], 44 + i * 2);
  }

  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function toQa8(desc) {
  const samples = mixToInt16(desc);
  const numSamples = samples.length;
  const buf = Buffer.alloc(16 + numSamples);

  QA8_MAGIC.copy(buf, 0);
  buf.writeUInt32LE(desc.sampleRate, 4);
  buf.writeUInt32LE(numSamples, 8);
  // bytes 12-15 reserved, left as zero by Buffer.alloc

  for (let i = 0; i < numSamples; i++) {
    let u = Math.floor((samples[i] + 32768) / 256);
    if (u > 255) u = 255;
    if (u < 0) u = 0;
    buf.writeUInt8(u, 16 + i);
  }

  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function renderAudio(desc) {
  switch (desc.format) {
    case 'wav':
      return toWav(desc);
    case 'qa8':
      return toQa8(desc);
    default:
      throw new Error(`unknown audio format: ${desc.format}`);
  }
}
