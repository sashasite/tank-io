// tank.io: account API for Vercel (Node serverless function).
// Storage: Upstash Redis / Vercel KV via REST (env vars are added automatically by the Vercel Storage integration).
const crypto = require('crypto');

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOK = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const SECRET = process.env.TOKEN_SECRET || KV_TOK || 'change-me';
const ADMIN = (process.env.ADMIN_USER || 'sashasamixtop').toLowerCase();

async function kv(cmd) {
  const r = await fetch(KV_URL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + KV_TOK, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}

const b64 = (s) => Buffer.from(s).toString('base64url');
const sign = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
const mkToken = (u) => { const p = b64(u + '|' + (Date.now() + 30 * 864e5)); return p + '.' + sign(p); };
function who(t) {
  if (typeof t !== 'string') return null;
  const [p, s] = t.split('.');
  if (!p || !s) return null;
  const e = sign(p);
  if (e.length !== s.length || !crypto.timingSafeEqual(Buffer.from(e), Buffer.from(s))) return null;
  const [u, x] = Buffer.from(p, 'base64url').toString().split('|');
  return +x > Date.now() ? u : null;
}
const hash = (p, salt) => crypto.scryptSync(p, salt, 32).toString('hex');
const key = (u) => 'acc:' + u.toLowerCase();
const getAcc = async (u) => { const r = await kv(['GET', key(u)]); return r ? JSON.parse(r) : null; };
const putAcc = (a) => kv(['SET', key(a.u), JSON.stringify(a)]);
const prof = (a) => ({ u: a.u, admin: !!a.admin, data: a.data });

// Premium skin prices (must match the client: skins 64..189)
const PRP = [120, 150, 180, 220, 300, 260, 200, 240, 160, 170, 190, 280, 320, 250, 210, 330, 230, 140];
const SKINS = 190;
const priceOf = (i) => {
  if (i < 64 || i >= SKINS) return 0;
  if (i < 82) return PRP[i - 64];
  const n = i - 82, ei = Math.floor(n / 9), pi = n % 9;
  return 90 + ((ei * 9 + pi) % 14) * 25;
};

const num = (v, mx) => Math.max(0, Math.min(mx, Math.floor(+v || 0)));
function clean(d, old, adm, mul) {
  const o = Object.assign({ xp: 0, wins: 0, kills: 0, games: 0, tk: 0, own: [], skin: 0, lang: 'uk', gfx: 1, ctl: 'auto', vol: 0.6, mute: false }, old || {});
  if (!d || typeof d !== 'object') return o;
  const grow = (k, mx, step) => {
    if (d[k] === undefined) return;
    const v = num(d[k], mx);
    if (v >= o[k]) o[k] = Math.min(v, o[k] + step * mul);
  };
  grow('xp', 1e7, 4000); grow('wins', 1e6, 5); grow('kills', 1e6, 200); grow('games', 1e6, 5);
  if (d.lang === 'uk' || d.lang === 'en') o.lang = d.lang;
  if ([0, 1, 2].includes(+d.gfx)) o.gfx = +d.gfx;
  if (['auto', 'pc', 'touch'].includes(d.ctl)) o.ctl = d.ctl;
  if (isFinite(+d.vol)) o.vol = Math.max(0, Math.min(1, +d.vol));
  o.mute = !!d.mute;
  const sk = +d.skin;
  if (Number.isInteger(sk) && sk >= 0 && sk < SKINS && (sk < 64 || adm || o.own.includes(sk))) o.skin = sk;
  return o;
}
const cfgClean = (c) => {
  c = c || {};
  const f = (v, a, b, d) => (isFinite(+v) ? Math.max(a, Math.min(b, Math.round(+v))) : d);
  return { bf: f(c.bf, 0, 100, 12), bd: f(c.bd, 0, 100, 33), pd: f(c.pd, 0, 300, 100), hn: f(c.hn, 0, 100, 50), hst: c.hst ? 1 : 0, bots: f(c.bots, 1, 100, 11), hs: f(c.hs, 0, 40, 7) };
};

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!KV_URL || !KV_TOK) return res.status(200).json({ api: 0, e: 'kv' });
  try {
    if (req.method === 'GET') {
      const c = await kv(['GET', 'cfg:global']);
      return res.status(200).json({ api: 1, cfg: c ? JSON.parse(c) : null });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: 0 });
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
    b = b || {};
    const a = b.a;

    if (a === 'register' || a === 'login') {
      const u = String(b.u || ''), p = String(b.p || '');
      if (!/^[A-Za-z0-9_]{3,14}$/.test(u)) return res.json({ ok: 0, e: 'x' });
      if (p.length < 6 || p.length > 64) return res.json({ ok: 0, e: 'x' });
      if (a === 'register') {
        const isAdmin = u.toLowerCase() === ADMIN;
        const salt = crypto.randomBytes(16).toString('hex');
        const acc = { u, salt, ph: hash(p, salt), admin: isAdmin, data: clean(b.d, null, isAdmin, 50), created: Date.now() };
        const ok = await kv(['SET', key(u), JSON.stringify(acc), 'NX']);
        if (!ok) return res.json({ ok: 0, e: 'taken' });
        return res.json({ ok: 1, tok: mkToken(u), p: prof(acc) });
      }
      const rl = 'rl:' + u.toLowerCase();
      const n = await kv(['INCR', rl]);
      if (n === 1) await kv(['EXPIRE', rl, 600]);
      if (n > 8) return res.json({ ok: 0, e: 'rate' });
      const acc = await getAcc(u);
      if (!acc) return res.json({ ok: 0, e: 'bad' });
      const h = Buffer.from(hash(p, acc.salt)), s = Buffer.from(acc.ph);
      if (h.length !== s.length || !crypto.timingSafeEqual(h, s)) return res.json({ ok: 0, e: 'bad' });
      await kv(['DEL', rl]);
      return res.json({ ok: 1, tok: mkToken(acc.u), p: prof(acc) });
    }

    const user = who(b.t);
    if (!user) return res.json({ ok: 0, e: 'auth' });
    const acc = await getAcc(user);
    if (!acc) return res.json({ ok: 0, e: 'auth' });

    if (a === 'load') return res.json({ ok: 1, p: prof(acc) });

    if (a === 'save') {
      acc.data = clean(b.d, acc.data, acc.admin, 1);
      await putAcc(acc);
      return res.json({ ok: 1, p: prof(acc) });
    }

    if (a === 'buy') {
      const i = +b.i;
      if (!Number.isInteger(i) || i < 64 || i >= SKINS) return res.json({ ok: 0, e: 'x' });
      const d = acc.data;
      if (!acc.admin && !d.own.includes(i)) {
        const pr = priceOf(i);
        if (d.tk < pr) return res.json({ ok: 0, e: 'funds' });
        d.tk -= pr;
        d.own.push(i);
        await putAcc(acc);
      }
      return res.json({ ok: 1, p: prof(acc) });
    }

    if (a === 'grant') {
      if (!acc.admin) return res.json({ ok: 0, e: 'auth' });
      const n = Math.floor(+b.n);
      if (!(n >= 1 && n <= 1e6)) return res.json({ ok: 0, e: 'x' });
      const t = await getAcc(String(b.u || ''));
      if (!t) return res.json({ ok: 0, e: 'nouser' });
      t.data.tk = Math.min(1e7, (t.data.tk || 0) + n);
      await putAcc(t);
      return res.json({ ok: 1, p: prof(t.u.toLowerCase() === acc.u.toLowerCase() ? t : acc) });
    }

    if (a === 'setcfg') {
      if (!acc.admin) return res.json({ ok: 0, e: 'auth' });
      await kv(['SET', 'cfg:global', JSON.stringify(cfgClean(b.c))]);
      return res.json({ ok: 1 });
    }

    return res.json({ ok: 0, e: 'x' });
  } catch (e) {
    return res.status(200).json({ ok: 0, e: 'x' });
  }
};
