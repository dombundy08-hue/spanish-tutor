'use strict';
//
// Tests for the Spanish tutor page. Plain node, no network, no browser.
//   cd mission-email-system/spanish-tutor-web && node test/test-tutor-web.js
//
// The page is deliberately one file with no build step, so the harness pulls
// the <script> block out of index.html and runs it against a fake DOM. That
// keeps deployment to "copy one file" while still letting the logic be tested.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = HTML.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('No <script> block found in index.html'); process.exit(1); }
const SRC = m[1];

const KEY = 'sk-ant-api03-SECRETSECRETSECRET-do-not-leak';

// ---------- the smallest DOM that lets the page boot ----------
function node() {
  const n = {
    style: {}, className: '', textContent: '', innerHTML: '', value: '',
    scrollTop: 0, scrollHeight: 0, children: [],
    classList: { add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { n.children.push(c); return c; },
    remove() {}, addEventListener() {}, focus() {}, blur() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 0, height: 0 }; }
  };
  return n;
}

function makeEnv(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.store || {});
  const els = {};
  const env = {
    console,
    JSON, Math, Date, Promise, String, Number, Array, Object, Error, TypeError,
    setTimeout: (fn) => fn(),          // retries run instantly in tests
    clearTimeout: () => {},
    navigator: { userAgent: 'node', clipboard: null },
    localStorage: {
      getItem: k => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; }
    },
    document: {
      getElementById(id) { if (!els[id]) els[id] = node(); return els[id]; },
      createElement() { return node(); },
      body: node()
    },
    alert() {}, confirm() { return false; }, prompt() { return null; },
    fetch: opts.fetch || (() => Promise.reject(new TypeError('no fetch in test'))),
    __store: store, __els: els
  };
  env.window = env;
  env.globalThis = env;
  const ctx = vm.createContext(env);
  vm.runInContext(SRC, ctx, { filename: 'index.html' });
  return { env, ctx, store, els };
}

// Boots the page with NO key, so it does not fire its opening greeting, then
// installs the key afterwards. That keeps the fetch call count in a test equal
// to what the test itself asked for. Use makeEnv directly to test boot itself.
function world(opts) {
  opts = opts || {};
  const w = makeEnv(Object.assign({}, opts, { store: Object.assign({}, opts.store) }));
  w.store.anthropicKey = KEY;
  return w;
}

// A fetch fake that hands out scripted responses and records every call.
function fetcher(list) {
  const calls = [];
  let i = 0;
  const f = (url, init) => {
    calls.push({ url, init });
    const r = list[Math.min(i++, list.length - 1)];
    if (r.networkError) return Promise.reject(new TypeError('Failed to fetch'));
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: () => Promise.resolve(r.body)
    });
  };
  f.calls = calls;
  return f;
}
const reply = text => ({ status: 200, body: { content: [{ type: 'text', text }] } });

const GOOD = [
  '<<<ES>>>', 'Hola, élder. ¿Cómo está usted?',
  '<<<EN>>>', 'I asked how you are.',
  '<<<META>>>', '{"correction":"yo soy bien -> yo estoy bien","new_words":["hoy"],"level":1,"checkpoint":"","passed":false}'
].join('\n');

// ---------- runner ----------
const results = [];
function test(name, fn) {
  try { const r = fn(); if (r && r.then) return r.then(() => results.push({ name, pass: true }), e => results.push({ name, pass: false, why: e.message }));
        results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, why: e.message }); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error((m || 'not equal') + ' — got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b)); }

const queue = [];
function atest(name, fn) { queue.push({ name, fn }); }

// ---------- parsing ----------
test('1. A three-block reply splits into Spanish, English and meta', () => {
  const { ctx } = world();
  const r = ctx.parseReply(GOOD);
  eq(r.es, 'Hola, élder. ¿Cómo está usted?');
  eq(r.en, 'I asked how you are.');
  eq(r.meta.new_words[0], 'hoy');
});

test('2. A reply with no markers is still shown, not swallowed', () => {
  const { ctx } = world();
  const r = ctx.parseReply('Buenos días, ¿cómo amaneció?');
  eq(r.es, 'Buenos días, ¿cómo amaneció?');
  eq(r.en, '');
});

test('3. Broken JSON in the meta block degrades to empty instead of throwing', () => {
  const { ctx } = world();
  const r = ctx.parseReply('<<<ES>>>\nHola\n<<<META>>>\n{nope,,,');
  eq(r.es, 'Hola');
  eq(Object.keys(r.meta).length, 0);
});

test('4. An empty English block does not leak the META marker into it', () => {
  const { ctx } = world();
  eq(ctx.parseReply('<<<ES>>>\nHola\n<<<EN>>>\n\n<<<META>>>\n{}').en, '');
});

// ---------- the prompt ----------
test('5. The prompt carries level rules, missed words and repeated errors', () => {
  const { ctx } = world();
  ctx.profile.level = 3;
  ctx.profile.misses = ['sartén', 'cobija'];
  ctx.profile.errors = ['ser vs estar'];
  const s = ctx.systemPrompt(3, 'es');
  assert(s.indexOf('preterite') > -1, 'level 3 rules missing');
  assert(s.indexOf('sartén') > -1, 'missed words missing');
  assert(s.indexOf('ser vs estar') > -1, 'repeat errors missing');
  assert(s.indexOf('ustedes') > -1, 'should pin Latin American Spanish');
  assert(s.toLowerCase().indexOf('microphone') > -1, 'should warn about transcription noise');
});

test('6. Asking for English is passed into the prompt', () => {
  const { ctx } = world();
  assert(ctx.systemPrompt(1, 'en').indexOf('ASKED FOR ENGLISH') > -1);
});

// ---------- levelling ----------
test('7. A jump to level 5 only moves him up one step', () => {
  const { ctx } = world();
  ctx.profile.level = 1;
  ctx.onReply({ es: 'hola', en: '', meta: { level: 5 } });
  eq(ctx.profile.level, 2, 'must never skip levels');
});

test('8. A drop also moves one step, and resets the turn counter', () => {
  const { ctx } = world();
  ctx.profile.level = 4; ctx.profile.turnsAtLevel = 9;
  ctx.onReply({ es: 'hola', en: '', meta: { level: 1 } });
  eq(ctx.profile.level, 3);
  eq(ctx.profile.turnsAtLevel, 0);
});

test('9. Staying at the same level increments the turn counter', () => {
  const { ctx } = world();
  ctx.profile.level = 2; ctx.profile.turnsAtLevel = 3;
  ctx.onReply({ es: 'hola', en: '', meta: { level: 2 } });
  eq(ctx.profile.level, 2);
  eq(ctx.profile.turnsAtLevel, 4);
});

test('10. New words are collected without duplicates', () => {
  const { ctx } = world();
  ctx.profile.misses = [];
  ctx.onReply({ es: 'a', en: '', meta: { new_words: ['hoy', 'Hoy', 'ayer'] } });
  eq(ctx.profile.misses.length, 2, 'should have deduped case-insensitively');
});

test('11. The word and error lists are capped so the prompt cannot grow forever', () => {
  const { ctx } = world();
  ctx.profile.misses = []; ctx.profile.errors = [];
  for (let i = 0; i < 200; i++) ctx.onReply({ es: 'a', en: '', meta: { new_words: ['w' + i], correction: 'e' + i } });
  assert(ctx.profile.misses.length <= 120, 'misses grew to ' + ctx.profile.misses.length);
  assert(ctx.profile.errors.length <= 60, 'errors grew to ' + ctx.profile.errors.length);
});

test('12. Passing a checkpoint is recorded', () => {
  const { ctx } = world();
  ctx.pendingCheckpoint = 'Cuéntame de tu familia';
  ctx.profile.checkpoints = [];
  ctx.onReply({ es: 'a', en: '', meta: { passed: true, level: 1 } });
  eq(ctx.profile.checkpoints.length, 1);
});

// ---------- daily guard ----------
test('13. The daily cap blocks once the limit is reached', () => {
  const { ctx, store } = world();
  const d = new Date();
  store.tutorDaily = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + '|' + ctx.DAILY_CAP;
  eq(ctx.underCap(), false);
});

test('14. Yesterday\'s count does not lock him out today', () => {
  const { ctx, store } = world();
  store.tutorDaily = '2020-1-1|9999';
  eq(ctx.underCap(), true);
});

test('15. Each bump increments today\'s counter', () => {
  const { ctx, store } = world();
  ctx.bumpCap(); ctx.bumpCap();
  eq(store.tutorDaily.split('|')[1], '2');
});

// ---------- the network call ----------
atest('16. The request carries the key, the version and the browser opt-in', async () => {
  const f = fetcher([reply(GOOD)]);
  const { ctx } = world({ fetch: f });
  await ctx.ask('sys', [{ role: 'user', content: 'hola' }]);
  const h = f.calls[0].init.headers;
  eq(h['x-api-key'], KEY);
  eq(h['anthropic-version'], '2023-06-01');
  eq(h['anthropic-dangerous-direct-browser-access'], 'true');
  eq(f.calls[0].init.method, 'POST');
  const sent = JSON.parse(f.calls[0].init.body);
  eq(sent.model, ctx.MODEL);
  assert(sent.max_tokens > 0);
});

atest('17. The key is never put in the URL', async () => {
  const f = fetcher([reply(GOOD)]);
  const { ctx } = world({ fetch: f });
  await ctx.ask('sys', [{ role: 'user', content: 'hola' }]);
  eq(f.calls[0].url.indexOf(KEY), -1, 'THE KEY LEAKED INTO THE URL');
  eq(f.calls[0].url, 'https://api.anthropic.com/v1/messages');
});

atest('18. A 401 fails immediately with a readable message and is not retried', async () => {
  const f = fetcher([{ status: 401, body: {} }]);
  const { ctx } = world({ fetch: f });
  let msg = '';
  await ctx.ask('sys', [{ role: 'user', content: 'x' }]).catch(e => { msg = e.message; });
  eq(f.calls.length, 1, 'a bad key will not fix itself');
  assert(msg.indexOf('rechazada') > -1, 'should say it was refused: ' + msg);
});

atest('19. A 500 is retried three times, then gives up politely', async () => {
  const f = fetcher([{ status: 500, body: {} }]);
  const { ctx } = world({ fetch: f });
  let msg = '';
  await ctx.ask('sys', [{ role: 'user', content: 'x' }]).catch(e => { msg = e.message; });
  eq(f.calls.length, 3);
  assert(msg.indexOf('otra vez') > -1, 'should invite a retry: ' + msg);
});

atest('20. A dropped connection retries, then says so in plain Spanish', async () => {
  const f = fetcher([{ networkError: true }]);
  const { ctx } = world({ fetch: f });
  let msg = '';
  await ctx.ask('sys', [{ role: 'user', content: 'x' }]).catch(e => { msg = e.message; });
  eq(f.calls.length, 3);
  assert(msg.indexOf('Sin conexión') > -1, 'should name the connection: ' + msg);
});

atest('21. A blip on the first try is rescued by the retry', async () => {
  const f = fetcher([{ status: 503, body: {} }, reply(GOOD)]);
  const { ctx } = world({ fetch: f });
  const text = await ctx.ask('sys', [{ role: 'user', content: 'x' }]);
  eq(f.calls.length, 2);
  assert(text.indexOf('élder') > -1);
});

atest('22. An empty content array is retried rather than shown as silence', async () => {
  const f = fetcher([{ status: 200, body: { content: [] } }, reply(GOOD)]);
  const { ctx } = world({ fetch: f });
  const text = await ctx.ask('sys', [{ role: 'user', content: 'x' }]);
  assert(text.length > 0);
  eq(f.calls.length, 2);
});

// ---------- setup gate ----------
test('23. With no key saved, the setup sheet is shown instead of calling out', () => {
  const { ctx, els } = makeEnv({ store: {} });
  eq(els.setup.style.display, 'block', 'setup sheet should be open');
});

atest('24. Booting with a key fires the opening greeting instead of sitting silent', async () => {
  // This is the bug the Apps Script version shipped with: send('') was treated
  // as an empty message and dropped, so the page loaded and never said hello.
  const f = fetcher([reply(GOOD)]);
  const { els } = makeEnv({ store: { anthropicKey: KEY }, fetch: f });
  await new Promise(r => setImmediate(r));
  eq(f.calls.length, 1, 'the page must greet him on load');
  // If the sheet was never even looked up, it was never opened - also correct.
  assert(!els.setup || els.setup.style.display !== 'block', 'setup sheet should stay closed');
});

// ---------- report ----------
(async () => {
  for (const t of queue) {
    try { await t.fn(); results.push({ name: t.name, pass: true }); }
    catch (e) { results.push({ name: t.name, pass: false, why: e.message }); }
  }
  results.sort((a, b) => parseInt(a.name) - parseInt(b.name));
  const pass = results.filter(r => r.pass).length;
  results.forEach(r => console.log((r.pass ? 'PASS  ' : 'FAIL  ') + r.name + (r.pass ? '' : '\n        ' + r.why)));
  console.log('\n' + pass + ' / ' + results.length + ' passed');
  process.exit(pass === results.length ? 0 : 1);
})();
