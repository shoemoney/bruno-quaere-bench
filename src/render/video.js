// Video rendering: VideoDescriptor -> QVID container bytes. Pure function of the
// descriptor plus an asset resolver; no per-frame rasterization.
//
// Canonical JSON and hashing come from canon.js, the single owner of both, so the
// header bytes a clip is hashed into are the same bytes the judge canonicalizes
// everywhere else.

import { canonical, sha256 } from '../canon.js';

// 'QVID' + \0\0\0\x01
const MAGIC = Buffer.from([0x51, 0x56, 0x49, 0x44, 0x00, 0x00, 0x00, 0x01]);

export function toQvid(desc, resolveAsset) {
  const clipSvgBuffers = [];
  const clipHeaders = desc.clips.map((clip) => {
    const { svg } = resolveAsset(clip.assetId);
    const svgBytes = Buffer.from(svg, 'utf8');
    clipSvgBuffers.push(svgBytes);
    const entry = {
      assetId: clip.assetId,
      startMs: clip.startMs,
      durMs: clip.durMs,
      opacity: clip.opacity,
      hash: sha256(svgBytes),
    };
    if (clip.z !== undefined) entry.z = clip.z;
    return entry;
  });

  const header = {
    width: desc.width,
    height: desc.height,
    fps: desc.fps,
    durationMs: desc.durationMs,
    clips: clipHeaders,
  };
  if (desc.audio !== undefined) header.audio = desc.audio;

  const headerBytes = Buffer.from(canonical(header), 'utf8');
  const headerLenBuf = Buffer.alloc(4);
  headerLenBuf.writeUInt32LE(headerBytes.length, 0);

  const parts = [MAGIC, headerLenBuf, headerBytes];
  for (const svgBytes of clipSvgBuffers) {
    const lenBuf = Buffer.alloc(4);
    lenBuf.writeUInt32LE(svgBytes.length, 0);
    parts.push(lenBuf, svgBytes);
  }

  const out = Buffer.concat(parts);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

export function renderVideo(desc, resolveAsset) {
  switch (desc.format) {
    case 'qvid':
      return toQvid(desc, resolveAsset);
    default:
      throw new Error(`unknown video format: ${desc.format}`);
  }
}
