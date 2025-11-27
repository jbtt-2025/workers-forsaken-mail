'use strict';

const encoder = new TextEncoder();
const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS mails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient TEXT NOT NULL,
    subject TEXT,
    body_text TEXT,
    body_html TEXT,
    sender TEXT,
    created_at INTEGER NOT NULL
  );`,
  'CREATE INDEX IF NOT EXISTS idx_mails_recipient ON mails (recipient);',
  'CREATE INDEX IF NOT EXISTS idx_mails_created_at ON mails (created_at);'
];

const sessions = new Map(); // sid -> { shortid, queue, lastSeen }
const shortIdIndex = new Map(); // shortid -> Set<sid>
let schemaPromise;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/socket.io/')) {
      return handleSocketIo(request, env, ctx);
    }

    ctx.waitUntil(ensureSchema(env));
    return env.ASSETS.fetch(request);
  },

  async email(message, env, ctx) {
    await ensureSchema(env);
    const domain = (env.MAIL_DOMAIN || '').toLowerCase().trim();
    const preBlacklist = parseList(env.PRE_BLACKLIST, [
      'admin', 'master', 'info', 'mail', 'webadmin',
      'webmaster', 'noreply', 'system', 'postmaster'
    ]);
    const banFromDomain = parseList(env.BAN_SEND_FROM_DOMAIN, []);

    const toAddress = parseAddress(message.to);
    if (!toAddress || !toAddress.local || !toAddress.domain) {
      return rejectEmail(message, 'invalid recipient');
    }
    if (domain && toAddress.domain !== domain) {
      return rejectEmail(message, 'domain not accepted');
    }
    if (preBlacklist.includes(toAddress.local)) {
      return rejectEmail(message, 'recipient blacklisted');
    }

    const fromAddress = parseAddress(message.from);
    if (fromAddress && banFromDomain.includes(fromAddress.domain)) {
      return rejectEmail(message, 'sender domain blocked');
    }

    const rawText = await new Response(message.raw).text();
    const parsed = parseEmail(rawText);
    const createdAt = Math.floor(Date.now() / 1000);

    await env.DB.prepare(
      `INSERT INTO mails (recipient, subject, body_text, body_html, sender, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`
    ).bind(
      toAddress.local,
      message.headers.get('subject') || parsed.subject || '',
      parsed.text || '',
      parsed.html || '',
      message.from || '',
      createdAt
    ).run();

    const clientMail = toClientMail({
      subject: message.headers.get('subject') || parsed.subject || '',
      body_text: parsed.text || '',
      body_html: parsed.html || '',
      sender: message.from || '',
      created_at: createdAt
    });

    notifyShortId(toAddress.local, clientMail);
    return new Response('stored', { status: 202 });
  },

  async scheduled(event, env) {
    await ensureSchema(env);
    const cutoffSeconds = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;
    await env.DB.prepare('DELETE FROM mails WHERE created_at < ?1').bind(cutoffSeconds).run();
  }
};

function parseList(value, fallback) {
  if (!value) return fallback;
  return value.split(',')
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => v.toLowerCase());
}

function parseAddress(input) {
  if (!input) return null;
  const match = /([\w.+-]+)@([\w.-]+)/.exec(input);
  if (!match) return null;
  return { local: match[1].toLowerCase(), domain: match[2].toLowerCase() };
}

function rejectEmail(message, reason) {
  if (typeof message.setReject === 'function') {
    message.setReject(reason);
  }
  return new Response(reason, { status: 550 });
}

async function ensureSchema(env) {
  if (!schemaPromise) {
    schemaPromise = env.DB.batch(SCHEMA_SQL.map(sql => env.DB.prepare(sql)));
  }
  return schemaPromise;
}

async function handleSocketIo(request, env, ctx) {
  const url = new URL(request.url);
  if (url.searchParams.get('transport') !== 'polling') {
    return new Response('transport not supported', { status: 400 });
  }

  if (request.method === 'GET') {
    return handlePollingGet(url, env);
  }

  if (request.method === 'POST') {
    const body = await request.text();
    return handlePollingPost(url, body, env, ctx);
  }

  return new Response('method not allowed', { status: 405 });
}

function handlePollingGet(url) {
  const sid = url.searchParams.get('sid');
  const headers = pollingHeaders();

  if (!sid) {
    const newSid = generateSid();
    const session = { shortid: null, queue: ['40'], lastSeen: Date.now() };
    sessions.set(newSid, session);
    const openPacket = encodePayload([
      `0{"sid":"${newSid}","upgrades":[],"pingInterval":25000,"pingTimeout":20000}`,
      ...drainQueue(session)
    ]);
    return new Response(openPacket, { headers });
  }

  const session = sessions.get(sid);
  if (!session) {
    return new Response('unknown sid', { status: 400, headers });
  }

  session.lastSeen = Date.now();
  const payload = encodePayload(drainQueue(session, true));
  return new Response(payload, { headers });
}

function handlePollingPost(url, body, env, ctx) {
  const sid = url.searchParams.get('sid');
  const headers = pollingHeaders();
  if (!sid || !sessions.has(sid)) {
    return new Response('unknown sid', { status: 400, headers });
  }

  const session = sessions.get(sid);
  session.lastSeen = Date.now();
  const packets = decodePayload(body);
  packets.forEach(packet => {
    if (packet === '2') {
      session.queue.push('3');
      return;
    }
    if (packet.startsWith('42')) {
      handleEventPacket(packet, session, env, ctx);
    }
  });

  cleanSessions();
  return new Response('ok', { headers });
}

function handleEventPacket(packet, session, env, ctx) {
  let payload;
  try {
    payload = JSON.parse(packet.slice(2));
  } catch (err) {
    return;
  }

  const [eventName, data] = payload;
  if (eventName === 'request shortid') {
    const newId = generateShortId();
    bindShortId(session, newId);
    session.queue.push(toEventPacket('shortid', newId));
    ctx && ctx.waitUntil(loadHistory(newId, session, env));
    return;
  }

  if (eventName === 'set shortid') {
    const requested = sanitizeShortId(String(data || ''));
    const blacklist = parseList(env.PRE_BLACKLIST || '', []);
    if (!requested || blacklist.includes(requested)) {
      const altId = generateShortId();
      bindShortId(session, altId);
      session.queue.push(toEventPacket('shortid', altId));
      ctx && ctx.waitUntil(loadHistory(altId, session, env));
      return;
    }
    bindShortId(session, requested);
    session.queue.push(toEventPacket('shortid', requested));
    ctx && ctx.waitUntil(loadHistory(requested, session, env));
  }
}

function sanitizeShortId(value) {
  return value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 64);
}

function bindShortId(session, shortid) {
  if (session.shortid) {
    const sids = shortIdIndex.get(session.shortid);
    if (sids) {
      sids.delete(getSidBySession(session));
      if (!sids.size) shortIdIndex.delete(session.shortid);
    }
  }
  session.shortid = shortid;
  const set = shortIdIndex.get(shortid) || new Set();
  set.add(getSidBySession(session));
  shortIdIndex.set(shortid, set);
}

function getSidBySession(session) {
  for (const [sid, current] of sessions.entries()) {
    if (current === session) return sid;
  }
  return null;
}

async function loadHistory(shortid, session, env) {
  await ensureSchema(env);
  const result = await env.DB.prepare(
    `SELECT subject, body_text, body_html, sender, created_at
     FROM mails WHERE recipient = ?1
     ORDER BY created_at DESC
     LIMIT 50`
  ).bind(shortid).all();

  const rows = (result?.results || []).reverse();
  rows.forEach(row => {
    session.queue.push(toEventPacket('mail', toClientMail(row)));
  });
}

function toClientMail(row) {
  const date = new Date(row.created_at * 1000);
  return {
    subject: row.subject || '',
    text: row.body_text || '',
    date: date.toISOString(),
    from: row.sender || '',
    texthtml: row.body_html || row.body_text || '',
    html: row.body_html || wrapPre(row.body_text || '')
  };
}

function wrapPre(text) {
  const escaped = text.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  return `<pre>${escaped}</pre>`;
}

function toEventPacket(event, payload) {
  return `42${JSON.stringify([event, payload])}`;
}

function notifyShortId(shortid, mail) {
  const sids = shortIdIndex.get(shortid);
  if (!sids) return;
  const packet = toEventPacket('mail', mail);
  for (const sid of sids) {
    const session = sessions.get(sid);
    if (session) session.queue.push(packet);
  }
}

function handleBodies(parts) {
  let text = '';
  let html = '';
  parts.forEach(part => {
    const lower = part.headers.toLowerCase();
    if (lower.includes('text/html')) {
      html = part.body.trim();
    } else if (lower.includes('text/plain')) {
      text = part.body.trim();
    }
  });
  if (!text && html) {
    text = html.replace(/<[^>]+>/g, ' ');
  }
  if (!html && text) {
    html = wrapPre(text);
  }
  return { text, html };
}

function parseEmail(raw) {
  const [headerSection, ...bodyParts] = raw.split(/\r?\n\r?\n/);
  const headers = headerSection || '';
  const boundaryMatch = headers.match(/boundary="?(.+?)"?\r?$/im);
  if (!boundaryMatch) {
    const body = bodyParts.join('\n\n');
    return { subject: getHeader(headers, 'subject'), ...handleBodies([{ headers, body }]) };
  }

  const boundary = boundaryMatch[1];
  const splitter = new RegExp(`--${escapeRegex(boundary)}(?:--)?`);
  const segments = raw.split(splitter).map(s => s.trim()).filter(Boolean);
  const parts = segments.map(segment => {
    const [h, ...b] = segment.split(/\r?\n\r?\n/);
    return { headers: h || '', body: b.join('\n\n') };
  });
  const bodies = handleBodies(parts);
  return { subject: getHeader(headers, 'subject'), ...bodies };
}

function getHeader(headers, name) {
  const regex = new RegExp(`^${name}:\\s*(.*)$`, 'im');
  const match = headers.match(regex);
  return match ? match[1].trim() : '';
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function drainQueue(session, allowNoop = false) {
  if (session.queue.length === 0 && allowNoop) {
    return ['6'];
  }
  const packets = session.queue.slice();
  session.queue.length = 0;
  return packets;
}

function generateSid() {
  return crypto.randomUUID().replace(/-/g, '');
}

function generateShortId() {
  return crypto.randomUUID().split('-')[0];
}

function encodePayload(packets) {
  return packets.map(packet => `${encoder.encode(packet).length}:${packet}`).join('');
}

function decodePayload(body) {
  const packets = [];
  let offset = 0;
  while (offset < body.length) {
    const colon = body.indexOf(':', offset);
    if (colon === -1) break;
    const length = parseInt(body.slice(offset, colon), 10);
    if (!Number.isFinite(length)) break;
    const start = colon + 1;
    const packet = body.slice(start, start + length);
    packets.push(packet);
    offset = start + length;
  }
  return packets;
}

function pollingHeaders() {
  return {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  };
}

function cleanSessions() {
  const now = Date.now();
  for (const [sid, session] of sessions.entries()) {
    if (now - session.lastSeen > 60 * 60 * 1000) {
      sessions.delete(sid);
      if (session.shortid) {
        const set = shortIdIndex.get(session.shortid);
        if (set) {
          set.delete(sid);
          if (!set.size) shortIdIndex.delete(session.shortid);
        }
      }
    }
  }
}
