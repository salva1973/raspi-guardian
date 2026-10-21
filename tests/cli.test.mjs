import assert from 'node:assert/strict';
import { test, mock, after } from 'node:test';
import childProcess, { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CliSettings } from '../src/cli-settings.mjs';
import { Settings } from '../src/settings.mjs';
import { runCli, terminalText } from '../src/cli.mjs';

const isolatedHome = await fs.mkdtemp(join(tmpdir(), 'raspi-guardian-cli-home-'));
after(() => fs.rm(isolatedHome, { recursive: true, force: true }));

const environment = { GUARDIAN_UPS_NAME: 'lab-ups@nut.example.org:3494' };
const ESCAPE = /[\x1b\x9b]/;

function offline(context, { fail = [], outputs = {} } = {}) {
  const calls = [];
  const reads = [];
  const network = mock.method(globalThis, 'fetch', () => { throw new Error('Unexpected network access'); });
  const once = mock.method(process, 'once', () => { throw new Error('Unexpected bot lifecycle'); });
  mock.method(childProcess, 'execFile', (file, args, options, done) => {
    const name = file.split('/').at(-1);
    calls.push({ file, args, options });
    const output = outputs[name] ?? {
      upsc: 'ups.status: OL\nbattery.charge: 75\nbattery.runtime: 800\nups.model: Example & <model>',
      findmnt: JSON.stringify({ filesystems: [
        { target: '/', source: '/dev/example', fstype: 'ext4', size: 1024 ** 3, avail: 1024 ** 2, 'use%': '99%' },
      ] }),
      docker: JSON.stringify({ Names: 'web', Status: 'Up 1 hour (healthy)' }),
    }[name];
    assert.ok(output !== undefined, `Unexpected command: ${file}`);
    queueMicrotask(() => done(fail.includes(name) ? new Error('private command error and secrets') : null, output));
  });
  mock.method(fs, 'readFile', async path => {
    reads.push(path);
    assert.ok(['/proc/meminfo', '/sys/class/thermal/thermal_zone0/temp'].includes(path), 'No config/settings reads');
    if (fail.includes('system')) throw new Error('private read error');
    return path === '/proc/meminfo' ? 'MemTotal: 8000000 kB\nMemAvailable: 4000000 kB' : '45000';
  });
  syncBuiltinESMExports();
  context.after(() => {
    assert.equal(network.mock.callCount(), 0, 'No Telegram calls');
    assert.equal(once.mock.callCount(), 0, 'No polling or monitor lifecycle');
    mock.restoreAll();
    syncBuiltinESMExports();
  });
  return { calls, reads };
}

async function invoke(args, env = {}, isTTY = false) {
  let out = '', error = '';
  const code = await runCli(args, {
    env: { HOME: isolatedHome, ...env }, stdout: { isTTY, write: text => { out += text; } },
    stderr: { write: text => { error += text; } },
  });
  return { code, out, error };
}

test('help e nessun argomento: nessun token, configurazione diagnostica o processo', async context => {
  const { calls, reads } = offline(context);
  for (const args of [[], ['help']]) {
    const result = await invoke(args, { GUARDIAN_UPS_NAME: 'invalid!' });
    assert.equal(result.code, 0);
    for (const view of ['status', 'ups', 'system', 'disks', 'docker', 'help', 'lang']) assert.match(result.out, new RegExp(`  ${view} `));
    assert.doesNotMatch(result.out, /\/lang|long polling|automatici attivi/);
    assert.equal(result.error, '');
  }
  assert.equal(calls.length, 0);
  assert.equal(reads.length, 0);
});

test('comandi diagnostici condivisi: dati, target NUT, mount e Docker in sola lettura', async context => {
  const { calls } = offline(context);
  const env = { ...environment, GUARDIAN_DOCKER_ENABLED: 'true', GUARDIAN_IMPORTANT_MOUNTS: '/,/srv/data' };
  for (const [view, expected] of [
    ['status', /Charge: 75 %/], ['ups', /Example & <model>/], ['system', /Temperature: 45 °C/],
    ['disks', /Missing: \/srv\/data/], ['docker', /web · ✅ healthy/],
  ]) {
    const result = await invoke([view], env);
    assert.equal(result.code, 0, view);
    assert.match(result.out, expected);
    assert.match(result.out, /^╭─ /);
    assert.match(result.out, /╰─\n$/);
    assert.doesNotMatch(result.out, ESCAPE);
    assert.doesNotMatch(result.out, /<\/?(?:b|i|code)>/);
    assert.equal(result.error, '');
  }
  const expectedArgs = {
    '/usr/bin/upsc': [environment.GUARDIAN_UPS_NAME],
    '/usr/bin/findmnt': ['--json', '--list', '--df', '--bytes', '--output', 'TARGET,SOURCE,FSTYPE,SIZE,AVAIL,USE%'],
    '/usr/bin/docker': ['container', 'ls', '--format', '{{json .}}'],
  };
  assert.equal(calls.length, 6);
  for (const call of calls) {
    assert.deepEqual(call.args, expectedArgs[call.file]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.timeout, 5000);
    assert.deepEqual(Object.keys(call.options.env).sort(), ['LANG', 'LC_ALL', 'PATH']);
  }
});

test('system, disks e docker non richiedono un UPS; Telegram e soglia ignorati', async context => {
  offline(context);
  const env = { TELEGRAM_BOT_TOKEN: 'invalid-secret', TELEGRAM_CHAT_ID: 'invalid', GUARDIAN_SHUTDOWN_WARNING_SECONDS: 'invalid' };
  for (const view of ['system', 'disks', 'docker']) {
    const result = await invoke([view], { ...env, GUARDIAN_DOCKER_ENABLED: 'true' });
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.out + result.error, /invalid|secret|Telegram/);
  }
});

test('colori ANSI solo su TTY; NO_COLOR anche vuota, TERM=dumb, pipe e --no-color', async context => {
  offline(context);
  const colored = await invoke(['ups'], environment, true);
  assert.match(colored.out, /\x1b\[1;36m/);
  assert.match(colored.out, /\x1b\[33mOL\x1b\[0m/);
  for (const [args, env, tty] of [
    [['ups'], environment, false], [['ups'], { ...environment, NO_COLOR: '' }, true],
    [['ups'], { ...environment, NO_COLOR: '1' }, true], [['ups'], { ...environment, TERM: 'dumb' }, true],
    [['ups', '--no-color'], environment, true], [['--no-color', 'ups'], environment, true],
  ]) {
    const result = await invoke(args, env, tty);
    assert.equal(result.code, 0);
    assert.doesNotMatch(result.out, ESCAPE);
  }
  assert.doesNotMatch((await invoke(['help'], { NO_COLOR: '' }, true)).out, ESCAPE);
});

test('comandi e argomenti invalidi: errore 2 prima di qualunque diagnostica', async context => {
  const { calls, reads } = offline(context);
  for (const args of [['lang', 'fr'], ['/ups'], ['unknown-secret'], ['ups', 'extra'], ['--color'], ['status;whoami']]) {
    const result = await invoke(args, environment);
    assert.equal(result.code, 2);
    assert.equal(result.out, '');
    assert.match(result.error, /raspi-guardian help/);
    assert.doesNotMatch(result.error, /unknown-secret|whoami/);
  }
  assert.equal(calls.length, 0);
  assert.equal(reads.length, 0);
});

test('status e ups richiedono la destinazione NUT, validazione condivisa senza valori negli errori', async context => {
  const { calls } = offline(context);
  for (const view of ['status', 'ups']) {
    for (const value of [undefined, '', '-l', 'ups;whoami', 'ups@host:65536', 'private-invalid!']) {
      const env = value === undefined ? {} : { GUARDIAN_UPS_NAME: value };
      const result = await invoke([view], env);
      assert.equal(result.code, 2);
      assert.match(result.error, /GUARDIAN_UPS_NAME/);
      assert.doesNotMatch(result.error, /private-invalid|whoami/);
      assert.equal(result.out, '');
    }
  }
  for (const target of ['ups', 'ups@192.0.2.1:3493', 'ups@[2001:db8::1]:3493']) {
    assert.equal((await invoke(['ups'], { GUARDIAN_UPS_NAME: target })).code, 0);
    assert.deepEqual(calls.at(-1).args, [target]);
  }
});

test('Docker disabilitato per default: comando esplicito rifiutato, status senza accesso al socket', async context => {
  const { calls } = offline(context);
  for (const docker of [undefined, 'false']) {
    const env = { ...environment, ...(docker === undefined ? {} : { GUARDIAN_DOCKER_ENABLED: docker }) };
    const result = await invoke(['docker'], env);
    assert.equal(result.code, 2);
    assert.match(result.error, /Docker disabled/);
    assert.doesNotMatch((await invoke(['status'], env)).out, /Docker/);
  }
  assert.ok(calls.every(call => call.file !== '/usr/bin/docker'));
});

test('opzioni diagnostiche errate: exit 2, nessun valore sensibile o processo', async context => {
  const { calls } = offline(context);
  for (const env of [{ GUARDIAN_DOCKER_ENABLED: 'secret!' }, { GUARDIAN_IMPORTANT_MOUNTS: 'secret!' }]) {
    const result = await invoke(['status'], { ...environment, ...env });
    assert.equal(result.code, 2);
    assert.match(result.error, /GUARDIAN_/);
    assert.doesNotMatch(result.error, /secret/);
  }
  assert.equal(calls.length, 0);
});

test('client mancanti, timeout o permessi negati: exit 1 e riepilogo parziale leggibile', async context => {
  offline(context, { fail: ['upsc', 'findmnt', 'docker'] });
  const env = { ...environment, GUARDIAN_DOCKER_ENABLED: 'true' };
  for (const view of ['ups', 'disks', 'docker', 'status']) {
    const result = await invoke([view], env);
    assert.equal(result.code, 1);
    assert.match(result.out, /data unavailable/);
    assert.match(result.error, /incomplete diagnostics/);
    assert.doesNotMatch(result.out + result.error, /private|secrets/);
    if (view === 'status') assert.match(result.out, /RAM used:/);
  }
});

test('letture NUT e JSON non valide: errore; sensori assenti: n/a come nel bot', async context => {
  offline(context, { fail: ['system'], outputs: { upsc: 'ups.status: OL OB', findmnt: 'invalid JSON', docker: 'invalid JSON' } });
  for (const view of ['ups', 'disks', 'docker']) {
    assert.equal((await invoke([view], { ...environment, GUARDIAN_DOCKER_ENABLED: 'true' })).code, 1);
  }
  const result = await invoke(['system']);
  assert.equal(result.code, 0);
  assert.match(result.out, /RAM used: n\/a/);
  assert.match(result.out, /Temperature: n\/a/);
});

test('testo terminale: nessuna iniezione ANSI o reinterpretazione del markup escapato', () => {
  const raw = '<b>Header</b>\n<code>&lt;b&gt; &amp; &quot; &#39;</code>\x1b[31m\x9b2J\r';
  const text = terminalText(raw);
  assert.equal(text, 'Header\n<b> & " \'[31m2J');
  assert.doesNotMatch(text, ESCAPE);
  assert.equal(terminalText('&amp;lt;b&amp;gt;'), '&lt;b&gt;');
  for (const selector of ['', '\uFE0E', '\uFE0F']) {
    const headings = `<b>🖥${selector} Sistema</b>\n<b>🛡${selector} Raspi Guardian</b>\n<b>🔋 UPS</b>\n<b>💾 Filesystem</b>\n<b>🐳 Docker</b>`;
    const expected = '🖥\uFE0F Sistema\n🛡\uFE0F Raspi Guardian\n🔋 UPS\n💾 Filesystem\n🐳 Docker';
    assert.equal(terminalText(headings), expected);
    assert.equal(terminalText(headings, true).replace(/\x1b\[[0-9;]*m/g, ''), expected);
  }
});

async function launch(file, args, options) {
  // Regular files also work on hosts that restrict child-process output pipes.
  const directory = await fs.mkdtemp(join(tmpdir(), 'raspi-guardian-launch-'));
  const stdoutFile = await fs.open(join(directory, 'stdout'), 'wx', 0o600);
  const stderrFile = await fs.open(join(directory, 'stderr'), 'wx', 0o600);
  try {
    const status = await new Promise((resolve, reject) => {
      const child = spawn(file, args, { ...options, stdio: ['ignore', stdoutFile.fd, stderrFile.fd] });
      child.on('error', reject);
      child.on('close', resolve);
    });
    return {
      status,
      stdout: await fs.readFile(join(directory, 'stdout'), 'utf8'),
      stderr: await fs.readFile(join(directory, 'stderr'), 'utf8'),
    };
  } finally {
    await stdoutFile.close();
    await stderrFile.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('entrypoint reale e link nel PATH: termina senza token, rete o avvio Telegram', async context => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'raspi-guardian-cli-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const link = join(directory, 'raspi-guardian');
  await fs.symlink(resolve('bin/raspi-guardian'), link);
  const guard = `globalThis.fetch = () => { process.stderr.write('UNEXPECTED_NETWORK'); process.exit(97); };`;
  const env = { HOME: isolatedHome, PATH: process.env.PATH, NO_COLOR: '', TELEGRAM_BOT_TOKEN: '123456:fictional_test_only',
    TELEGRAM_CHAT_ID: '-12345', TELEGRAM_ALLOWED_USER_ID: '67890', GUARDIAN_UPS_NAME: 'test-ups' };
  for (const [args, expectedCode] of [[['help'], 0], [['system'], 0], [['lang'], 0]]) {
    const result = await launch(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(guard)}`, link, ...args], {
      env, encoding: 'utf8', timeout: 3000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, expectedCode, result.stderr);
    assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_NETWORK|avviato|polling|arrestato|fictional_test_only/);
    assert.doesNotMatch(result.stdout, ESCAPE);
  }
  const executable = await launch(link, ['help'], { env, encoding: 'utf8', timeout: 3000 });
  assert.ifError(executable.error);
  assert.equal(executable.status, 0);
  assert.match(executable.stdout, /Usage: raspi-guardian/);
});

async function languageEnvironment(context) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'raspi-guardian-language-'));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { HOME: join(directory, 'home'), XDG_CONFIG_HOME: join(directory, 'config') };
}

test('default CLI inglese: help e lang senza creare impostazioni', async context => {
  const env = await languageEnvironment(context);
  offline(context);
  assert.match((await invoke(['help'], env)).out, /Usage: raspi-guardian/);
  assert.match((await invoke(['lang'], env)).out, /Current CLI language: English \(en\)/);
  await assert.rejects(fs.stat(new CliSettings(env).directory), { code: 'ENOENT' });
});

test('CLI EN → IT → EN: conferma immediata e preferenza ricaricata a ogni invocazione', async context => {
  const env = await languageEnvironment(context);
  assert.match((await invoke(['lang'], env)).out, /English \(en\)/);
  for (const [language, confirmation, help] of [
    ['it', /Lingua CLI impostata: Italiano \(it\)/, /Uso: raspi-guardian/],
    ['en', /CLI language set: English \(en\)/, /Usage: raspi-guardian/],
  ]) {
    const saved = await invoke(['lang', language], env);
    assert.equal(saved.code, 0);
    assert.match(saved.out, confirmation);
    assert.match((await invoke(['help'], env)).out, help);
    assert.match((await invoke(['lang'], env)).out, new RegExp(`\\(${language}\\)`));
    assert.deepEqual(JSON.parse(await fs.readFile(new CliSettings(env).path, 'utf8')), { language });
  }
});

test('nuovo processo e nuova sessione SSH: HOME fallback, XDG e utenti indipendenti', async context => {
  const env = await languageEnvironment(context);
  const other = await languageEnvironment(context);
  const executable = resolve('bin/raspi-guardian');
  const session = async (args, userEnv) => {
    const result = await launch(process.execPath, [executable, ...args], {
      env: { PATH: process.env.PATH, NO_COLOR: '', ...userEnv }, timeout: 3000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  assert.match(await session(['lang', 'it'], env), /Italiano/);
  assert.match(await session(['help'], env), /Uso:/);
  assert.match(await session(['lang'], other), /English/);
  const homeOnly = { HOME: env.HOME };
  assert.match(await session(['lang'], homeOnly), /English/);
  assert.match(await session(['lang', 'it'], homeOnly), /Italiano/);
  assert.match(await session(['help'], { ...homeOnly, XDG_CONFIG_HOME: 'relative-ignored' }), /Uso:/);
  assert.equal(new CliSettings(homeOnly).path, join(env.HOME, '.config/raspi-guardian/cli.json'));
  assert.match(await session(['lang', 'en'], env), /English/);
  assert.match(await session(['help'], env), /Usage:/);
  assert.match(await session(['lang'], homeOnly), /Italiano/);
});

test('preferenze CLI e Telegram separate anche con la stessa directory di stato', async context => {
  const env = await languageEnvironment(context);
  const cli = new CliSettings(env);
  await invoke(['lang', 'it'], env);
  const bot = new Settings(cli.directory);
  await bot.setLanguage('en');
  const botContent = await fs.readFile(bot.path, 'utf8');
  assert.match((await invoke(['help'], { ...env, STATE_DIRECTORY: cli.directory })).out, /Uso:/);
  await invoke(['lang', 'en'], env);
  assert.equal(await fs.readFile(bot.path, 'utf8'), botContent);
  await bot.setLanguage('it');
  assert.match((await invoke(['lang'], env)).out, /English/);
  await bot.load();
  assert.equal(bot.language, 'it');
  assert.deepEqual(JSON.parse(await fs.readFile(cli.path, 'utf8')), { language: 'en' });
});

test('tutte le viste CLI IT/EN: intestazioni, valori descrittivi e dati tecnici', async context => {
  const env = { ...await languageEnvironment(context), ...environment,
    GUARDIAN_DOCKER_ENABLED: 'true', GUARDIAN_IMPORTANT_MOUNTS: '/,/srv/data' };
  offline(context, { outputs: { docker: [
    { Names: 'healthy-web', Status: 'Up 1 hour (healthy)' },
    { Names: 'unhealthy-db', Status: 'Up 1 hour (unhealthy)' },
    { Names: 'starting-worker', Status: 'Up 1 second (health: starting)' },
    { Names: 'no-check', Status: 'Up 1 hour' },
  ].map(row => JSON.stringify(row)).join('\n') } });
  for (const language of ['it', 'en']) {
    assert.equal((await invoke(['lang', language], env)).code, 0);
    const expected = language === 'it'
      ? [/Alimentazione: rete presente/, /Autonomia dichiarata:/, /Sistema.*\n.*Sistema/s, /Dischi/, /Container in esecuzione:/, /Uso:/]
      : [/Power: mains available/, /Reported runtime:/, /System.*\n.*System/s, /Disks/, /Running containers:/, /Usage:/];
    for (const [index, view] of ['status', 'ups', 'system', 'disks', 'docker', 'help'].entries()) {
      const result = await invoke([view], env);
      assert.equal(result.code, 0, view);
      assert.match(result.out, expected[index]);
      assert.doesNotMatch(result.out, ESCAPE);
      if (view === 'ups') {
        assert.match(result.out, /NUT: lab-ups@nut.example.org:3494/);
        assert.match(result.out, /Example & <model>/);
        assert.match(result.out, /OL/);
      }
      if (view === 'disks') {
        assert.match(result.out, /\/dev\/example · ext4/);
        assert.match(result.out, language === 'it' ? /Assente: \/srv\/data/ : /Missing: \/srv\/data/);
        assert.match(result.out, language === 'it' ? /Liberi:/ : /Free:/);
      }
      if (view === 'docker') {
        for (const technical of ['healthy-web', 'unhealthy-db', 'starting-worker', 'Up 1 hour (healthy)', 'Up 1 second (health: starting)']) {
          assert.ok(result.out.includes(technical));
        }
        assert.match(result.out, language === 'it' ? /✅ sano/ : /✅ healthy/);
        assert.match(result.out, language === 'it' ? /⚠️ non sano/ : /⚠️ unhealthy/);
        assert.match(result.out, language === 'it' ? /⏳ avvio in corso/ : /⏳ starting/);
        assert.match(result.out, language === 'it' ? /healthcheck non configurato/ : /healthcheck not configured/);
      }
    }
  }
});

test('errori CLI tradotti IT/EN: argomenti, configurazione, Docker e diagnostica', async context => {
  const env = await languageEnvironment(context);
  offline(context, { fail: ['upsc', 'findmnt', 'docker', 'system'] });
  for (const language of ['it', 'en']) {
    await invoke(['lang', language], env);
    for (const [args, diagnosticEnv, expectedCode, expected] of [
      [['lang', 'secret-invalid'], {}, 2, language === 'it' ? /Errore: comando/ : /Error: invalid command/],
      [['ups'], {}, 2, language === 'it' ? /deve essere una destinazione valida/ : /must be a valid/],
      [['system'], { GUARDIAN_DOCKER_ENABLED: 'secret-invalid' }, 2, language === 'it' ? /deve essere true o false/ : /must be true or false/],
      [['disks'], { GUARDIAN_IMPORTANT_MOUNTS: 'secret-invalid' }, 2, language === 'it' ? /deve contenere percorsi assoluti/ : /must contain comma-separated absolute paths/],
      [['docker'], {}, 2, language === 'it' ? /Docker disabilitato/ : /Docker disabled/],
      [['status'], environment, 1, language === 'it' ? /diagnostica incompleta/ : /incomplete diagnostics/],
    ]) {
      const result = await invoke(args, { ...env, ...diagnosticEnv });
      assert.equal(result.code, expectedCode);
      assert.match(result.error, expected);
      assert.doesNotMatch(result.out + result.error, /secret-invalid|private|secrets/);
      if (expectedCode === 1) {
        assert.match(result.out, language === 'it' ? /dati non disponibili/ : /data unavailable/);
        assert.match(result.out, language === 'it' ? /RAM usata: n\/d/ : /RAM used: n\/a/);
      }
    }
  }
});

test('preferenze CLI mancanti, corrotte, troppo grandi o non valide: inglese e recupero', async context => {
  const env = await languageEnvironment(context);
  const settings = new CliSettings(env);
  assert.match((await invoke(['lang'], env)).out, /English/);
  await fs.mkdir(settings.directory, { recursive: true, mode: 0o700 });
  for (const content of ['private-corrupt-content', 'null', '[]', '{}', '{"language":"fr"}',
    '{"language":42}', '{"language":{"it":true}}', 'x'.repeat(4097)]) {
    await fs.writeFile(settings.path, content, { mode: 0o600 });
    const result = await invoke(['lang'], env);
    assert.equal(result.code, 0);
    assert.match(result.out, /English/);
    assert.equal(result.error, '');
    assert.equal(await fs.readFile(settings.path, 'utf8'), content);
  }
  assert.equal((await invoke(['lang', 'it'], env)).code, 0);
  assert.match((await invoke(['help'], env)).out, /Uso:/);
});

test('scrittura CLI privata e atomica: solo lingua, nessuna credenziale e nessun temporaneo', async context => {
  const env = { ...await languageEnvironment(context), TELEGRAM_BOT_TOKEN: 'fictional-secret' };
  const settings = new CliSettings(env);
  await invoke(['lang', 'en'], env);
  const originalRename = fs.rename;
  const rename = mock.method(fs, 'rename', async (source, target) => {
    assert.equal(target, settings.path);
    assert.equal((await fs.stat(source)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(source, 'utf8')), { language: 'it' });
    assert.deepEqual(JSON.parse(await fs.readFile(target, 'utf8')), { language: 'en' });
    await originalRename(source, target);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await invoke(['lang', 'it'], env)).code, 0);
    assert.equal(rename.mock.callCount(), 1);
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal((await fs.stat(settings.directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(settings.path)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(settings.directory), ['cli.json']);
});

test('salvataggio CLI fallito: errore tradotto, preferenza intatta e temporanei rimossi', async context => {
  const env = await languageEnvironment(context);
  const settings = new CliSettings(env);
  for (const language of ['it', 'en']) {
    await invoke(['lang', language], env);
    const original = await fs.readFile(settings.path, 'utf8');
    const rename = mock.method(fs, 'rename', async () => { throw new Error('private-disk-error'); });
    syncBuiltinESMExports();
    try {
      const result = await invoke(['lang', language === 'it' ? 'en' : 'it'], env);
      assert.equal(result.code, 1);
      assert.match(result.error, language === 'it' ? /impossibile salvare la lingua CLI/ : /unable to save the CLI language/);
      assert.doesNotMatch(result.error, /private-disk-error/);
      assert.equal(await fs.readFile(settings.path, 'utf8'), original);
      assert.deepEqual(await fs.readdir(settings.directory), ['cli.json']);
    } finally {
      rename.mock.restore();
      syncBuiltinESMExports();
    }
  }
});

test('sicurezza CLI: symlink, directory al posto del file e permessi pubblici', async context => {
  const env = await languageEnvironment(context);
  const settings = new CliSettings(env);
  await invoke(['lang', 'en'], env);
  const target = join(settings.directory, 'unrelated.json');
  await fs.writeFile(target, '{"language":"it"}', { mode: 0o600 });
  await fs.unlink(settings.path);
  await fs.symlink(target, settings.path);
  assert.match((await invoke(['lang'], env)).out, /English/);
  assert.equal((await invoke(['lang', 'en'], env)).code, 0);
  assert.equal((await fs.lstat(settings.path)).isSymbolicLink(), false);
  assert.equal(await fs.readFile(target, 'utf8'), '{"language":"it"}');
  await fs.unlink(settings.path);
  await fs.mkdir(settings.path);
  assert.match((await invoke(['lang'], env)).out, /English/);
  assert.equal((await invoke(['lang', 'it'], env)).code, 1);
  await fs.rmdir(settings.path);
  await fs.writeFile(settings.path, '{"language":"it"}', { mode: 0o644 });
  assert.match((await invoke(['lang'], env)).out, /English/);
  await invoke(['lang', 'it'], env);
  assert.equal((await fs.stat(settings.path)).mode & 0o777, 0o600);
  await fs.chmod(settings.directory, 0o755);
  assert.match((await invoke(['lang'], env)).out, /English/);
  await invoke(['lang', 'it'], env);
  assert.equal((await fs.stat(settings.directory)).mode & 0o777, 0o700);
  const unsafeEnv = await languageEnvironment(context);
  await fs.mkdir(unsafeEnv.XDG_CONFIG_HOME, { recursive: true });
  await fs.symlink(settings.directory, new CliSettings(unsafeEnv).directory);
  assert.match((await invoke(['lang'], unsafeEnv)).out, /English/);
  assert.equal((await invoke(['lang', 'en'], unsafeEnv)).code, 1);
  assert.match((await invoke(['lang'], env)).out, /Italiano/);
});

test('colori, Unicode, spaziatura e NO_COLOR preservati anche in italiano', async context => {
  const env = { ...await languageEnvironment(context), ...environment };
  await invoke(['lang', 'it'], env);
  offline(context);
  const colored = await invoke(['status'], env, true);
  assert.match(colored.out, /\x1b\[1;36m🛡️ Raspi Guardian/);
  assert.match(colored.out, /🖥️ Sistema/);
  const plain = await invoke(['status'], { ...env, NO_COLOR: '' }, true);
  assert.equal(colored.out.replace(/\x1b\[[0-9;]*m/g, ''), plain.out);
  assert.doesNotMatch(plain.out, ESCAPE);
  assert.match(plain.out, /^╭─ 🛡️ Raspi Guardian/);
  assert.match(plain.out, /\n│  /);
  assert.match(plain.out, /\n╰─\n$/);
  for (const args of [['help'], ['lang'], ['ups', '--no-color']]) {
    assert.doesNotMatch((await invoke(args, { ...env, NO_COLOR: '' }, true)).out, ESCAPE);
  }
});
