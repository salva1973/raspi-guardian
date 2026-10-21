import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { t } from './i18n.mjs';
import { Settings } from './settings.mjs';
import { loadDiagnosticConfig } from './config.mjs';
import { compactRows, diagnosticReport, duration, number, quantity, readUps } from './diagnostics.mjs';
// Compatibilità con le importazioni esistenti.
export { disksText, dockerText, html, parseUps, upsText } from './diagnostics.mjs';

const UPS_INTERVAL_MS = 5_000;
const BLACKOUT_MS = 30_000;
const VIEWS = new Set(['start', 'help', 'status', 'ups', 'system', 'disks', 'docker', 'lang']);

export function loadConfig(env) {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN ?? '') ||
      !/^-?[1-9]\d*$/.test(env.TELEGRAM_CHAT_ID ?? '') ||
      !/^[1-9]\d*$/.test(env.TELEGRAM_ALLOWED_USER_ID ?? '')) {
    throw new Error('Configurazione Telegram mancante o non valida. Controllare le tre variabili richieste.');
  }
  const diagnostics = loadDiagnosticConfig(env);
  const warning = env.GUARDIAN_SHUTDOWN_WARNING_SECONDS;
  const shutdownWarningSeconds = warning === undefined || warning === '' ? null : Number(warning);
  if (shutdownWarningSeconds !== null &&
      (!/^[1-9]\d*$/.test(warning) || !Number.isSafeInteger(shutdownWarningSeconds * 1000))) {
    throw new Error('GUARDIAN_SHUTDOWN_WARNING_SECONDS must be a positive whole number of seconds.');
  }
  return {
    token: env.TELEGRAM_BOT_TOKEN,
    chatId: env.TELEGRAM_CHAT_ID,
    userId: env.TELEGRAM_ALLOWED_USER_ID,
    ...diagnostics,
    shutdownWarningSeconds,
  };
}

function keyboard(view, language, config) {
  const rows = [
    [{ text: `📊 ${t(language, 'status')}`, callback_data: 'status' }, { text: '🔋 UPS', callback_data: 'ups' }],
    [{ text: `🖥 ${t(language, 'system')}`, callback_data: 'system' }, { text: `💾 ${t(language, 'disks')}`, callback_data: 'disks' }],
    [...(config.dockerEnabled ? [{ text: '🐳 Docker', callback_data: 'docker' }] : []),
      { text: `❔ ${t(language, 'help')}`, callback_data: 'help' }],
    [{ text: `🌐 ${t(language, 'language')}`, callback_data: 'lang' }],
    [{ text: `↻ ${t(language, 'refresh')}`, callback_data: view }],
  ];
  if (view === 'lang') rows.unshift([
    { text: '🇮🇹 Italiano', callback_data: 'lang:it' },
    { text: '🇬🇧 English', callback_data: 'lang:en' },
  ]);
  return { inline_keyboard: rows };
}

export async function render(view, config, signal, language = 'en') {
  if (view === 'start' || view === 'help') return t(language, 'start', {
    dockerCommand: config.dockerEnabled ? t(language, 'dockerCommand') : '',
  });
  if (view === 'lang') return t(language, 'languageMenu');
  return (await diagnosticReport(view, config, signal, language)).text;
}

export function authorizedAction(update, config) {
  const callback = update.callback_query;
  const message = callback ? callback.message : update.message;
  const user = callback ? callback.from : message?.from;
  if (String(message?.chat?.id) !== config.chatId || String(user?.id) !== config.userId || user?.is_bot) return null;
  if (callback) {
    if (!Number.isSafeInteger(message.message_id) || !callback.id) return null;
    if (callback.data === 'lang:it' || callback.data === 'lang:en') {
      return { view: 'lang', language: callback.data.slice(5), messageId: message.message_id, callbackId: callback.id };
    }
    if (!VIEWS.has(callback.data)) return null;
    if (callback.data === 'docker' && !config.dockerEnabled) return null;
    return { view: callback.data, messageId: message.message_id, callbackId: callback.id };
  }
  const match = /^\/([a-z]+)(?:@([A-Za-z0-9_]+))?(?:\s+([^\r\n]*?))?\s*$/.exec(message?.text ?? '');
  if (!match || !VIEWS.has(match[1])) return null;
  const [, view, botUsername, argument] = match;
  if (view === 'docker' && !config.dockerEnabled) return null;
  if (view === 'lang') {
    if (!argument) return { view, botUsername };
    return argument === 'it' || argument === 'en'
      ? { view, botUsername, language: argument }
      : { view, botUsername, invalidLanguage: true };
  }
  return argument ? null : { view, botUsername };
}

class TelegramError extends Error {
  constructor(code, retryAfter = 0) {
    super('Richiesta Telegram non riuscita.');
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

function telegramClient(config, signal) {
  let cooldownUntil = 0;
  return async (method, payload = {}) => {
    if (cooldownUntil > performance.now()) await pause(cooldownUntil - performance.now(), signal);
    const response = await fetch(`https://api.telegram.org/bot${config.token}/${method}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.any([signal, AbortSignal.timeout(method === 'getUpdates' ? 35_000 : 10_000)]),
    });
    const body = await response.json();
    if (!response.ok || !body.ok) {
      const retryAfter = Math.min(3600, number(body.parameters?.retry_after) ?? 0);
      cooldownUntil = performance.now() + retryAfter * 1000;
      // Non propagare descrizioni o risposte remote: potrebbero contenere dati sensibili.
      const code = typeof body.description === 'string' && body.description.includes('message is not modified')
        ? 'MESSAGE_NOT_MODIFIED' : body.error_code ?? response.status;
      throw new TelegramError(code, retryAfter);
    }
    return body.result;
  };
}

async function pause(ms, signal) {
  await delay(ms, undefined, { signal });
}

// Stato solo in memoria, distinto per ogni episodio di alimentazione a batteria.
export class UpsMonitor {
  outageSince = null;
  sent = new Set();
  criticalSent = false;

  constructor(shutdownWarningSeconds = null) {
    this.warningMs = shutdownWarningSeconds === null ? null : shutdownWarningSeconds * 1000;
  }

  async observe(ups, now, notify, getLanguage = () => 'en') {
    if (ups.power === 'battery') {
      this.outageSince ??= now;
      const elapsed = now - this.outageSince;
      if (elapsed >= BLACKOUT_MS && !this.sent.has('blackout')) {
        const language = getLanguage();
        await notify(t(language, 'blackout', {
          charge: quantity(ups.data['battery.charge'], '%', language),
          runtime: duration(ups.data['battery.runtime'], language),
        }));
        this.sent.add('blackout');
      }
      if (ups.critical && !this.criticalSent) {
        await notify(t(getLanguage(), 'criticalBattery'));
        this.criticalSent = true;
      }
      if (this.warningMs !== null && elapsed >= this.warningMs && !this.sent.has('warning')) {
        const language = getLanguage();
        await notify(t(language, 'shutdownWarning', {
          elapsed: duration(elapsed / 1000, language),
          threshold: duration(this.warningMs / 1000, language),
        }));
        this.sent.add('warning');
      }
    } else if (ups.power === 'online') {
      if (this.outageSince !== null) {
        const language = getLanguage();
        await notify(t(language, 'restored', { duration: duration((now - this.outageSince) / 1000, language) }));
        this.outageSince = null;
        this.sent.clear();
      }
      // FSD può restare attivo anche al ritorno della rete.
      if (ups.critical && !this.criticalSent) {
        await notify(t(getLanguage(), 'criticalOnline'));
        this.criticalSent = true;
      }
      if (!ups.critical) this.criticalSent = false;
    }
  }
}

async function monitorUps(api, config, signal, settings) {
  const monitor = new UpsMonitor(config.shutdownWarningSeconds);
  let unavailable = false;
  while (!signal.aborted) {
    let ups;
    try {
      ups = await readUps(config, signal);
      if (unavailable) console.info('Lettura UPS nuovamente disponibile.');
      unavailable = false;
    } catch {
      if (!signal.aborted && !unavailable) console.warn('Lettura UPS non disponibile; stato precedente conservato.');
      unavailable = true;
    }
    if (ups && !signal.aborted) {
      try {
        await monitor.observe(ups, performance.now(), text => api('sendMessage', {
          chat_id: config.chatId, text, parse_mode: 'HTML', reply_markup: keyboard('ups', settings.language, config),
        }), () => settings.language);
      } catch {
        if (!signal.aborted) console.warn('Invio avviso UPS non riuscito; nuovo tentativo al prossimo controllo.');
      }
    }
    await pause(UPS_INTERVAL_MS, signal);
  }
}

async function poll(api, config, signal, botUsername, settings) {
  let offset = 0;
  let backoff = 2_000;
  while (!signal.aborted) {
    let updates;
    try {
      updates = await api('getUpdates', { offset, timeout: 25, limit: 20, allowed_updates: ['message', 'callback_query'] });
      backoff = 2_000;
    } catch (error) {
      if (signal.aborted) return;
      if ([401, 404, 409].includes(error.code)) {
        console.error('Polling interrotto: verificare credenziali, webhook assente e singola istanza del bot.');
        throw new Error('Polling non disponibile.');
      }
      console.warn('Polling Telegram non disponibile; nuovo tentativo automatico.');
      await pause(Math.max(backoff, (error.retryAfter ?? 0) * 1000), signal);
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }
    for (const update of updates) {
      if (signal.aborted) return;
      offset = update.update_id + 1;
      const action = authorizedAction(update, config);
      if (!action || (action.botUsername && action.botUsername.toLowerCase() !== botUsername.toLowerCase())) continue;
      try {
        if (action.callbackId) await api('answerCallbackQuery', { callback_query_id: action.callbackId });
        let result;
        if (action.language) {
          try {
            await settings.setLanguage(action.language);
            result = t(settings.language, 'languageSaved');
          } catch {
            result = t(settings.language, 'languageFailed');
          }
        } else if (action.invalidLanguage) {
          result = t(settings.language, 'languageUsage');
        }
        const language = settings.language;
        result ??= await render(action.view, config, signal, language);
        const text = compactRows('', result.split('\n'), language).trimStart();
        const payload = { chat_id: config.chatId, text, parse_mode: 'HTML', reply_markup: keyboard(action.view, language, config) };
        if (action.callbackId) {
          payload.message_id = action.messageId;
        }
        await api(action.callbackId ? 'editMessageText' : 'sendMessage', payload);
      } catch (error) {
        if (!signal.aborted && error.code !== 'MESSAGE_NOT_MODIFIED') console.warn('Risposta Telegram non riuscita.');
      }
    }
  }
}

export async function main({ stateDirectory } = {}) {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  const settings = new Settings(stateDirectory);
  await settings.load();
  const controller = new AbortController();
  let requestedStop = false;
  const stop = () => {
    requestedStop = true;
    controller.abort();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  const api = telegramClient(config, controller.signal);
  try {
    const bot = await api('getMe');
    console.info('Raspi Guardian avviato: long polling e monitoraggio UPS attivi.');
    const tasks = [poll(api, config, controller.signal, bot.username, settings), monitorUps(api, config, controller.signal, settings)];
    try {
      await Promise.all(tasks);
    } finally {
      controller.abort();
      await Promise.allSettled(tasks);
    }
  } catch {
    if (!requestedStop) {
      console.error('Avvio o esecuzione non riusciti. Verificare rete e configurazione Telegram.');
      process.exitCode = 1;
    }
  } finally {
    controller.abort();
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    console.info('Raspi Guardian arrestato.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Non stampare stack/errori fetch: gli URL delle richieste includono il token.
  main().catch(() => {
    console.error('Errore interno. Nessun dettaglio sensibile registrato.');
    process.exitCode = 1;
  });
}
