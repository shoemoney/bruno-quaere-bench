// In-memory resource store: workspaces, projects, assets, jobs, plus seeding and the
// descriptor -> bytes/hash plumbing shared by every route that creates or derives an asset.

import { create } from '../media.js';
import { hashArtifact } from '../canon.js';
import { rng, sub, pick, int } from '../seed.js';
import { renderImage, toSvg } from '../render/image.js';
import { renderAudio } from '../render/audio.js';
import { renderVideo } from '../render/video.js';
import { makeEtag } from './behaviors.js';

// createResourceStore() -> empty store; call seedInitialData to populate it.
export function createResourceStore() {
  return {
    workspaces: new Map(),
    projects: new Map(),
    assets: new Map(),
    jobs: new Map(),
    counters: { workspace: 0, project: 0, asset: 0, job: 0 },
  };
}

// nextId(world, store, kind): id shaped per world.ids.style. Only the shape is seeded; the
// counter itself is a plain runtime sequence, which is fine since ids are opaque to the ladder
// (only descriptor hashes are ever compared).
export function nextId(world, store, kind) {
  store.counters[kind] += 1;
  const n = store.counters[kind];
  const prefix = world.ids.prefixes[kind];
  const style = world.ids.style;
  if (style === 'int') return String(n);
  if (style === 'ulid') return `${prefix.toUpperCase().replace(/[^A-Z0-9]/g, '')}${String(n).padStart(20, '0')}`;
  if (style === 'uuid') return `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
  return `${prefix}_${n}`; // prefixed (default)
}

// ---------------------------------------------------------------------------
// descriptor -> bytes/hash
// ---------------------------------------------------------------------------

// resolveAssetForVideo(store) -> resolveAsset(assetId) for render/video.js: video clips always
// embed the referenced image's SVG bytes regardless of that asset's own stored format.
export function makeVideoResolver(store) {
  return function resolveAsset(assetId) {
    const asset = store.assets.get(assetId);
    if (!asset || asset.descriptor.kind !== 'image') {
      throw new Error(`asset ${assetId} not found or not an image`);
    }
    return { svg: toSvg(asset.descriptor) };
  };
}

// renderAssetBytes(desc, store) -> the exact bytes (or SVG text) the judge would hash for this
// descriptor. Shared by hashDescriptor and the GET .../content route.
export function renderAssetBytes(desc, store) {
  if (desc.kind === 'image') return renderImage(desc);
  if (desc.kind === 'audio') return renderAudio(desc);
  return renderVideo(desc, makeVideoResolver(store));
}

export function hashDescriptor(desc, store) {
  const bytes = renderAssetBytes(desc, store);
  return hashArtifact(typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes);
}

export function contentTypeFor(desc) {
  if (desc.kind === 'image') return desc.format === 'png' ? 'image/png' : 'image/svg+xml';
  if (desc.kind === 'audio') return desc.format === 'wav' ? 'audio/wav' : 'application/octet-stream';
  return 'application/octet-stream'; // qvid
}

// buildAsset({id, projectId, descriptor, store, now}) -> a stored asset record.
export function buildAsset({ id, projectId = null, descriptor, store, now }) {
  const hash = hashDescriptor(descriptor, store);
  return {
    id,
    projectId,
    descriptor,
    hash,
    etag: makeEtag(hash),
    displayName: null,
    createdAt: now,
    updatedAt: now,
    deleted: false,
    deletedAt: null,
  };
}

// ---------------------------------------------------------------------------
// listing helpers (Map insertion order is deterministic and doubles as created-order)
// ---------------------------------------------------------------------------

export function listWorkspaces(store) {
  return [...store.workspaces.values()];
}

export function listProjects(store, workspaceId) {
  return [...store.projects.values()].filter((p) => p.workspaceId === workspaceId);
}

export function listAssetsForProject(store, projectId, { includeDeleted = false } = {}) {
  return [...store.assets.values()].filter(
    (a) => a.projectId === projectId && (includeDeleted || !a.deleted),
  );
}

// ---------------------------------------------------------------------------
// seeding: 2 workspaces, 3 projects (2 + 1), 12 image assets per project.
// ---------------------------------------------------------------------------

const SEED_COLORS = ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff', '#111111', '#eeeeee'];

function seededImageParams(world, seedValue) {
  const r = rng(seedValue);
  const shapeCount = int(r, 1, 3);
  const shapes = [];
  for (let i = 0; i < shapeCount; i += 1) {
    const shape = {
      type: 'rect',
      x: int(r, 0, 100),
      y: int(r, 0, 100),
      w: int(r, 10, 50),
      h: int(r, 10, 50),
      color: pick(r, SEED_COLORS),
      opacity: 1,
    };
    if (world.rules.zOrder === 'explicit') shape.z = i;
    shapes.push(shape);
  }
  return {
    width: int(r, 100, 400),
    height: int(r, 100, 400),
    background: { color: pick(r, SEED_COLORS) },
    shapes,
  };
}

const PROJECTS_PER_WORKSPACE = [2, 1];
const ASSETS_PER_PROJECT = 12;

// seedInitialData(world, store, now): populates the store deterministically from world.seed.
export function seedInitialData(world, store, now) {
  PROJECTS_PER_WORKSPACE.forEach((projectCount, w) => {
    const workspaceId = nextId(world, store, 'workspace');
    store.workspaces.set(workspaceId, { id: workspaceId, name: `Workspace ${w + 1}`, createdAt: now });
    for (let p = 0; p < projectCount; p += 1) {
      const projectId = nextId(world, store, 'project');
      store.projects.set(projectId, {
        id: projectId,
        workspaceId,
        name: `Project ${w + 1}.${p + 1}`,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
      });
      for (let a = 0; a < ASSETS_PER_PROJECT; a += 1) {
        const assetId = nextId(world, store, 'asset');
        const seedValue = sub(world.seed, `seed.asset.${workspaceId}.${projectId}.${a}`);
        const descriptor = create(world, 'image', seededImageParams(world, seedValue));
        store.assets.set(assetId, buildAsset({ id: assetId, projectId, descriptor, store, now }));
      }
    }
  });
}
