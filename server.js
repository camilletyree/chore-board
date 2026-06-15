// server.js — zero-dependency static file server + shared-state JSON API.
// Node 18+. Run: `node server.js`  (PORT and DATA_FILE configurable via env).
//
// Why a server at all: the app is a shared family board, so all devices must read and
// write the SAME state. This server keeps one JSON file as the source of truth.
//
// State is stored as addressable ENTITIES (see public/sync.js) so devices sync small
// deltas instead of the whole document — independent edits never clobber each other and
// changes propagate in ~1s. The server stays domain-dumb: it stores records, stamps each
// applied write with a monotonic `_seq`, and resolves same-record conflicts by last-write-
// wins on the client `_updatedAt`. It runs NO scheduling logic.
//
//   On disk: { serverSeq, entities: { people, chores, rooms, matrixTypes, completion, settings, week } }
//
// Endpoints:
//   GET  /api/changes?since=<seq>  -> { serverSeq, changes:[{collection,id,rec}] }   (records with _seq > since)
//   POST /api/changes  {ops:[...]} -> { serverSeq, applied:[...], conflicts:[...] }  (per-entity LWW)
//   GET  /api/stream               -> Server-Sent Events; emits {serverSeq} on each applied write
//   GET  /api/state                -> recomposed whole-doc snapshot (back-compat / restore)
//   PUT  /api/state  <whole-doc>   -> wholesale replace (back-compat / reset)

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emptyEnt, decompose, recompose, KEYED, SINGLE, COLLECTIONS } from './public/sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'state.json');
const TOMBSTONE_TTL = 30 * 86400000; // GC deleted records after 30 days

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/* ===================== in-memory state + persistence ===================== */
let STATE = { serverSeq: 0, entities: emptyEnt() };
const sseClients = new Set();
let writeChain = Promise.resolve(); // serialize writes so concurrent saves can't interleave

function persist() {
  const snapshot = JSON.stringify(STATE, null, 2);
  writeChain = writeChain.then(async () => {
    await mkdir(path.dirname(DATA_FILE), { recursive: true });
    await writeFile(DATA_FILE, snapshot);
  }).catch(err => console.error('persist failed:', err && err.message || err));
  return writeChain;
}

// Migrate any on-disk shape into { serverSeq, entities }. Idempotent.
function migrate(raw) {
  if (raw && raw.entities && typeof raw.serverSeq === 'number') return { serverSeq: raw.serverSeq, entities: { ...emptyEnt(), ...raw.entities } };
  if (!raw || typeof raw !== 'object') return { serverSeq: 0, entities: emptyEnt() };
  // old whole-doc { rev, people[], chores[], ... }: decompose and stamp everything at seq 1.
  const ent = decompose(raw);
  const now = Date.now();
  for (const c of KEYED) for (const id of Object.keys(ent[c])) ent[c][id] = { ...ent[c][id], _seq: 1, _updatedAt: now };
  for (const c of SINGLE) if (ent[c]) ent[c] = { ...ent[c], _seq: 1, _updatedAt: now };
  return { serverSeq: 1, entities: ent };
}

function gcTombstones(state) {
  const cutoff = Date.now() - TOMBSTONE_TTL;
  for (const c of KEYED) for (const id of Object.keys(state.entities[c])) {
    const r = state.entities[c][id];
    if (r && r._deleted && (r._updatedAt || 0) < cutoff) delete state.entities[c][id];
  }
}

async function load() {
  let raw = null;
  try { raw = JSON.parse(await readFile(DATA_FILE, 'utf8')); } catch { /* missing/empty -> fresh */ }
  STATE = migrate(raw);
  gcTombstones(STATE);
  if (raw) await persist(); // write back the (possibly) migrated/GC'd shape
}

/* ===================== change protocol ===================== */
function collectChanges(since) {
  const changes = [];
  for (const c of KEYED) for (const [id, rec] of Object.entries(STATE.entities[c])) if ((rec._seq || 0) > since) changes.push({ collection: c, id, rec });
  for (const c of SINGLE) { const rec = STATE.entities[c]; if (rec && (rec._seq || 0) > since) changes.push({ collection: c, id: c, rec }); }
  changes.sort((a, b) => (a.rec._seq || 0) - (b.rec._seq || 0));
  return changes;
}

// Apply one delta op with per-entity last-write-wins. Returns the stamped record, or null if rejected.
function applyOp({ collection, id, rec }) {
  if (!COLLECTIONS.includes(collection) || !rec) return null;
  const single = SINGLE.includes(collection);
  const stored = single ? STATE.entities[collection] : STATE.entities[collection][id];
  const incomingAt = rec._updatedAt || 0;
  if (stored && incomingAt < (stored._updatedAt || 0)) return null; // a newer write already won
  const stamped = { ...rec, _seq: ++STATE.serverSeq, _updatedAt: incomingAt || Date.now() };
  if (single) STATE.entities[collection] = stamped; else STATE.entities[collection][id] = stamped;
  return stamped;
}

function broadcast() {
  const msg = `data: ${JSON.stringify({ serverSeq: STATE.serverSeq })}\n\n`;
  for (const res of sseClients) { try { res.write(msg); } catch { sseClients.delete(res); } }
}

// Wholesale replace from a whole-doc snapshot (back-compat PUT / reset). Bumps seqs so clients pull.
function replaceFromDoc(S) {
  const ent = decompose(S);
  const now = Date.now();
  for (const c of KEYED) for (const id of Object.keys(ent[c])) ent[c][id] = { ...ent[c][id], _seq: ++STATE.serverSeq, _updatedAt: now };
  for (const c of SINGLE) if (ent[c]) ent[c] = { ...ent[c], _seq: ++STATE.serverSeq, _updatedAt: now };
  STATE.entities = ent;
}

/* ===================== http plumbing ===================== */
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '', size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('payload too large')); req.destroy(); } data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden', 'text/plain'); // path traversal guard
  if (!existsSync(filePath)) return send(res, 404, 'Not found', 'text/plain');
  try {
    const buf = await readFile(filePath);
    send(res, 200, buf, MIME[path.extname(filePath)] || 'application/octet-stream');
  } catch { send(res, 500, 'Server error', 'text/plain'); }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const { pathname } = url;

    if (pathname === '/api/changes') {
      if (req.method === 'GET') {
        const since = Number(url.searchParams.get('since')) || 0;
        return send(res, 200, JSON.stringify({ serverSeq: STATE.serverSeq, changes: collectChanges(since) }));
      }
      if (req.method === 'POST') {
        let body; try { body = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'invalid JSON' })); }
        const ops = Array.isArray(body && body.ops) ? body.ops : [];
        const applied = [], conflicts = [];
        for (const op of ops) {
          const stamped = applyOp(op);
          if (stamped) applied.push({ collection: op.collection, id: op.id, _seq: stamped._seq });
          else conflicts.push({ collection: op.collection, id: op.id });
        }
        if (applied.length) { await persist(); broadcast(); }
        return send(res, 200, JSON.stringify({ serverSeq: STATE.serverSeq, applied, conflicts }));
      }
      return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
    }

    if (pathname === '/api/stream' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      res.write(`data: ${JSON.stringify({ serverSeq: STATE.serverSeq })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (pathname === '/api/state') {
      if (req.method === 'GET') return send(res, 200, JSON.stringify(recompose(STATE.entities, STATE.serverSeq)));
      if (req.method === 'PUT' || req.method === 'POST') {
        let parsed; try { parsed = JSON.parse(await readBody(req)); } catch { return send(res, 400, JSON.stringify({ error: 'invalid JSON' })); }
        replaceFromDoc(parsed);
        await persist(); broadcast();
        return send(res, 200, JSON.stringify({ ok: true, serverSeq: STATE.serverSeq }));
      }
      return send(res, 405, JSON.stringify({ error: 'method not allowed' }));
    }

    if (pathname === '/api/health') return send(res, 200, JSON.stringify({ ok: true, serverSeq: STATE.serverSeq }));
    if (req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain');
    return serveStatic(req, res);
  } catch (err) {
    send(res, 500, JSON.stringify({ error: String(err && err.message || err) }));
  }
});

// Keep SSE connections alive through idle proxies.
setInterval(() => { for (const res of sseClients) { try { res.write(': ping\n\n'); } catch { sseClients.delete(res); } } }, 25000).unref();

load().then(() => {
  server.listen(PORT, () => console.log(`ChoreBoard running at http://0.0.0.0:${PORT}  (data: ${DATA_FILE})`));
});
