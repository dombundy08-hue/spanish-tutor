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
    setInterval: () => 1,              // the conversation clock is driven by hand
    clearInterval: () => {},
    // Enough of a microphone and a voice for the page to boot and run a turn.
    SpeechRecognition: function () { this.start = () => {}; this.stop = () => {}; },
    speechSynthesis: {
      speaking: false, spoken: [], autoEnd: true, pending: [],
      cancel() { this.pending.length = 0; },
      getVoices() { return opts.voices || []; },
      speak(u) {
        this.spoken.push({ text: u.text, lang: u.lang, rate: u.rate,
                           voice: u.voice ? u.voice.voiceURI : null });
        if (this.autoEnd) { if (u.onend) u.onend(); }
        else this.pending.push(u);
      }
    },
    SpeechSynthesisUtterance: function (t) { this.text = t; },
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
  '<<<AYUDA>>>', '[es]Casi.[/es] [en]Use estar for feelings.[/en] [es]Yo estoy bien.[/es]',
  '<<<META>>>', '{"new_words":["hoy"],"error_note":"ser instead of estar","level":1,"checkpoint":"","passed":false}'
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
  assert(r.en.indexOf('[en]') > -1, 'the clarification keeps its language tags');
  eq(r.meta.error_note, 'ser instead of estar');
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

test('4. An empty clarification block does not leak the META marker into it', () => {
  const { ctx } = world();
  eq(ctx.parseReply('<<<ES>>>\nHola\n<<<AYUDA>>>\n\n<<<META>>>\n{}').en, '');
});

// ---------- the prompt ----------
test('5. The prompt carries level rules, missed words and repeated errors', () => {
  const { ctx } = world();
  ctx.profile.level = 3;
  ctx.profile.misses = ['sartén', 'cobija'];
  ctx.profile.errors = ['ser vs estar'];
  const s = ctx.systemPrompt(3, 'es');
  assert(s.toLowerCase().indexOf('preterite') > -1, 'level 3 description missing');
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
  for (let i = 0; i < 200; i++) ctx.onReply({ es: 'a', en: '', meta: { new_words: ['w' + i], error_note: 'e' + i } });
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

atest('24. Loading does not call out on its own - it waits for the talk button', async () => {
  const f = fetcher([reply(GOOD)]);
  makeEnv({ store: { anthropicKey: KEY }, fetch: f });
  await new Promise(r => setImmediate(r));
  eq(f.calls.length, 0, 'the page must not start talking before he asks it to');
});

atest('24b. Tapping talk greets him instead of sitting in silence', async () => {
  // The Apps Script build shipped with this broken: send('') was treated as an
  // empty message and dropped, so it opened and never said hello.
  const f = fetcher([reply(GOOD)]);
  const { ctx } = makeEnv({ store: { anthropicKey: KEY }, fetch: f });
  ctx.convStart();
  await new Promise(r => setImmediate(r));
  eq(f.calls.length, 1, 'starting a conversation must produce the opening greeting');
});

atest('24c. Tapping talk with no key asks for the key rather than failing', async () => {
  const f = fetcher([reply(GOOD)]);
  const { ctx, els } = makeEnv({ store: {}, fetch: f });
  ctx.convStart();
  await new Promise(r => setImmediate(r));
  eq(f.calls.length, 0);
  eq(els.setup.style.display, 'block');
});

test('25. No top-level name collides with a read-only browser global', () => {
  // The page shipped once with `var history = []`. In a browser window.history
  // is a getter-only own property, so in strict mode that assignment throws and
  // every line below it silently never runs - no error, no output, a dead page.
  // Node's vm does NOT reproduce this (it redefines the property rather than
  // assigning to it), so running the code here would never have caught it.
  // Hence a static check: it is the only thing that would have.
  const RISKY = ['history','location','name','status','top','parent','self','length',
    'origin','closed','frames','event','external','screen','navigator','document',
    'window','performance','localStorage','sessionStorage','crypto','caches',
    'scrollX','scrollY','innerWidth','innerHeight','opener','frameElement'];
  const declared = new Set();
  SRC.split(/\r?\n/).forEach(line => {
    let m = line.match(/^var\s+(.+)$/);
    if (m) m[1].split(',').forEach(part => {
      const id = part.trim().split(/[=;\s]/)[0];
      if (/^[A-Za-z_$][\w$]*$/.test(id)) declared.add(id);
    });
    m = line.match(/^function\s+([A-Za-z_$][\w$]*)/);
    if (m) declared.add(m[1]);
  });
  assert(declared.size > 10, 'the scan found almost nothing - the regex is wrong, not the code');
  const clash = RISKY.filter(r => declared.has(r));
  eq(clash.join(','), '', 'these top-level names shadow browser globals and will kill the page');
});

test('26. The clock waits while the tutor is talking or thinking', () => {
  const { ctx } = world();
  const base = { heard: 'hola', quietMs: 99999, silenceMs: 2500, idleMs: 10000 };
  eq(ctx.decide(Object.assign({}, base, { speaking: true, thinking: false })), 'wait');
  eq(ctx.decide(Object.assign({}, base, { speaking: false, thinking: true })), 'wait');
});

test('27. It sends once he has stopped talking for long enough', () => {
  const { ctx } = world();
  eq(ctx.decide({ heard: 'tengo una pregunta', quietMs: 2600, silenceMs: 2500, idleMs: 10000, speaking: false, thinking: false }), 'send');
});

test('28. A pause shorter than the threshold does not cut him off mid-thought', () => {
  const { ctx } = world();
  eq(ctx.decide({ heard: 'yo creo que', quietMs: 1200, silenceMs: 2500, idleMs: 10000, speaking: false, thinking: false }), 'wait');
});

test('29. Saying nothing at all for the idle time makes the tutor speak first', () => {
  const { ctx } = world();
  eq(ctx.decide({ heard: '', quietMs: 10500, silenceMs: 2500, idleMs: 10000, speaking: false, thinking: false }), 'nudge');
});

test('30. A short silence is not treated as him being stuck', () => {
  const { ctx } = world();
  eq(ctx.decide({ heard: '', quietMs: 4000, silenceMs: 2500, idleMs: 10000, speaking: false, thinking: false }), 'wait');
});

test('31. Whitespace the recogniser emitted does not count as speech', () => {
  const { ctx } = world();
  eq(ctx.decide({ heard: '   ', quietMs: 11000, silenceMs: 2500, idleMs: 10000, speaking: false, thinking: false }), 'nudge',
     'blank audio should nudge, not send an empty turn');
});

test('32. The silence marker is explained to the model and never read aloud', () => {
  const { ctx } = world();
  const s = ctx.systemPrompt(1, 'es');
  assert(s.indexOf(ctx.NUDGE) > -1, 'the marker itself must appear in the prompt');
  assert(s.toLowerCase().indexOf('never read it out') > -1, 'must tell it not to speak the marker');
  assert(s.toLowerCase().indexOf('spoken out loud') > -1, 'must say this is speech, not text');
});

test('33. The idle wait defaults to 8 seconds', () => {
  const { ctx } = world();
  eq(ctx.profile.idleSec, 8);
  eq(ctx.decide({ heard: '', quietMs: 8100, silenceMs: 2500, idleMs: ctx.profile.idleSec * 1000,
                  speaking: false, thinking: false }), 'nudge');
});

test('34. A profile still on the old 10s default is moved to 8', () => {
  const old = JSON.stringify({ level: 3, idleSec: 10, misses: ['cobija'] });
  const { ctx, store } = makeEnv({ store: { tutorProfile: old } });
  eq(ctx.profile.idleSec, 8, 'should have been migrated');
  eq(ctx.profile.level, 3, 'the rest of his progress must survive');
  eq(JSON.parse(store.tutorProfile).idleSec, 8, 'and be written back');
});

test('35. A wait he chose himself is left alone', () => {
  const old = JSON.stringify({ level: 1, idleSec: 20 });
  const { ctx } = makeEnv({ store: { tutorProfile: old } });
  eq(ctx.profile.idleSec, 20, 'never override a deliberate setting');
});

test('36. The migration runs once, so a later change to 10 sticks', () => {
  const chose10 = JSON.stringify({ level: 1, idleSec: 10, settingsV: 2 });
  const { ctx } = makeEnv({ store: { tutorProfile: chose10 } });
  eq(ctx.profile.idleSec, 10, 'already-migrated profiles must not be touched again');
});

test('37. Faster raises the speaking rate and stops at the slider maximum', () => {
  const { ctx } = world();
  ctx.profile.rate = 0.8;
  ctx.document.getElementById('bFast').onclick();
  eq(Number(ctx.profile.rate.toFixed(2)), 0.9);
  for (let i = 0; i < 12; i++) ctx.document.getElementById('bFast').onclick();
  assert(ctx.profile.rate <= 1.2, 'ran past the maximum: ' + ctx.profile.rate);
});

test('38. Slower still works and stops at the minimum', () => {
  const { ctx } = world();
  ctx.profile.rate = 0.6;
  ctx.document.getElementById('bSlow').onclick();
  assert(ctx.profile.rate >= 0.5, 'went below the minimum: ' + ctx.profile.rate);
  for (let i = 0; i < 12; i++) ctx.document.getElementById('bSlow').onclick();
  eq(Number(ctx.profile.rate.toFixed(2)), 0.5);
});

test('39. The Spanish answer comes first, then the clarification', () => {
  const { ctx, env } = world();
  env.speechSynthesis.spoken.length = 0;
  ctx.speakReply({ es: 'Muy bien. ¿Y tu compañero?',
                   en: '[es]Casi.[/es] [en]Use estar for feelings.[/en] [es]Yo estoy bien.[/es]' });
  const said = env.speechSynthesis.spoken.map(x => x.text);
  eq(said.length, 4, 'reply plus three switched stretches');
  eq(said[0], 'Muy bien. ¿Y tu compañero?', 'he answers the conversation first');
  eq(said[1], 'Casi.');
  eq(said[2], 'Use estar for feelings.');
  eq(said[3], 'Yo estoy bien.');
});

test('40. Each stretch is spoken in its own language, not one accent throughout', () => {
  const { ctx, env } = world();
  env.speechSynthesis.spoken.length = 0;
  ctx.speakReply({ es: 'Hola', en: '[es]Dijiste mal.[/es] [en]It should be estar.[/en] [es]Otra vez.[/es]' });
  const langs = env.speechSynthesis.spoken.map(x => x.lang.slice(0, 2).toLowerCase());
  eq(langs.join(','), 'es,es,en,es', 'a Spanish voice reading English is useless');
});

test('41. English is read at native speed even when Spanish is slowed right down', () => {
  const { ctx, env } = world();
  ctx.profile.rate = 0.5;
  env.speechSynthesis.spoken.length = 0;
  ctx.speakReply({ es: 'Hola', en: '[en]It should be estar.[/en]' });
  eq(env.speechSynthesis.spoken[0].rate, 0.5, 'Spanish keeps his chosen rate');
  eq(env.speechSynthesis.spoken[1].rate, 1.0, 'English should not crawl - it is his own language');
});

test('42. An ordinary reply with no clarification says only the Spanish', () => {
  const { ctx, env } = world();
  env.speechSynthesis.spoken.length = 0;
  ctx.speakReply({ es: 'Muy bien, élder.', en: '' });
  eq(env.speechSynthesis.spoken.length, 1, 'it must not explain things he got right');
});

test('43. Interrupting stops the whole thing, it does not skip to the next stretch', () => {
  // cancel() drops the queue, but a naive chain would fire onend and carry on.
  const { ctx, env } = world();
  env.speechSynthesis.autoEnd = false;
  env.speechSynthesis.spoken.length = 0;
  ctx.speakReply({ es: 'Primera', en: '[en]Second[/en]' });
  eq(env.speechSynthesis.spoken.length, 1, 'only the first stretch should have started');
  const u = env.speechSynthesis.pending[0];
  assert(u && u.onend, 'the in-flight utterance should carry an onend handler');
  ctx.cancelSpeak();
  u.onend();
  eq(env.speechSynthesis.spoken.length, 1, 'nothing may start after a cancel');
});

test('44. Repeat replays the whole thing, clarification included', () => {
  const { ctx, env } = world();
  ctx.speakReply({ es: 'Hola', en: '[en]Hello.[/en]' });
  env.speechSynthesis.spoken.length = 0;
  ctx.replayLast();
  eq(env.speechSynthesis.spoken.length, 2);
});

test('45. Untagged help is treated as Spanish rather than read in an English voice', () => {
  const { ctx } = world();
  const segs = ctx.segments('Se dice yo estoy bien.');
  eq(segs.length, 1);
  eq(segs[0].lang, 'es');
});

test('46. Closing tags never end up being read out', () => {
  const { ctx, env } = world();
  env.speechSynthesis.spoken.length = 0;
  ctx.speakReply({ es: 'Hola', en: '[es]Casi.[/es] [en]Use estar.[/en]' });
  env.speechSynthesis.spoken.forEach(x => {
    assert(x.text.indexOf('[') === -1, 'a tag leaked into speech: ' + x.text);
  });
});

test('47. The written version of the clarification has the tags stripped out', () => {
  const { ctx } = world();
  eq(ctx.stripTags('[es]Casi.[/es] [en]Use estar.[/en]'), 'Casi. Use estar.');
});

test('48. The prompt makes silence the normal case, not correcting', () => {
  const { ctx } = world();
  const p = ctx.systemPrompt(1, 'es');
  assert(p.indexOf('LEAVE THIS COMPLETELY EMPTY') > -1, 'must default to saying nothing');
  assert(p.indexOf('Silence is the normal case') > -1, 'restraint must be the stated default');
  assert(p.indexOf('BEING A BEGINNER IS NOT A MISTAKE') > -1, 'must tell it to let beginner errors go');
  assert(p.toLowerCase().indexOf('not a teacher marking his work') > -1, 'must set the role');
  assert(p.indexOf('Just say hello') > -1, 'the opening should be a greeting, not a lesson');
  assert(p.toLowerCase().indexOf('when he is stuck') > -1, 'must say how to carry him when he dries up');
  assert(p.indexOf('NOT a list to correct him on') === -1 || p.indexOf('background') > -1,
         'remembered errors must not read as a to-do list');
});

test('49. The prompt teaches the code-switching and how to tag it', () => {
  const { ctx } = world();
  const p = ctx.systemPrompt(1, 'es');
  assert(p.indexOf('SWITCH BACK AND FORTH') > -1, 'must ask it to move between languages');
  assert(p.indexOf('[es]') > -1 && p.indexOf('[en]') > -1, 'must show the tags');
  assert(p.indexOf('Casi.') > -1, 'a worked example makes this far more reliable');
});

test('50. The Spanish is told to sound like a person, not a drill', () => {
  const { ctx } = world();
  const p = ctx.systemPrompt(1, 'es');
  assert(p.indexOf('SOUND LIKE A REAL PERSON') > -1);
  assert(p.indexOf('not a word limit') > -1, 'the level must not be read as a word count');
  assert(!/[0-9]-[0-9] words per sentence/.test(p), 'the old word-count rule is what made it robotic');
});

test('51. Only a real mistake is remembered, not every explanation', () => {
  const { ctx } = world();
  ctx.profile.errors = [];
  ctx.onReply({ es: 'a', en: '[es]Cobija[/es] [en]means blanket.[/en]', meta: { level: 1 } });
  eq(ctx.profile.errors.length, 0, 'asking what a word means is not a mistake');
  ctx.onReply({ es: 'a', en: '[en]Use estar.[/en]', meta: { level: 1, error_note: 'ser instead of estar' } });
  eq(ctx.profile.errors.length, 1);
  eq(ctx.profile.errors[0], 'ser instead of estar');
});

test('52. It does not correct him in the opening turns of a conversation', () => {
  const { ctx } = world();
  const help = '[en]You meant estar.[/en]';
  for (let i = 0; i < ctx.HELP_GRACE; i++) {
    const r = { es: 'hola', en: help, meta: { level: 1 } };
    ctx.onReply(r);
    eq(r.en, '', 'turn ' + (i + 1) + ' should have let it go');
  }
});

test('53. After the grace period it corrects once, then goes quiet again', () => {
  const { ctx } = world();
  const help = '[en]You meant estar.[/en]';
  const kept = [];
  for (let i = 0; i < 12; i++) {
    const r = { es: 'hola', en: help, meta: { level: 1 } };
    ctx.onReply(r);
    if (r.en) kept.push(i + 1);
  }
  assert(kept.length <= 3, 'corrected ' + kept.length + ' times in 12 turns: ' + kept.join(','));
  assert(kept.length >= 1, 'it should still correct sometimes');
  for (let i = 1; i < kept.length; i++) {
    assert(kept[i] - kept[i - 1] >= ctx.HELP_COOLDOWN,
      'corrections only ' + (kept[i] - kept[i - 1]) + ' turns apart');
  }
});

test('54. Asking for help always gets through, cooldown or not', () => {
  const { ctx } = world();
  const help = '[es]Cobija[/es] [en]means blanket.[/en]';
  for (let i = 0; i < 6; i++) {
    const r = { es: 'hola', en: help, meta: { level: 1, asked: true } };
    ctx.onReply(r);
    eq(r.en, help, 'turn ' + (i + 1) + ' - he asked, so it must answer');
  }
});

test('55. Tapping the English button also always gets through', () => {
  const { ctx } = world();
  const help = '[en]Here is what that meant.[/en]';
  const r = { es: 'hola', en: help, meta: { level: 1 } };
  ctx.onReply(r, 'en');
  eq(r.en, help, 'an explicit request must never be swallowed by the budget');
});

test('56. A suppressed correction is still remembered quietly', () => {
  const { ctx } = world();
  ctx.profile.errors = [];
  const r = { es: 'hola', en: '[en]estar[/en]', meta: { level: 1, error_note: 'ser instead of estar' } };
  ctx.onReply(r);
  eq(r.en, '', 'not said out loud during the grace period');
  eq(ctx.profile.errors.length, 1, 'but still noted, so it can weave the right form in later');
});

test('57. A spoken question gets both Spanish question marks', () => {
  const { ctx } = world();
  eq(ctx.punctuate([{ text: 'como esta usted hoy', at: 0 }]), '¿Cómo esta usted hoy?');
});

test('58. A statement gets a full stop, not a question mark', () => {
  const { ctx } = world();
  eq(ctx.punctuate([{ text: 'me llamo elder bundy', at: 0 }]), 'Me llamo elder bundy.');
});

test('59. The accent is restored on a leading interrogative', () => {
  const { ctx } = world();
  // The recogniser drops accents, and they are inaudible, so putting them back
  // cannot hide a mistake he actually made out loud.
  eq(ctx.punctuate([{ text: 'que significa cobija', at: 0 }]), '¿Qué significa cobija?');
  eq(ctx.punctuate([{ text: 'donde vive usted', at: 0 }]), '¿Dónde vive usted?');
  eq(ctx.punctuate([{ text: 'cuando podemos regresar', at: 0 }]), '¿Cuándo podemos regresar?');
});

test('60. One final result is one sentence; a joining word continues the last', () => {
  const { ctx } = world();
  // Timing is no longer used at all - the timestamps below are identical and
  // the grouping still comes out right.
  eq(ctx.punctuate([{ text: 'yo vivo en atlanta', at: 0 }, { text: 'con mi companero', at: 0 }]),
     'Yo vivo en atlanta con mi companero.');
  eq(ctx.punctuate([{ text: 'fui a la iglesia', at: 0 }, { text: 'pero llegue tarde', at: 0 }]),
     'Fui a la iglesia, pero llegue tarde.');
  eq(ctx.punctuate([{ text: 'hola', at: 0 }, { text: 'me llamo elder bundy', at: 0 }]),
     'Hola. Me llamo elder bundy.');
});

test('60b. A joining word never swallows a question', () => {
  const { ctx } = world();
  // "que" joins clauses, but "que significa cobija" is a question in its own
  // right and must not be glued onto the greeting before it.
  eq(ctx.punctuate([{ text: 'hola', at: 0 }, { text: 'que significa cobija', at: 0 }]),
     'Hola. ¿Qué significa cobija?');
});

test('61. A yes/no question opener is caught too', () => {
  const { ctx } = world();
  eq(ctx.punctuate([{ text: 'puede repetir por favor', at: 0 }]), '¿Puede repetir por favor?');
  eq(ctx.punctuate([{ text: 'tiene unos minutos', at: 0 }]), '¿Tiene unos minutos?');
});

test('62. A tag question gets its comma and its marks', () => {
  const { ctx } = world();
  eq(ctx.punctuate([{ text: 'esta bien verdad', at: 0 }]), '¿Esta bien, verdad?');
});

test('63. Common exclamations are not turned into questions', () => {
  const { ctx } = world();
  eq(ctx.punctuate([{ text: 'que padre', at: 0 }]), '¡Qué padre!');
  eq(ctx.punctuate([{ text: 'que bueno', at: 0 }]), '¡Qué bueno!');
});

test('64. Statements that merely start with a verb are left alone', () => {
  const { ctx } = world();
  // Over-marking a statement as a question is worse than missing one, so the
  // opener list is deliberately tight.
  eq(ctx.punctuate([{ text: 'me gusta la comida', at: 0 }]), 'Me gusta la comida.');
  eq(ctx.punctuate([{ text: 'vivo en georgia', at: 0 }]), 'Vivo en georgia.');
  eq(ctx.punctuate([{ text: 'es un buen dia', at: 0 }]), 'Es un buen dia.');
});

test('65. Empty or blank audio produces nothing at all', () => {
  const { ctx } = world();
  eq(ctx.punctuate([]), '');
  eq(ctx.punctuate([{ text: '   ', at: 0 }]), '');
  eq(ctx.punctuate(null), '');
});

test('66. Punctuation the recogniser already supplied is not doubled up', () => {
  const { ctx } = world();
  eq(ctx.punctuate([{ text: 'hola.', at: 0 }]), 'Hola.');
  eq(ctx.punctuate([{ text: 'como estas?', at: 0 }]), '¿Cómo estas?');
});

test('67. The model is told the punctuation is machine-added and not his', () => {
  const { ctx } = world();
  const p = ctx.systemPrompt(1, 'es');
  assert(p.indexOf('ADDED BY A PROGRAM ON HIS PHONE') > -1);
  assert(p.toLowerCase().indexOf('never correct his punctuation') > -1);
});

atest('68. The turn that actually reaches the model is the punctuated one', async () => {
  // The engine being right is no use if the raw text is what gets sent.
  const f = fetcher([reply(GOOD)]);
  const { ctx } = world({ fetch: f });
  ctx.conv.on = true;
  ctx.conv.heard = 'como esta usted';
  ctx.conv.chunks = [{ text: 'como esta usted', at: 0 }];
  ctx.conv.lastVoiceAt = Date.now() - 999999;      // long since stopped talking
  ctx.loop();
  await new Promise(r => setImmediate(r));
  eq(f.calls.length, 1, 'the clock should have sent the turn');
  const sent = JSON.parse(f.calls[0].init.body);
  const last = sent.messages[sent.messages.length - 1].content;
  eq(last, '¿Cómo esta usted?');
});

test('69. Words that are both question words and connectors are judged by what follows', () => {
  const { ctx } = world();
  // This was the main source of question marks landing at random.
  eq(ctx.punctuate([{ text: 'como esta usted hoy', at: 0 }]), '¿Cómo esta usted hoy?');
  eq(ctx.punctuate([{ text: 'como se dice blanket', at: 0 }]), '¿Cómo se dice blanket?');
  eq(ctx.punctuate([{ text: 'como siempre llego tarde', at: 0 }]), 'Como siempre llego tarde.');
  eq(ctx.punctuate([{ text: 'cuando era nino vivia alli', at: 0 }]), 'Cuando era nino vivia alli.');
});

test('70. "porque" is because, not "por que"', () => {
  const { ctx } = world();
  eq(ctx.punctuate([{ text: 'porque me gusta mucho', at: 0 }]), 'Porque me gusta mucho.');
  eq(ctx.punctuate([{ text: 'por que me gusta', at: 0 }]), '¿Por que me gusta?');
});

test('71. A bare "no" on the end is no longer treated as a tag question', () => {
  const { ctx } = world();
  eq(ctx.punctuate([{ text: 'creo que no', at: 0 }]), 'Creo que no.');
  eq(ctx.punctuate([{ text: 'esta bien verdad', at: 0 }]), '¿Esta bien, verdad?');
});

test('72. "esta bien" on its own is someone saying it is fine', () => {
  const { ctx } = world();
  eq(ctx.punctuate([{ text: 'esta bien', at: 0 }]), 'Esta bien.');
  eq(ctx.punctuate([{ text: 'esta bien la comida', at: 0 }]), 'Esta bien la comida.');
});

test('73. Short low-confidence fragments are dropped as noise', () => {
  const { ctx } = world();
  eq(ctx.acceptFinal('eh', 0.2), false, 'a mumble should not become a turn');
  eq(ctx.acceptFinal('si', 0.9), true, 'a confident short word is real');
  eq(ctx.acceptFinal('no entiendo nada de eso', 0.2), true, 'a long phrase is kept even if unsure');
  eq(ctx.acceptFinal('eh', 0), true, 'Chrome reports 0 when it has no score - do not guess');
  eq(ctx.acceptFinal('   ', 0.9), false);
});

test('74. The same phrase coming straight back is treated as an echo', () => {
  const { ctx } = world();
  const chunks = [{ text: 'como estas', at: 1000 }];
  eq(ctx.isEcho(chunks, 'como estas', 1400), true, 'the speaker hearing itself');
  eq(ctx.isEcho(chunks, 'Como estas.', 1400), true, 'punctuation and case do not make it new');
  eq(ctx.isEcho(chunks, 'como estas', 5000), false, 'saying it again later is deliberate');
  eq(ctx.isEcho(chunks, 'muy bien', 1400), false);
  eq(ctx.isEcho([], 'hola', 1000), false);
});

function lastBubble(ctx) {
  const log = ctx.document.getElementById('log');
  const turn = log.children[log.children.length - 1];
  return turn.children[0];
}

test('75. Subtitles are off to begin with, but the text is already in the bubble', () => {
  const { ctx, env } = world();
  eq(ctx.profile.showText, false);
  eq(env.document.body.className, '', 'nothing should be revealed yet');
  ctx.addTutor({ es: 'Hola, \u00e9lder.', en: '', meta: {} });
  const kids = lastBubble(ctx).children;
  const text = kids.filter(c => String(c.className).indexOf('es-text') > -1)[0];
  const dots = kids.filter(c => String(c.className).indexOf('es-dots') > -1)[0];
  assert(text, 'the real line must be in the DOM even while hidden');
  eq(text.textContent, 'Hola, \u00e9lder.', 'otherwise it cannot be revealed later');
  assert(dots, 'and a placeholder shown in its place');
});

test('76. One tap reveals every message, not just the newest', () => {
  const { ctx, env } = world();
  ctx.addTutor({ es: 'Primero', en: '', meta: {} });
  ctx.addTutor({ es: 'Segundo', en: '', meta: {} });
  ctx.document.getElementById('bSubs').onclick();
  eq(env.document.body.className, 'subs', 'the switch is on <body>, so it covers the whole log');
  eq(ctx.profile.showText, true);
  // Both bubbles still hold their own text, so both are revealed by that class.
  const log = ctx.document.getElementById('log');
  const shown = log.children.map(t => t.children[0].children
    .filter(c => String(c.className).indexOf('es-text') > -1)[0].textContent);
  eq(shown.join(','), 'Primero,Segundo');
});

test('77. A reply that arrives after the toggle is revealed too', () => {
  const { ctx, env } = world();
  ctx.document.getElementById('bSubs').onclick();
  ctx.addTutor({ es: 'Tercero', en: '', meta: {} });
  eq(env.document.body.className, 'subs', 'new bubbles must not switch it back off');
  const kids = lastBubble(ctx).children;
  eq(kids.filter(c => String(c.className).indexOf('es-text') > -1)[0].textContent, 'Tercero');
});

test('78. Tapping again hides everything and the choice is remembered', () => {
  const { ctx, env, store } = world();
  const b = ctx.document.getElementById('bSubs');
  b.onclick();
  b.onclick();
  eq(env.document.body.className, '', 'back to hidden');
  eq(ctx.profile.showText, false);
  eq(JSON.parse(store.tutorProfile).showText, false, 'and written down');
});

test('79. The button says what tapping it will do', () => {
  const { ctx } = world();
  const b = ctx.document.getElementById('bSubs');
  assert(b.innerHTML.indexOf('Ver texto') > -1, 'offers to show: ' + b.innerHTML);
  b.onclick();
  assert(b.innerHTML.indexOf('Ocultar texto') > -1, 'offers to hide: ' + b.innerHTML);
});

test('80. A saved preference is applied on load, before anything is said', () => {
  const { env } = makeEnv({ store: { tutorProfile: JSON.stringify({ level: 1, showText: true }) } });
  eq(env.document.body.className, 'subs', 'he should not have to turn it on every session');
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
