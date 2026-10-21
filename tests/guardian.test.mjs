import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Settings, DEFAULT_STATE_DIRECTORY } from '../src/settings.mjs';
import { t, translations } from '../src/i18n.mjs';
import {
  authorizedAction, disksText, dockerText, html, loadConfig, main, parseUps, render, UpsMonitor, upsText,
} from '../src/guardian.mjs';

// Dati fittizi: nessun file privato, processo diagnostico o collegamento di rete.
const env = {
  TELEGRAM_BOT_TOKEN: '123456:dummy_for_offline_tests',
  TELEGRAM_CHAT_ID: '-12345',
  TELEGRAM_ALLOWED_USER_ID: '67890',
  GUARDIAN_UPS_NAME: 'example-ups@localhost',
  GUARDIAN_DOCKER_ENABLED: 'true',
  GUARDIAN_IMPORTANT_MOUNTS: '/,/boot/firmware',
  GUARDIAN_SHUTDOWN_WARNING_SECONDS: '',
};
const config = loadConfig(env);
const sample = status => parseUps(`ups.status: ${status}\nbattery.charge: 75\nbattery.runtime: 800\nups.model: UT850EG`);
const message = (text, overrides = {}) => ({ message: {
  chat: { id: -12345 }, from: { id: 67890 }, text, ...overrides,
} });
const callback = (data, overrides = {}) => ({ callback_query: {
  id: 'cb-1', from: { id: 67890 }, data,
  message: { chat: { id: -12345 }, message_id: 5 }, ...overrides,
} });

async function temporaryState(context) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'raspi-guardian-test-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// Avvia soltanto main con rete, processi e letture diagnostiche simulati.
// I soli file reali usati dai test sono nella directory temporanea di stato.
async function offlineBot(updates, stateDirectory, { failDiagnostics = false, environment = {}, commands = [] } = {}) {
  const originalEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries({ ...env, ...environment })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const calls = [];
  const originalOnce = process.once;
  let terminate;
  mock.method(process, 'once', function (event, listener) {
    if (event === 'SIGTERM') {
      terminate = listener;
      return this;
    }
    return originalOnce.call(this, event, listener);
  });
  mock.method(childProcess, 'execFile', (file, args, options, done) => {
    commands.push({ file, args, options });
    const output = file.endsWith('/upsc') ? 'ups.status: OL\nbattery.charge: 75\nbattery.runtime: 800'
      : file.endsWith('/findmnt') ? JSON.stringify({ filesystems: [
        { target: '/', source: '/dev/root', fstype: 'ext4', size: 1024 ** 3, avail: 1024 ** 2, 'use%': '99%' },
      ] }) : JSON.stringify({ Names: 'web', Status: 'Up 1 hour' });
    queueMicrotask(() => done(failDiagnostics ? new Error('private local error') : null, output));
  });
  mock.method(fs, 'readFile', async path => {
    if (failDiagnostics) throw new Error('private read error');
    if (path === '/proc/meminfo') return 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\n';
    if (path === '/sys/class/thermal/thermal_zone0/temp') return '45000';
    throw new Error('Unexpected file access in offline test.');
  });
  syncBuiltinESMExports();
  let polls = 0;
  mock.method(globalThis, 'fetch', async (url, options) => {
    const method = url.split('/').at(-1);
    const payload = JSON.parse(options.body);
    calls.push({ method, payload });
    let result = true;
    if (method === 'getMe') result = { username: 'guardian_test_bot' };
    if (method === 'getUpdates') {
      if (polls++ === 0) result = updates.map((update, i) => ({ ...update, update_id: i + 1 }));
      else {
        queueMicrotask(() => terminate());
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      }
    }
    return new Response(JSON.stringify({ ok: true, result }));
  });
  try {
    await main({ stateDirectory });
    return calls;
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const replies = calls => calls.filter(c => ['sendMessage', 'editMessageText'].includes(c.method)).map(c => c.payload);

test('configurazione e valori non validi non espongono credenziali', () => {
  assert.deepEqual(config.importantMounts, ['/', '/boot/firmware']);
  assert.deepEqual(loadConfig({ ...env, GUARDIAN_IMPORTANT_MOUNTS: '/,/srv/data/,/srv/data' }).importantMounts,
    ['/', '/srv/data']);
  assert.throws(() => loadConfig({ ...env, TELEGRAM_BOT_TOKEN: 'secret-invalid' }), error => !error.message.includes('secret-invalid'));
  assert.throws(() => loadConfig({ ...env, TELEGRAM_CHAT_ID: 'abc' }));
  assert.throws(() => loadConfig({ ...env, TELEGRAM_ALLOWED_USER_ID: '-3' }));
  assert.throws(() => loadConfig({ ...env, GUARDIAN_IMPORTANT_MOUNTS: '/,relative' }));
});

test('autorizzazione obbligatoria per chat e utente, anche sui pulsanti', () => {
  assert.equal(authorizedAction(message('/ups'), config).view, 'ups');
  assert.equal(authorizedAction(callback('disks'), config).view, 'disks');
  for (const update of [
    message('/ups', { chat: { id: 1 } }), message('/ups', { from: { id: 1 } }),
    message('/ups', { from: { id: 67890, is_bot: true } }),
    callback('ups', { from: { id: 1 } }),
    callback('ups', { message: { chat: { id: 1 }, message_id: 5 } }),
    callback('ups', { message: undefined }), callback('shutdown'),
    message('/ups; whoami'), message('/docker anything'), message('/unknown'),
    { channel_post: message('/ups').message }, {},
  ]) assert.equal(authorizedAction(update, config), null);
});

test('NUT: OL/OB verificati, letture incomplete o contraddittorie rifiutate', () => {
  assert.equal(sample('OL CHRG').power, 'online');
  assert.equal(sample('OB DISCHRG').power, 'battery');
  assert.equal(sample('OB LB').critical, true);
  assert.equal(sample('OL FSD').critical, true);
  for (const status of ['', 'UNKNOWN', 'LB', 'OL OB']) assert.throws(() => sample(status));
  assert.throws(() => parseUps('Error: Data stale'));
  assert.match(upsText(sample('OL')), /13 min 20 s/);
  assert.match(upsText(parseUps('ups.status: OL')), /Reported runtime: n\/a/);
});

test('blackout a 30 s, preavviso a 570 s, ripristino valido e deduplicazione per episodio', async () => {
  const monitor = new UpsMonitor(570);
  const messages = [];
  const send = async text => messages.push(text);
  await monitor.observe(sample('OL'), 0, send);
  await monitor.observe(sample('OB'), 1_000, send);
  await monitor.observe(sample('OB'), 30_999, send);
  assert.equal(messages.length, 0);
  await monitor.observe(sample('OB'), 31_000, send);
  await monitor.observe(sample('OB'), 32_000, send);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Mains power lost/);
  await monitor.observe(sample('OB LB'), 90_000, send);
  await monitor.observe(sample('OB LB FSD'), 91_000, send);
  assert.equal(messages.length, 2);
  assert.match(messages[1], /UPS critical/);
  await monitor.observe(sample('OB'), 570_999, send);
  assert.equal(messages.length, 2);
  await monitor.observe(sample('OB'), 571_000, send);
  await monitor.observe(sample('OB'), 610_000, send);
  assert.equal(messages.length, 3);
  assert.match(messages[2], /Shutdown warning/);
  await monitor.observe(sample('OL'), 620_000, send);
  await monitor.observe(sample('OL'), 625_000, send);
  assert.equal(messages.length, 4);
  assert.match(messages[3], /Mains power restored/);
  await monitor.observe(sample('OB LB'), 630_000, send);
  assert.equal(messages.length, 5); // LB immediato anche prima dei 30 s.
  await monitor.observe(sample('OB LB'), 660_000, send);
  assert.equal(messages.length, 6); // Nuovo blackout, una nuova notifica.
});

test('nessun falso ripristino su lettura fallita; tempo osservato conservato', async () => {
  const monitor = new UpsMonitor();
  const messages = [];
  const send = async text => messages.push(text);
  await monitor.observe(sample('OB'), 0, send);
  // Come nel ciclo reale, una lettura fallita non viene passata al monitor.
  assert.throws(() => parseUps('Error: connection failure'));
  assert.equal(monitor.outageSince, 0);
  assert.equal(messages.length, 0);
  await monitor.observe(sample('OB'), 40_000, send);
  assert.equal(messages.length, 1);
  assert.doesNotMatch(messages[0], /restored/);
  await monitor.observe(sample('OL'), 45_000, send);
  assert.match(messages[1], /restored/);
});

test('invii falliti vengono ritentati, quelli riusciti non vengono ripetuti', async () => {
  const monitor = new UpsMonitor();
  const sent = [];
  await monitor.observe(sample('OB'), 0, async () => {});
  await assert.rejects(monitor.observe(sample('OB'), 30_000, async () => { throw new Error('offline'); }));
  await monitor.observe(sample('OB'), 35_000, async text => sent.push(text));
  await monitor.observe(sample('OB'), 40_000, async text => sent.push(text));
  assert.equal(sent.length, 1);
  await assert.rejects(monitor.observe(sample('OL'), 50_000, async () => { throw new Error('offline'); }));
  assert.equal(monitor.outageSince, 0);
  await monitor.observe(sample('OL'), 55_000, async text => sent.push(text));
  await monitor.observe(sample('OL'), 60_000, async text => sent.push(text));
  assert.equal(sent.length, 2);
});

test('FSD persistente dopo il ripristino non duplica l’avviso critico', async () => {
  const monitor = new UpsMonitor();
  const sent = [];
  const send = async text => sent.push(text);
  await monitor.observe(sample('OB LB'), 0, send);
  await monitor.observe(sample('OL FSD'), 10_000, send);
  await monitor.observe(sample('OL FSD'), 20_000, send);
  assert.equal(sent.length, 2);
  assert.match(sent[0], /UPS critical/);
  assert.match(sent[1], /Mains power restored/);
});

test('escaping HTML, mount realmente assenti, capacità e limite messaggi', () => {
  assert.equal(html('<tag>&'), '&lt;tag&gt;&amp;');
  const root = { target: '/', source: '/dev/root', fstype: 'ext4', size: 1024 ** 3, avail: 100 * 1024 ** 2, 'use%': '91%' };
  const output = JSON.stringify({ filesystems: [root, { ...root, target: '/mnt/<data>&' }] });
  const text = disksText(output, ['/', '/boot/firmware', '/srv/data']);
  assert.match(text, /Important mounts missing: 2/);
  assert.match(text, /Missing: <code>\/srv\/data<\/code>/);
  assert.match(text, /100 MiB \/ 1.0 GiB/);
  assert.match(text, /&lt;data&gt;&amp;/);
  assert.throws(() => disksText('{}', ['/']));
  assert.throws(() => disksText('{"filesystems":[]}', ['/']));
  const many = JSON.stringify({ filesystems: Array.from({ length: 500 }, (_, i) => ({ ...root, target: `/mnt/${i}` })) });
  const compact = disksText(many, ['/']);
  assert.ok(compact.length < 3_800);
  assert.match(compact, /more entries not shown/);
});

test('Docker: conteggio, health esplicita e healthcheck assente', () => {
  assert.match(dockerText(''), /Running containers: <b>0<\/b>/);
  const output = [
    { Names: '<web>&', Status: 'Up 1 hour (healthy)' },
    { Names: 'db', Status: 'Up 1 hour (unhealthy)' },
    { Names: 'worker', Status: 'Up 1 second (health: starting)' },
    { Names: 'other', Status: 'Up 1 hour' },
  ].map(c => JSON.stringify(c)).join('\n');
  const text = dockerText(output);
  assert.match(text, /Running containers: <b>4<\/b>/);
  for (const expected of ['&lt;web&gt;&amp;', '✅ healthy', '⚠️ unhealthy', '⏳ starting', 'healthcheck not configured']) {
    assert.ok(text.includes(expected));
  }
});

test('flusso completo simulato: comandi, pulsanti, isolamento segreti e SIGTERM durante polling', async context => {
  const stateDirectory = await temporaryState(context);
  const originalEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const calls = [];
  const commands = [];
  const originalOnce = process.once;
  let terminate;
  mock.method(process, 'once', function (event, listener) {
    if (event === 'SIGTERM') {
      terminate = listener;
      return this;
    }
    return originalOnce.call(this, event, listener);
  });
  mock.method(childProcess, 'execFile', (file, args, options, done) => {
    commands.push({ file, args, options });
    const output = file.endsWith('/upsc') ? 'ups.status: OL\nbattery.charge: 100'
      : file.endsWith('/findmnt') ? JSON.stringify({ filesystems: [
        { target: '/', source: '/dev/root', fstype: 'ext4', size: 1000, avail: 500, 'use%': '50%' },
      ] }) : '';
    queueMicrotask(() => done(null, output));
  });
  mock.method(fs, 'readFile', async path => path === '/proc/meminfo'
    ? 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\n' : '45000');
  syncBuiltinESMExports();
  let polls = 0;
  let aborted = false;
  mock.method(globalThis, 'fetch', async (url, options) => {
    const method = url.split('/').at(-1);
    const payload = JSON.parse(options.body);
    calls.push({ method, payload, options });
    let result = true;
    if (method === 'getMe') result = { username: 'guardian_test_bot' };
    if (method === 'getUpdates') {
      if (polls++ === 0) {
        result = [
          ...['start', 'help', 'status', 'ups', 'system', 'disks', 'docker'].map(view => message(`/${view}`)),
          callback('help'), message('/ups', { from: { id: 1 } }), callback('ups', { from: { id: 1 } }),
          message('/ups@other_bot'),
        ].map((update, i) => ({ ...update, update_id: i + 10 }));
      } else {
        queueMicrotask(() => terminate());
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        }, { once: true }));
      }
    }
    return new Response(JSON.stringify({ ok: true, result }));
  });
  try {
    await main({ stateDirectory });
    assert.equal(aborted, true);
    assert.equal(calls.filter(c => c.method === 'sendMessage').length, 7);
    assert.equal(calls.filter(c => c.method === 'answerCallbackQuery').length, 1);
    assert.equal(calls.filter(c => c.method === 'editMessageText').length, 1);
    assert.equal(calls.filter(c => c.method === 'getUpdates')[1].payload.offset, 21);
    for (const { method, payload, options } of calls) {
      assert.equal(options.redirect, 'error');
      if (method === 'sendMessage' || method === 'editMessageText') {
        assert.equal(payload.chat_id, env.TELEGRAM_CHAT_ID);
        assert.equal(payload.parse_mode, 'HTML');
        assert.ok(payload.text.length < 3_800);
        assert.ok(payload.reply_markup.inline_keyboard.length);
      }
    }
    assert.ok(commands.some(c => c.file === '/usr/bin/upsc'));
    assert.ok(commands.some(c => c.file === '/usr/bin/findmnt'));
    assert.ok(commands.some(c => c.file === '/usr/bin/docker'));
    for (const c of commands) {
      assert.equal(c.options.shell, false);
      assert.equal(c.options.timeout, 5000);
      assert.equal(c.options.killSignal, 'SIGKILL');
      assert.equal(c.options.env.TELEGRAM_BOT_TOKEN, undefined);
      assert.equal(c.options.env.TELEGRAM_CHAT_ID, undefined);
    }
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('conflitto polling: uscita con errore e log senza token o descrizioni remote', async context => {
  const stateDirectory = await temporaryState(context);
  const originalEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  const originalExitCode = process.exitCode;
  Object.assign(process.env, env);
  const logs = [];
  for (const level of ['info', 'warn', 'error']) mock.method(console, level, text => logs.push(text));
  mock.method(childProcess, 'execFile', (file, args, options, done) => {
    queueMicrotask(() => done(null, 'ups.status: OL'));
  });
  syncBuiltinESMExports();
  mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/getMe')) return new Response(JSON.stringify({ ok: true, result: { username: 'guardian_test_bot' } }));
    return new Response(JSON.stringify({ ok: false, error_code: 409, description: `private-response ${env.TELEGRAM_BOT_TOKEN}` }), { status: 409 });
  });
  try {
    await main({ stateDirectory });
    assert.equal(process.exitCode, 1);
    assert.ok(logs.some(text => text.includes('Polling interrotto')));
    assert.ok(logs.every(text => !text.includes(env.TELEGRAM_BOT_TOKEN) && !text.includes('private-response')));
  } finally {
    process.exitCode = originalExitCode;
    mock.restoreAll();
    syncBuiltinESMExports();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('dizionario IT/EN completo, parametri e default inglese', async () => {
  assert.deepEqual(Object.keys(translations.it).sort(), Object.keys(translations.en).sort());
  for (const key of Object.keys(translations.it)) {
    const parameters = text => [...text.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    assert.deepEqual(parameters(translations.it[key]), parameters(translations.en[key]), key);
    assert.ok(translations.it[key].length > 0 && translations.en[key].length > 0, key);
  }
  assert.equal(t(undefined, 'help'), 'Help');
  assert.equal(t('it', 'help'), 'Aiuto');
  assert.match(await render('help', config), /general overview/);
  assert.match(await render('start', config, undefined, 'en'), /general overview/);
  assert.equal(DEFAULT_STATE_DIRECTORY, '/var/lib/raspi-guardian');
});

test('file assente o non valido: default inglese e recupero senza esporre contenuti', async context => {
  const directory = await temporaryState(context);
  const settings = new Settings(directory);
  await settings.load();
  assert.equal(settings.language, 'en');
  assert.deepEqual(await fs.readdir(directory), []); // La lettura non crea file.
  const logs = [];
  const warning = mock.method(console, 'warn', text => logs.push(text));
  context.after(() => warning.mock.restore());
  for (const content of [
    'private-corrupt-content', 'null', '{}', '[]', '{"language":"fr"}',
    '{"language":42}', '{"language":{"it":true}}', 'x'.repeat(4097),
  ]) {
    await fs.writeFile(settings.path, content);
    await settings.load();
    assert.equal(settings.language, 'en');
    assert.equal(await fs.readFile(settings.path, 'utf8'), content);
  }
  assert.equal(logs.length, 8);
  assert.ok(logs.every(line => !line.includes('private-corrupt-content')));
  await settings.setLanguage('en');
  const restarted = new Settings(directory);
  await restarted.load();
  assert.equal(restarted.language, 'en');
});

test('salvataggio atomico, permessi 0600, solo lingua e persistenza IT → EN → IT', async context => {
  const directory = await temporaryState(context);
  const settings = new Settings(directory);
  await settings.setLanguage('it');
  const originalRename = fs.rename;
  const rename = mock.method(fs, 'rename', async (source, target) => {
    assert.equal(target, settings.path);
    assert.equal((await fs.stat(source)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(source, 'utf8')), { language: 'en' });
    // Fino al rename il file precedente è completo e invariato.
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { language: 'it' });
    await originalRename(source, target);
  });
  syncBuiltinESMExports();
  try {
    await settings.setLanguage('en');
    assert.equal(rename.mock.callCount(), 1);
  } finally {
    rename.mock.restore();
    syncBuiltinESMExports();
  }
  assert.deepEqual(await fs.readdir(directory), ['settings.json']);
  assert.equal((await fs.stat(settings.path)).mode & 0o777, 0o600);
  const restarted = new Settings(directory);
  await restarted.load();
  assert.equal(restarted.language, 'en');
  await restarted.setLanguage('it');
  await settings.load();
  assert.equal(settings.language, 'it');
  assert.deepEqual(JSON.parse(await fs.readFile(settings.path, 'utf8')), { language: 'it' });
  await assert.rejects(settings.setLanguage('fr'));
  assert.equal(settings.language, 'it');
});

test('scrittura fallita: file precedente integro, lingua conservata, temporanei rimossi', async context => {
  const directory = await temporaryState(context);
  const settings = new Settings(directory);
  await settings.setLanguage('en');
  const rename = mock.method(fs, 'rename', async () => { throw new Error('private disk error'); });
  syncBuiltinESMExports();
  try {
    await assert.rejects(settings.setLanguage('it'));
    assert.equal(settings.language, 'en');
    assert.deepEqual(JSON.parse(await fs.readFile(settings.path, 'utf8')), { language: 'en' });
    assert.deepEqual(await fs.readdir(directory), ['settings.json']);
  } finally {
    rename.mock.restore();
    syncBuiltinESMExports();
  }
});

test('settings non segue symlink né sovrascrive il file puntato', async context => {
  const directory = await temporaryState(context);
  const target = join(directory, 'unrelated.json');
  await fs.writeFile(target, '{"language":"en"}');
  const settings = new Settings(directory);
  await fs.symlink(target, settings.path);
  const warning = mock.method(console, 'warn', () => {});
  try {
    await settings.load();
    assert.equal(settings.language, 'en');
    await settings.setLanguage('it');
    assert.equal((await fs.lstat(settings.path)).isSymbolicLink(), false);
    assert.equal(await fs.readFile(target, 'utf8'), '{"language":"en"}');
  } finally {
    warning.mock.restore();
  }
});

test('/lang e comandi IT → EN → IT: selettore, menu e conferme immediate', async context => {
  const directory = await temporaryState(context);
  await new Settings(directory).setLanguage('it');
  const result = replies(await offlineBot([
    message('/lang'), message('/lang@GUARDIAN_TEST_BOT en'), message('/help'),
    message('/lang it'), message('/start'),
  ], directory));
  assert.equal(result.length, 5);
  assert.match(result[0].text, /Lingua attuale: Italiano/);
  assert.deepEqual(result[0].reply_markup.inline_keyboard[0], [
    { text: '🇮🇹 Italiano', callback_data: 'lang:it' },
    { text: '🇬🇧 English', callback_data: 'lang:en' },
  ]);
  assert.match(result[1].text, /Language set: English/);
  assert.match(result[2].text, /general overview/);
  assert.match(result[3].text, /Lingua impostata: Italiano/);
  assert.match(result[4].text, /riepilogo generale/);
  assert.ok(result[2].reply_markup.inline_keyboard.flat().some(b => b.text === '↻ Refresh'));
  assert.ok(result[4].reply_markup.inline_keyboard.flat().some(b => b.text === '↻ Aggiorna'));
  assert.deepEqual(JSON.parse(await fs.readFile(join(directory, 'settings.json'), 'utf8')), { language: 'it' });
});

test('pulsanti lingua IT → EN → IT autorizzati e aggiornamento delle vecchie tastiere', async context => {
  const directory = await temporaryState(context);
  await new Settings(directory).setLanguage('it');
  const calls = await offlineBot([
    callback('lang'), callback('lang:en'), callback('help'), callback('lang'),
    callback('lang:it'), callback('help'),
  ], directory);
  assert.equal(calls.filter(c => c.method === 'answerCallbackQuery').length, 6);
  assert.equal(calls.filter(c => c.method === 'editMessageText').length, 6);
  const result = replies(calls);
  assert.match(result[1].text, /Language set: English/);
  assert.match(result[2].text, /commands and buttons/);
  assert.match(result[3].text, /Current language: English/);
  assert.match(result[4].text, /Lingua impostata: Italiano/);
  assert.match(result[5].text, /comandi e pulsanti/);
  for (const payload of result) assert.equal(payload.message_id, 5);
});

test('riavvio simulato: il bot ricarica la lingua e usa STATE_DIRECTORY', async context => {
  const directory = await temporaryState(context);
  await offlineBot([message('/lang en')], directory);
  const originalStateDirectory = process.env.STATE_DIRECTORY;
  process.env.STATE_DIRECTORY = directory;
  try {
    assert.equal(new Settings().path, join(directory, 'settings.json'));
    const result = replies(await offlineBot([message('/start'), message('/lang')], undefined));
    assert.match(result[0].text, /general overview/);
    assert.match(result[1].text, /Current language: English/);
  } finally {
    if (originalStateDirectory === undefined) delete process.env.STATE_DIRECTORY;
    else process.env.STATE_DIRECTORY = originalStateDirectory;
  }
});

test('cambio lingua vietato a chat, utenti e bot non autorizzati; callback e argomenti limitati', async context => {
  const directory = await temporaryState(context);
  const rejected = [
    message('/lang en', { from: { id: 1 } }), message('/lang en', { chat: { id: 1 } }),
    message('/lang en', { from: { id: 67890, is_bot: true } }),
    callback('lang:en', { from: { id: 1 } }),
    callback('lang:en', { from: { id: 67890, is_bot: true } }),
    callback('lang:en', { message: { chat: { id: 1 }, message_id: 5 } }),
    callback('lang:en', { message: undefined }), callback('lang:en', { id: '' }),
    callback('lang:en', { message: { chat: { id: -12345 }, message_id: '5' } }),
    callback('lang:fr'), callback('lang:en; whoami'), callback('lang:../../etc'),
  ];
  for (const update of rejected) assert.equal(authorizedAction(update, config), null);
  const calls = await offlineBot([...rejected, message('/lang@other_bot en'), message('/help')], directory);
  assert.equal(replies(calls).length, 1);
  assert.match(replies(calls)[0].text, /general overview/);
  assert.equal(calls.filter(c => c.method === 'answerCallbackQuery').length, 0);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('argomenti lingua non validi e impossibilità di salvare: errori nella lingua corrente', async context => {
  const directory = await temporaryState(context);
  await new Settings(directory).setLanguage('it');
  let result = replies(await offlineBot([
    message('/lang fr'), message('/lang en'), message('/lang en; whoami'), message('/lang en it'),
  ], directory));
  assert.match(result[0].text, /Usa \/lang/);
  assert.match(result[2].text, /Use \/lang/);
  assert.match(result[3].text, /Use \/lang/);
  // Una directory al posto del file fa fallire il rename senza toccare permessi di sistema.
  await fs.unlink(join(directory, 'settings.json'));
  await fs.mkdir(join(directory, 'settings.json'));
  result = replies(await offlineBot([message('/lang en'), message('/help')], directory));
  assert.match(result[0].text, /Unable to save the language/);
  assert.match(result[1].text, /general overview/);
  assert.deepEqual(await fs.readdir(directory), ['settings.json']);
  await fs.rmdir(join(directory, 'settings.json'));
  await new Settings(directory).setLanguage('en');
  const rename = mock.method(fs, 'rename', async () => { throw new Error('private rename error'); });
  syncBuiltinESMExports();
  try {
    result = replies(await offlineBot([callback('lang:it'), message('/help')], directory));
    assert.match(result[0].text, /Unable to save the language/);
    assert.doesNotMatch(result[0].text, /private rename error/);
    assert.match(result[1].text, /general overview/);
  } finally {
    rename.mock.restore();
    syncBuiltinESMExports();
  }
});

test('tutti i comandi e i pulsanti in inglese, dati tecnici invariati', async context => {
  const directory = await temporaryState(context);
  const views = ['start', 'help', 'status', 'ups', 'system', 'disks', 'docker'];
  const result = replies(await offlineBot([
    message('/lang en'), ...views.map(view => message(`/${view}`)),
  ], directory)).slice(1);
  const expected = [/general overview/, /commands and buttons/, /Power:/, /Reported runtime:/,
    /RAM used:/, /Important mounts missing:/, /Running containers:/];
  for (let i = 0; i < result.length; i++) {
    assert.match(result[i].text, expected[i]);
    assert.doesNotMatch(result[i].text, /Alimentazione|Autonomia dichiarata|Sistema|Liberi|non configurato|n\/d/);
    const buttons = result[i].reply_markup.inline_keyboard.flat();
    for (const label of ['📊 Status', '🖥 System', '💾 Disks', '❔ Help', '🌐 Language', '↻ Refresh']) {
      assert.ok(buttons.some(b => b.text === label), label);
    }
    assert.deepEqual(buttons.map(b => b.callback_data), ['status', 'ups', 'system', 'disks', 'docker', 'help', 'lang', views[i]]);
  }
  assert.match(result[3].text, /<code>OL<\/code>/);
  assert.match(result[3].text, /example-ups@localhost/);
  assert.match(result[6].text, /<b>web<\/b>/);
  assert.match(result[6].text, /Up 1 hour/);
  assert.match(result[6].text, /healthcheck not configured/);
  assert.match(upsText(parseUps('ups.status: OB LB'), 'en'), /Reported runtime: n\/a/);
  assert.match(upsText(sample('OB LB'), 'en'), /on battery/);
  const many = JSON.stringify({ filesystems: Array.from({ length: 500 }, (_, i) => ({ target: `/mnt/${i}` })) });
  const compact = disksText(many, [], 'en');
  assert.ok(compact.length < 3800);
  assert.match(compact, /more entries not shown/);
});

test('errori diagnostici inglesi e dati sistema assenti senza dettagli interni', async context => {
  const directory = await temporaryState(context);
  const result = replies(await offlineBot([
    message('/lang en'), ...['status', 'ups', 'system', 'disks', 'docker'].map(view => message(`/${view}`)),
  ], directory, { failDiagnostics: true }));
  for (const index of [1, 2, 4, 5]) {
    assert.match(result[index].text, /data unavailable/);
    assert.match(result[index].text, /Check availability and permissions of local commands/);
    assert.doesNotMatch(result[index].text, /dati non disponibili|private/);
  }
  assert.match(result[3].text, /RAM used: n\/a/);
  assert.match(result[3].text, /Temperature: n\/a/);
});

test('tutti gli avvisi UPS in inglese senza cambiare soglie, flag o deduplicazione', async () => {
  const monitor = new UpsMonitor(570);
  const sent = [];
  const observe = (status, now) => monitor.observe(sample(status), now, async text => sent.push(text), () => 'en');
  await observe('OB', 0);
  await observe('OB', 29_999);
  assert.equal(sent.length, 0);
  await observe('OB', 30_000);
  await observe('OB LB', 40_000);
  await observe('OB LB', 569_999);
  assert.equal(sent.length, 2);
  await observe('OB LB', 570_000);
  await observe('OB LB', 580_000);
  await observe('OL FSD', 600_000);
  await observe('OL FSD', 610_000);
  assert.equal(sent.length, 4);
  for (const [i, expected] of [/Mains power lost/, /UPS critical/, /Shutdown warning/, /Mains power restored/].entries()) {
    assert.match(sent[i], expected);
    assert.doesNotMatch(sent[i], /Alimentazione|Preavviso|critico/);
  }
  assert.match(sent[1], /\(LB\).*\(FSD\)/);
  assert.match(sent[2], /Observed outage duration: 9 min 30 s.*Configured threshold: 9 min 30 s/);
  assert.match(sent[2], /does not indicate when shutdown will occur/);
  assert.match(sent[2], /neither reads nor verifies/);
  const onlineMonitor = new UpsMonitor();
  await onlineMonitor.observe(sample('OL FSD'), 0, async text => sent.push(text), () => 'en');
  assert.match(sent[4], /Mains available, but NUT reports LB or FSD/);
});

test('cambio lingua durante blackout: avvisi successivi aggiornati, stato e retry conservati', async () => {
  const monitor = new UpsMonitor(570);
  let language = 'it';
  const sent = [];
  const send = async text => sent.push(text);
  const current = () => language;
  await monitor.observe(sample('OB'), 0, send, current);
  await monitor.observe(sample('OB'), 30_000, send, current);
  assert.match(sent[0], /Alimentazione assente/);
  language = 'en';
  await monitor.observe(sample('OB LB'), 60_000, send, current);
  assert.equal(monitor.outageSince, 0);
  assert.match(sent[1], /UPS critical/);
  await assert.rejects(monitor.observe(sample('OB'), 570_000, async () => { throw new Error('offline'); }, current));
  language = 'it';
  await monitor.observe(sample('OB'), 575_000, send, current);
  assert.match(sent[2], /Preavviso shutdown/);
  language = 'en';
  await monitor.observe(sample('OL'), 600_000, send, current);
  assert.match(sent[3], /Mains power restored/);
  assert.equal(sent.length, 4);
});

test('configurazione pubblica: UPS obbligatorio, Docker e preavviso disabilitati, mount generico', () => {
  const minimal = {
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: env.TELEGRAM_CHAT_ID,
    TELEGRAM_ALLOWED_USER_ID: env.TELEGRAM_ALLOWED_USER_ID,
    GUARDIAN_UPS_NAME: 'example-ups',
  };
  const defaults = loadConfig(minimal);
  assert.equal(defaults.upsName, 'example-ups');
  assert.equal(defaults.dockerEnabled, false);
  assert.equal(defaults.shutdownWarningSeconds, null);
  assert.deepEqual(defaults.importantMounts, ['/']);
  assert.throws(() => loadConfig({ ...minimal, GUARDIAN_UPS_NAME: undefined }), /GUARDIAN_UPS_NAME/);
  assert.equal(loadConfig({ ...minimal, GUARDIAN_SHUTDOWN_WARNING_SECONDS: '' }).shutdownWarningSeconds, null);
});

test('destinazioni NUT valide e input invalidi, nessun valore privato negli errori', () => {
  for (const value of ['ups', 'ups_1.test-2', 'ups@localhost', 'ups@nut.example.org:3493',
    'ups@192.0.2.1:65535', 'ups@[::1]:3493', 'ups@[2001:db8::1]']) {
    assert.equal(loadConfig({ ...env, GUARDIAN_UPS_NAME: value }).upsName, value);
  }
  for (const value of ['', '-l', '--help', 'ups extra', 'ups;whoami', 'ups$(id)', 'ups\n',
    'ups@', 'ups@@host', 'ups@host:0', 'ups@host:65536', 'ups@host:abc', 'ups@host:3493:4',
    'ups@-host', 'ups@host..example', 'ups@[:::]', 'ups/path', 'x'.repeat(513)]) {
    assert.throws(() => loadConfig({ ...env, GUARDIAN_UPS_NAME: value }), error =>
      error.message.includes('GUARDIAN_UPS_NAME') && !error.message.includes(env.TELEGRAM_BOT_TOKEN));
  }
  assert.throws(() => loadConfig({ ...env, GUARDIAN_UPS_NAME: 'private-invalid-value!' }),
    error => !error.message.includes('private-invalid-value'));
});

test('opzioni Docker e soglia: valori espliciti e rifiuto di configurazioni ambigue', () => {
  assert.equal(loadConfig({ ...env, GUARDIAN_DOCKER_ENABLED: 'false' }).dockerEnabled, false);
  assert.equal(loadConfig({ ...env, GUARDIAN_DOCKER_ENABLED: 'true' }).dockerEnabled, true);
  for (const value of ['', '1', 'yes', 'TRUE', 'false;whoami']) {
    assert.throws(() => loadConfig({ ...env, GUARDIAN_DOCKER_ENABLED: value }), /GUARDIAN_DOCKER_ENABLED/);
  }
  assert.equal(loadConfig({ ...env, GUARDIAN_SHUTDOWN_WARNING_SECONDS: '570' }).shutdownWarningSeconds, 570);
  for (const value of ['0', '-1', '1.5', 'NaN', 'Infinity', '1e3', ' 60', '60s', '9007199254740991']) {
    assert.throws(() => loadConfig({ ...env, GUARDIAN_SHUTDOWN_WARNING_SECONDS: value }), /GUARDIAN_SHUTDOWN_WARNING_SECONDS/);
  }
});

test('Docker disabilitato: nessun processo, comando, pulsante o callback, in IT e EN', async context => {
  const directory = await temporaryState(context);
  for (const enabled of [undefined, 'false']) {
    const environment = { GUARDIAN_DOCKER_ENABLED: enabled };
    const disabled = loadConfig({ ...env, ...environment });
    assert.equal(authorizedAction(message('/docker'), disabled), null);
    assert.equal(authorizedAction(callback('docker'), disabled), null);
    for (const language of ['it', 'en']) {
      const commands = [];
      const calls = await offlineBot([
        message(`/lang ${language}`), message('/start'), message('/help'), message('/status'),
        message('/ups'), message('/system'), message('/disks'), message('/lang'),
        message('/docker'), callback('docker'), callback('status'),
      ], directory, { environment, commands });
      assert.equal(replies(calls).length, 9);
      assert.equal(calls.filter(c => c.method === 'answerCallbackQuery').length, 1);
      assert.ok(commands.some(c => c.file.endsWith('/upsc')));
      assert.ok(commands.every(c => c.file !== '/usr/bin/docker'));
      for (const payload of replies(calls)) {
        assert.doesNotMatch(payload.text, /docker/i);
        assert.ok(payload.reply_markup.inline_keyboard.flat().every(b => b.callback_data !== 'docker'));
      }
      // Anche una chiamata interna alla vista disabilitata non esegue diagnostica.
      assert.equal(await render('docker', disabled, undefined, language), undefined);
    }
  }
});

test('Docker abilitato e UPS configurato: diagnostica e interfaccia IT/EN, argomenti isolati', async context => {
  const directory = await temporaryState(context);
  for (const language of ['it', 'en']) {
    const commands = [];
    const calls = await offlineBot([
      message(`/lang ${language}`), message('/help'), message('/status'), message('/ups'),
      message('/docker'), callback('docker'),
    ], directory, { environment: { GUARDIAN_UPS_NAME: 'lab-ups@nut.example.org:3494' }, commands });
    const result = replies(calls);
    assert.equal(result.length, 6);
    assert.match(result[1].text, /\/docker/);
    assert.match(result[2].text, /Docker/);
    assert.match(result[3].text, /NUT: <code>lab-ups@nut.example.org:3494<\/code>/);
    assert.match(result[4].text, /<b>web<\/b>/);
    assert.match(result[5].text, /<b>web<\/b>/);
    assert.equal(commands.filter(c => c.file === '/usr/bin/docker').length, 3);
    for (const c of commands) {
      if (c.file === '/usr/bin/upsc') assert.deepEqual(c.args, ['lab-ups@nut.example.org:3494']);
      assert.equal(c.options.shell, false);
      assert.equal(c.options.timeout, 5000);
      assert.deepEqual(Object.keys(c.options.env).sort(), ['LANG', 'LC_ALL', 'PATH']);
    }
    assert.ok(result.every(p => p.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'docker')));
  }
});

test('preavviso assente: blackout, criticità e ripristino conservati senza warning', async () => {
  for (const language of ['it', 'en']) {
    const monitor = new UpsMonitor(loadConfig({ ...env }).shutdownWarningSeconds);
    const sent = [];
    const observe = (status, now) => monitor.observe(sample(status), now, async text => sent.push(text), () => language);
    await observe('OB', 0);
    await observe('OB', 30_000);
    await observe('OB LB', 570_000);
    await observe('OB LB', 86_400_000);
    await observe('OL FSD', 86_405_000);
    assert.equal(sent.length, 3);
    assert.ok(sent.every(text => !/Preavviso shutdown|Shutdown warning/.test(text)));
    assert.equal(monitor.outageSince, null);
  }
});

test('preavviso configurato: soglia personalizzata, tempo osservato, retry e nuovo episodio IT/EN', async () => {
  for (const language of ['it', 'en']) {
    const monitor = new UpsMonitor(loadConfig({ ...env, GUARDIAN_SHUTDOWN_WARNING_SECONDS: '45' }).shutdownWarningSeconds);
    const sent = [];
    const send = async text => sent.push(text);
    const observe = (status, now) => monitor.observe(sample(status), now, send, () => language);
    await observe('OB', 0);
    await observe('OB', 30_000);
    await observe('OB', 44_999);
    assert.equal(sent.length, 1);
    await assert.rejects(monitor.observe(sample('OB'), 45_000, async () => { throw new Error('offline'); }));
    await observe('OB', 50_000);
    await observe('OB', 60_000);
    assert.equal(sent.length, 2);
    assert.match(sent[1], /0 min 50 s/);
    assert.match(sent[1], /0 min 45 s/);
    assert.doesNotMatch(sent[1], /600|570|expected in|atteso tra/);
    assert.match(sent[1], language === 'it' ? /non indica quando/ : /does not indicate when/);
    await observe('OL', 65_000);
    await observe('OB', 70_000);
    await observe('OB', 115_000);
    assert.equal(sent.length, 5);
    assert.match(sent[4], /Preavviso shutdown|Shutdown warning/);
  }
});

test('variabili UPS assenti o non numeriche: dati tecnici e flag conservati in IT/EN', () => {
  for (const language of ['it', 'en']) {
    for (const value of ['', '-1', 'NaN', 'Infinity', 'unknown']) {
      const ups = parseUps(`ups.status: OB LB DISCHRG\nbattery.charge: ${value}\nbattery.runtime: ${value}\nups.load: ${value}\ninput.voltage: ${value}`);
      const text = upsText(ups, language, 'test-ups');
      assert.equal((text.match(language === 'it' ? /n\/d/g : /n\/a/g) ?? []).length, 6);
      assert.match(text, /OB LB DISCHRG/);
      assert.match(text, /test-ups/);
      assert.equal(ups.critical, true);
    }
    const text = upsText(parseUps('ups.status: OL\nups.mfr: Example & Co\nups.model: Technical <model>'), language, 'test-ups');
    assert.match(text, /Example &amp; Co Technical &lt;model&gt;/);
    assert.match(text, /<code>OL<\/code>/);
  }
});

test('Docker abilitato conserva autorizzazioni chat/utente e rifiuta callback manipolati', async context => {
  const directory = await temporaryState(context);
  const commands = [];
  const rejected = [
    message('/docker', { from: { id: 1 } }), message('/docker', { chat: { id: 1 } }),
    callback('docker', { from: { id: 1 } }), callback('docker', { from: { id: 67890, is_bot: true } }),
    callback('docker', { message: { chat: { id: 1 }, message_id: 5 } }),
    callback('docker', { id: '' }), callback('docker', { message: undefined }),
    callback('docker', { message: { chat: { id: -12345 }, message_id: '5' } }),
    callback('docker;whoami'), message('/docker arbitrary'), message('/docker@other_bot'),
  ];
  const calls = await offlineBot([...rejected, message('/help')], directory, { commands });
  assert.equal(replies(calls).length, 1);
  assert.equal(calls.filter(c => c.method === 'answerCallbackQuery').length, 0);
  assert.ok(commands.every(c => c.file !== '/usr/bin/docker'));
});


test('nuova installazione Telegram: inglese senza file o scelta /lang', async context => {
  const directory = await temporaryState(context);
  const result = replies(await offlineBot([message('/help'), message('/lang'), message('/ups')], directory));
  assert.match(result[0].text, /general overview/);
  assert.match(result[1].text, /Current language: English/);
  assert.match(result[2].text, /Power:.*mains available/);
  assert.deepEqual(await fs.readdir(directory), []);
});

test('upgrade Telegram: lingua già salvata IT e EN preservata senza riscrittura', async context => {
  const directory = await temporaryState(context);
  for (const language of ['it', 'en']) {
    const path = join(directory, 'settings.json');
    const original = `{"language":"${language}"}\n`;
    await fs.writeFile(path, original, { mode: 0o600 });
    const result = replies(await offlineBot([message('/help'), message('/lang')], directory));
    assert.match(result[0].text, language === 'it' ? /riepilogo generale/ : /general overview/);
    assert.match(result[1].text, language === 'it' ? /Lingua attuale: Italiano/ : /Current language: English/);
    assert.equal(await fs.readFile(path, 'utf8'), original);
  }
});
