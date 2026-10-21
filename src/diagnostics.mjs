import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { t } from './i18n.mjs';

const LOCAL_TIMEOUT_MS = 5_000;
const MAX_TEXT = 3_800;
// La destinazione UPS è validata dalla configurazione. I processi figli non ereditano i segreti.
const COMMANDS = {
  disks: ['/usr/bin/findmnt', ['--json', '--list', '--df', '--bytes', '--output',
    'TARGET,SOURCE,FSTYPE,SIZE,AVAIL,USE%']],
  docker: ['/usr/bin/docker', ['container', 'ls', '--format', '{{json .}}']],
};

export function html(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

function field(value, language = 'en', max = 150) {
  return html(String(value ?? t(language, 'unavailable')).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max));
}

export function number(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function quantity(value, unit, language = 'en') {
  const n = number(value);
  return n === null ? t(language, 'unavailable') : `${Math.round(n * 10) / 10} ${unit}`;
}

function bytes(value, language = 'en') {
  const n = number(value);
  if (n === null) return t(language, 'unavailable');
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GiB` : `${(n / 1024 ** 2).toFixed(0)} MiB`;
}

export function duration(seconds, language = 'en') {
  const n = number(seconds);
  if (n === null) return t(language, 'unavailable');
  const minutes = Math.floor(n / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min ${Math.floor(n % 60)} s`;
}

function runLocal(name, signal, config) {
  const [file, args] = name === 'ups' ? ['/usr/bin/upsc', [config.upsName]] : COMMANDS[name];
  return new Promise((resolve, reject) => {
    execFile(file, args, {
      shell: false,
      timeout: LOCAL_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      signal,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
    }, (error, stdout) => error ? reject(new Error('Diagnostica locale non disponibile.')) : resolve(stdout));
  });
}

export function parseUps(text) {
  const data = Object.fromEntries(text.split('\n').flatMap(line => {
    const colon = line.indexOf(':');
    return colon < 0 ? [] : [[line.slice(0, colon).trim(), line.slice(colon + 1).trim()]];
  }));
  const flags = new Set((data['ups.status'] ?? '').split(/\s+/));
  // OL e OB simultanei o entrambi assenti non confermano l'alimentazione.
  const power = flags.has('OB') && !flags.has('OL') ? 'battery'
    : flags.has('OL') && !flags.has('OB') ? 'online' : 'unknown';
  if (power === 'unknown') throw new Error('Stato alimentazione UPS non valido.');
  return { data, flags, power, critical: flags.has('LB') || flags.has('FSD') };
}

export async function readUps(config, signal) {
  return parseUps(await runLocal('ups', signal, config));
}

export function upsText(ups, language = 'en', upsName) {
  const d = ups.data;
  return [
    '<b>🔋 UPS</b>',
    `${t(language, 'power')}: <b>${t(language, ups.power === 'online' ? 'online' : 'battery')}</b>`,
    `${t(language, 'nutStatus')}: <code>${field(d['ups.status'], language)}</code>${ups.critical ? ` ⚠️ ${t(language, 'critical')}` : ''}`,
    `${t(language, 'charge')}: ${quantity(d['battery.charge'], '%', language)}`,
    `${t(language, 'runtime')}: ${duration(d['battery.runtime'], language)}`,
    `<i>${t(language, 'runtimeNote')}</i>`,
    `${t(language, 'upsLoad')}: ${quantity(d['ups.load'], '%', language)}`,
    `${t(language, 'input')}: ${quantity(d['input.voltage'], 'V', language)}`,
    `${t(language, 'model')}: ${field(d['ups.mfr'], language)} ${field(d['ups.model'], language)}`,
    `NUT: <code>${field(upsName, language, 512)}</code>`,
  ].join('\n');
}

async function systemText(signal, language) {
  const [memory, thermal] = await Promise.allSettled([
    readFile('/proc/meminfo', { encoding: 'utf8', signal }),
    readFile('/sys/class/thermal/thermal_zone0/temp', { encoding: 'utf8', signal }),
  ]);
  let ram = t(language, 'unavailable');
  if (memory.status === 'fulfilled') {
    const total = number(memory.value.match(/^MemTotal:\s+(\d+)/m)?.[1]);
    const available = number(memory.value.match(/^MemAvailable:\s+(\d+)/m)?.[1]);
    if (total > 0 && available !== null) {
      ram = `${bytes((total - available) * 1024, language)} / ${bytes(total * 1024, language)} (${Math.round((1 - available / total) * 100)}%)`;
    }
  }
  const temperature = thermal.status === 'fulfilled' ? number(thermal.value) : null;
  return [
    `<b>🖥 ${t(language, 'system')}</b>`,
    `Host: ${field(os.hostname(), language)}`,
    `Uptime: ${duration(os.uptime(), language)}`,
    `${t(language, 'cpuLoad')}: ${os.loadavg().map(n => n.toFixed(2)).join(' / ')} (${os.availableParallelism()} ${t(language, 'cores')})`,
    `${t(language, 'usedRam')}: ${ram}`,
    `${t(language, 'temperature')}: ${temperature === null ? t(language, 'unavailable') : quantity(temperature / 1000, '°C', language)}`,
  ].join('\n');
}

// Taglia soltanto righe complete, mantenendo validi i tag HTML e le entità.
export function compactRows(header, rows, language = 'en') {
  let text = header;
  for (let i = 0; i < rows.length; i++) {
    if (text.length + rows[i].length + 90 > MAX_TEXT) {
      return `${text}\n${t(language, 'omitted', { count: rows.length - i })}`;
    }
    text += `\n${rows[i]}`;
  }
  return text;
}

export function disksText(output, importantMounts, language = 'en') {
  const mounts = JSON.parse(output).filesystems;
  if (!Array.isArray(mounts) || !mounts.length || mounts.some(m => typeof m.target !== 'string')) {
    throw new Error('Elenco filesystem non valido.');
  }
  const mounted = new Set(mounts.map(m => m.target));
  const missing = importantMounts.filter(p => !mounted.has(p));
  const warnings = missing.length
    ? t(language, 'missingMounts', { count: missing.length })
    : t(language, 'mountsPresent');
  // Prima i mount importanti, poi gli altri. Pseudo-filesystem esclusi da findmnt --df.
  mounts.sort((a, b) => Number(importantMounts.includes(b.target)) - Number(importantMounts.includes(a.target)));
  return compactRows(`<b>💾 Filesystem</b>\n${warnings}`, [
    ...missing.map(p => `⚠️ ${t(language, 'missing')}: <code>${field(p, language)}</code>`),
    ...mounts.map(m => {
      const used = number(String(m['use%'] ?? '').replace('%', ''));
      return `\n<b>${field(m.target, language)}</b>${used !== null && used >= 90 ? ' ⚠️' : ''}\n` +
        `${field(m.source, language)} · ${field(m.fstype, language)}\n` +
        `${t(language, 'free')}: ${bytes(m.avail, language)} / ${bytes(m.size, language)} · ${t(language, 'used')} ${used === null ? t(language, 'unavailable') : `${used}%`}`;
    }),
  ], language);
}

export function dockerText(output, language = 'en') {
  const containers = output.trim() ? output.trim().split('\n').map(line => JSON.parse(line)) : [];
  return compactRows(`<b>🐳 Docker</b>\n${t(language, 'containers')}: <b>${containers.length}</b>`, containers.map(c => {
    const status = String(c.Status ?? t(language, 'unavailable'));
    const health = status.includes('(unhealthy)') ? `⚠️ ${t(language, 'unhealthy')}`
      : status.includes('(healthy)') ? `✅ ${t(language, 'healthy')}`
        : status.includes('(health: starting)') ? `⏳ ${t(language, 'healthStarting')}` : t(language, 'noHealthcheck');
    return `\n<b>${field(c.Names, language)}</b> · ${health}\n${field(status, language)}`;
  }), language);
}

async function diagnostic(view, config, signal, language, failures) {
  try {
    if (view === 'ups') return upsText(await readUps(config, signal), language, config.upsName);
    if (view === 'system') return await systemText(signal, language);
    if (view === 'disks') return disksText(await runLocal('disks', signal), config.importantMounts, language);
    if (view === 'docker' && config.dockerEnabled) return dockerText(await runLocal('docker', signal), language);
  } catch {
    failures.push(view);
    return t(language, 'diagnosticFailed', {
      view: { ups: 'UPS', system: t(language, 'system'), disks: t(language, 'disks'), docker: 'Docker' }[view],
    });
  }
}

export async function diagnosticReport(view, config, signal, language = 'en') {
  const failures = [];
  if (view === 'status') {
    const views = ['ups', 'system', 'disks', ...(config.dockerEnabled ? ['docker'] : [])];
    const sections = await Promise.all(views.map(v => diagnostic(v, config, signal, language, failures)));
    // Riepilogo breve condiviso; le viste dedicate mostrano i dettagli.
    const summaries = sections.map((text, i) => text.split('\n').slice(0, [4, 6, 6, 2][i]).join('\n'));
    return { text: `<b>🛡 Raspi Guardian</b>\n\n${summaries.join('\n\n')}`, failures };
  }
  return { text: await diagnostic(view, config, signal, language, failures), failures };
}
