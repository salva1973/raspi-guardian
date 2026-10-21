import { loadDiagnosticConfig } from './config.mjs';
import { diagnosticReport } from './diagnostics.mjs';
import { t } from './i18n.mjs';
import { isLanguage } from './settings.mjs';
import { CliSettings } from './cli-settings.mjs';

const VIEWS = new Set(['status', 'ups', 'system', 'disks', 'docker', 'help', 'lang']);

function colorsEnabled(env, output, noColor) {
  return Boolean(output.isTTY && env.TERM !== 'dumb' && env.NO_COLOR === undefined && !noColor);
}

// Adatta soltanto il markup prodotto dal motore condiviso. Decodifica dopo i tag:
// dati come &lt;b&gt; restano testo, mai markup o sequenze di controllo terminale.
export function terminalText(text, color = false) {
  return text
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '')
    // Presentazione emoji per le icone testuali: larghezza coerente e spazio esplicito.
    .replace(/(<b>[🖥🛡])[\uFE0E\uFE0F]? */gu, '$1\uFE0F ')
    .replace(/<\/?(b|i|code)>/g, (tag, kind) => {
      if (!color) return '';
      return tag.startsWith('</') ? '\x1b[0m'
        : { b: '\x1b[1;36m', i: '\x1b[2m', code: '\x1b[33m' }[kind];
    })
    .replace(/&(amp|lt|gt|quot|#39);/g, (_, entity) => ({
      amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'",
    })[entity]);
}

export async function runCli(args, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const settings = new CliSettings(env);
  await settings.load();
  const language = settings.language;
  const noColor = args.includes('--no-color');
  const positional = args.filter(arg => arg !== '--no-color');
  const view = positional[0] ?? 'help';
  if (!VIEWS.has(view) || (view === 'lang'
    ? positional.length > 2 || (positional.length === 2 && !isLanguage(positional[1]))
    : positional.length > 1)) {
    stderr.write(`${t(language, 'cliInvalidArguments')}\n`);
    return 2;
  }
  if (view === 'lang') {
    if (positional.length === 2) {
      try {
        await settings.setLanguage(positional[1]);
      } catch {
        stderr.write(`${t(language, 'cliLanguageFailed')}\n`);
        return 1;
      }
    }
    stdout.write(`${t(settings.language, positional.length === 2 ? 'cliLanguageSaved' : 'cliLanguageCurrent', {
      language: t(settings.language, settings.language === 'it' ? 'languageNameIt' : 'languageNameEn'),
      code: settings.language,
    })}\n`);
    return 0;
  }
  const color = colorsEnabled(env, stdout, noColor);
  if (view === 'help') {
    stdout.write(`${color ? '\x1b[1;36m' : ''}╭─ Raspi Guardian · ${t(language, 'cliTitle')}${color ? '\x1b[0m' : ''}\n${t(language, 'cliHelp')}`);
    return 0;
  }
  let config;
  try {
    config = loadDiagnosticConfig(env, { requireUps: ['status', 'ups'].includes(view), language });
  } catch (error) {
    stderr.write(`${t(language, 'cliError', { message: error.message })}\n`);
    return 2;
  }
  if (view === 'docker' && !config.dockerEnabled) {
    stderr.write(`${t(language, 'cliDockerDisabled')}\n`);
    return 2;
  }
  try {
    const report = await diagnosticReport(view, config, undefined, language);
    const viewTitle = { ups: 'UPS', system: t(language, 'system'), disks: t(language, 'disks'), docker: 'Docker' }[view];
    const title = view === 'status' ? '' : `<b>Raspi Guardian · ${viewTitle}</b>\n`;
    stdout.write(`${terminalText(`${title}${report.text}`, color).split('\n').map((line, i) => `${i === 0 ? '╭─' : '│ '} ${line}`).join('\n')}\n╰─\n`);
    if (report.failures.length) {
      stderr.write(`${t(language, 'cliIncomplete')}\n`);
      return 1;
    }
    return 0;
  } catch {
    stderr.write(`${t(language, 'cliUnavailable')}\n`);
    return 1;
  }
}
