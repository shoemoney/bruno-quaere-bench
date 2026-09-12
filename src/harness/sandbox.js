// A sandbox is a directory where the only binary on PATH is `bru`. It gives the agent five
// tools total (Addendum B): `bru` is the only one that opens a socket; `write_file`, `read_file`,
// `grep`, and `ls` are a deliberately dumb text editor scoped to the sandbox directory, because
// an agent that can only run `bru` has no way to author the `.bru` request files `bru` reads.
//
// Wall-clock timing here (Date.now()) is allowed: this is the harness, not anything that feeds
// an artifact, a spec, a skill, or a rung (see ARCHITECTURE.md's determinism rule).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { mkdir, readFile, writeFile as fsWriteFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const MAX_OUTPUT_CHARS = 20_000;
const MAX_READ_LINES = 200;
const MAX_GREP_HITS = 100;
const EXEC_TIMEOUT_MS = 120_000;

function truncate(str) {
  if (str.length <= MAX_OUTPUT_CHARS) return str;
  const cut = str.length - MAX_OUTPUT_CHARS;
  return `${str.slice(0, MAX_OUTPUT_CHARS)}\n...[truncated, ${cut} more chars]`;
}

// resolveBru(): search the CALLER's PATH (the parent process's, i.e. this one's, not the
// sandboxed one we are about to build) for a real `bru` executable. Throws a clear error if
// none is found, per ARCHITECTURE.md: "throw a clear error if bru is not installed".
export function resolveBru(env = process.env) {
  const pathVar = env.PATH || '';
  const dirs = pathVar.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, 'bru');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {
      // not here, keep looking
    }
  }
  throw new Error(
    'bru is not installed (or not on PATH). Install the Bruno CLI -- https://www.usebruno.com/ -- ' +
      'before running the QUAERE harness; the sandbox symlinks the real binary in at creation time.',
  );
}

// parseCommandLine(line) -> string[]. A tiny shell-ish tokenizer: splits on whitespace, respects
// single and double quotes (no escapes inside single quotes, backslash-escapes inside double
// quotes and bare words). No globbing, no pipes, no redirection -- Addendum B: "No shell."
export function parseCommandLine(line) {
  const argv = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let started = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (inSingle) {
      if (c === "'") inSingle = false;
      else cur += c;
      continue;
    }
    if (inDouble) {
      if (c === '"') inDouble = false;
      else if (c === '\\' && i + 1 < line.length && (line[i + 1] === '"' || line[i + 1] === '\\')) {
        cur += line[i + 1];
        i += 1;
      } else cur += c;
      continue;
    }
    if (c === "'") {
      inSingle = true;
      started = true;
      continue;
    }
    if (c === '"') {
      inDouble = true;
      started = true;
      continue;
    }
    if (c === '\\' && i + 1 < line.length) {
      cur += line[i + 1];
      i += 1;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (started) {
        argv.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += c;
    started = true;
  }
  if (started || cur.length > 0) argv.push(cur);
  if (inSingle || inDouble) throw new Error('unterminated quote in command line');
  return argv;
}

function safeResolve(dir, rel) {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new Error('path is required');
  }
  if (path.isAbsolute(rel)) {
    throw new Error(`path escapes sandbox: ${rel} (must be relative)`);
  }
  const resolved = path.resolve(dir, rel);
  if (resolved !== dir && !resolved.startsWith(dir + path.sep)) {
    throw new Error(`path escapes sandbox: ${rel}`);
  }
  return resolved;
}

async function walkFiles(root, dir, skipDirs) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(path.relative(root, full))) continue;
      out.push(...(await walkFiles(root, full, skipDirs)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

// makeSandbox(dir) -> { dir, binDir, exec, writeFile, readFile, grep, ls }
//
// Creates `dir/bin/bru` as a symlink to the real bru resolved from PATH, then hands back the
// tool surface the harness wires to the agent's five tools (bru, write_file, read_file, grep,
// ls). `exec` rejects anything whose argv[0] isn't literally `bru`.
export function makeSandbox(dir) {
  const absDir = path.resolve(dir);
  const binDir = path.join(absDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const bruPath = resolveBru();
  const linkPath = path.join(binDir, 'bru');
  try {
    fs.unlinkSync(linkPath);
  } catch {
    // fine, nothing there yet
  }
  fs.symlinkSync(bruPath, linkPath);

  async function exec(cmdline) {
    const argv = parseCommandLine(cmdline);
    if (argv.length === 0) {
      throw new Error('empty command');
    }
    if (argv[0] !== 'bru') {
      throw new Error(`only "bru" may be run in this sandbox, got: ${argv[0]}`);
    }
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawn('bru', argv.slice(1), {
          cwd: absDir,
          // PATH resolves `bru` from binDir first -- the one binary the agent can ever name,
          // since exec() above already refuses any argv[0] but 'bru'. The real bru is commonly a
          // `#!/usr/bin/env node` script, so node's own directory rides along on PATH too: that
          // is env(1)/the kernel resolving bru's OWN interpreter, not a door the agent can walk
          // through, since nothing here ever lets the agent choose argv[0].
          env: { PATH: `${binDir}${path.delimiter}${path.dirname(process.execPath)}`, HOME: absDir },
          timeout: EXEC_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        });
      } catch (err) {
        reject(err);
        return;
      }
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        resolve({
          stdout: truncate(stdout),
          stderr: truncate(stderr),
          code: code === null ? (signal === 'SIGKILL' ? 124 : -1) : code,
          ms: Date.now() - startedAt,
        });
      });
    });
  }

  async function writeFile(rel, content) {
    const full = safeResolve(absDir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    const text = String(content ?? '');
    await fsWriteFile(full, text, 'utf8');
    return { ok: true, path: rel, bytes: Buffer.byteLength(text, 'utf8') };
  }

  async function readSandboxFile(rel, { offset = 0, limit = MAX_READ_LINES } = {}) {
    const full = safeResolve(absDir, rel);
    const text = await readFile(full, 'utf8');
    const allLines = text.split('\n');
    const start = Math.max(0, offset | 0);
    const cappedLimit = Math.min(MAX_READ_LINES, limit > 0 ? limit | 0 : MAX_READ_LINES);
    const slice = allLines.slice(start, start + cappedLimit);
    return {
      path: rel,
      totalLines: allLines.length,
      offset: start,
      lines: slice.map((line, i) => ({ n: start + i + 1, text: line })),
      truncated: start + cappedLimit < allLines.length,
    };
  }

  async function grep(pattern, rel) {
    let re;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      throw new Error(`bad pattern: ${err.message}`);
    }
    const full = safeResolve(absDir, rel);
    const st = await stat(full);
    const files = st.isDirectory() ? await walkFiles(full, full, new Set(['bin'])) : [full];
    const hits = [];
    for (const file of files) {
      if (hits.length >= MAX_GREP_HITS) break;
      let text;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < MAX_GREP_HITS; i += 1) {
        if (re.test(lines[i])) {
          hits.push({ file: path.relative(absDir, file), line: i + 1, text: lines[i] });
        }
      }
    }
    return { pattern, path: rel, hits, truncated: hits.length >= MAX_GREP_HITS };
  }

  async function ls(rel = '.') {
    const full = safeResolve(absDir, rel);
    const entries = await readdir(full, { withFileTypes: true });
    const out = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        out.push({ name: entry.name, type: 'dir' });
      } else if (entry.isFile()) {
        const st = await stat(path.join(full, entry.name));
        out.push({ name: entry.name, type: 'file', size: st.size });
      }
    }
    return { path: rel, entries: out };
  }

  return { dir: absDir, binDir, exec, writeFile, readFile: readSandboxFile, grep, ls };
}
