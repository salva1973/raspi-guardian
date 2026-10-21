export const translations = {
  it: {
    cores: 'core',
    healthy: 'sano',
    unhealthy: 'non sano',
    healthStarting: 'avvio in corso',
    invalidUpsName: 'GUARDIAN_UPS_NAME deve essere una destinazione valida upsname[@hostname[:port]].',
    invalidDockerEnabled: 'GUARDIAN_DOCKER_ENABLED deve essere true o false.',
    invalidMounts: 'GUARDIAN_IMPORTANT_MOUNTS deve contenere percorsi assoluti separati da virgole.',
    cliTitle: 'CLI locale',
    cliInvalidArguments: 'Errore: comando o argomenti non validi. Usa raspi-guardian help.',
    cliError: 'Errore: {message}',
    cliDockerDisabled: 'Errore: Docker disabilitato. Imposta GUARDIAN_DOCKER_ENABLED=true per abilitarne la lettura.',
    cliIncomplete: 'Errore: diagnostica incompleta. Verificare servizi, client locali e permessi.',
    cliUnavailable: 'Errore: diagnostica locale non disponibile.',
    cliLanguageCurrent: 'Lingua CLI attuale: {language} ({code}).',
    cliLanguageSaved: '✅ Lingua CLI impostata: {language} ({code}).',
    cliLanguageFailed: 'Errore: impossibile salvare la lingua CLI. La preferenza precedente resta invariata. Verificare permessi e spazio nella directory di configurazione utente.',
    languageNameIt: 'Italiano',
    languageNameEn: 'Inglese',
    cliHelp: `Uso: raspi-guardian <comando> [--no-color]

  status   Riepilogo UPS, sistema e dischi; Docker se abilitato
  ups      Alimentazione, batteria e destinazione NUT
  system   Uptime, CPU, RAM e temperatura
  disks    Mount e spazio libero
  docker   Container attivi e health (richiede abilitazione)
  help     Questa guida
  lang     Mostra la lingua CLI attuale
  lang it|en  Salva la lingua CLI per questo utente Linux

Opzioni diagnostiche nell'ambiente:
  GUARDIAN_UPS_NAME            Destinazione NUT upsname[@hostname[:port]]
                              Obbligatoria per status e ups; nessun default
  GUARDIAN_IMPORTANT_MOUNTS    Mount attesi separati da virgole (default: /)
  GUARDIAN_DOCKER_ENABLED      true / false (default: false)

Colori automatici su TTY; NO_COLOR, TERM=dumb o --no-color li disabilitano.
Non occorre configurare Telegram. Lingua predefinita: inglese.
Preferenza CLI: $XDG_CONFIG_HOME/raspi-guardian/cli.json oppure
$HOME/.config/raspi-guardian/cli.json. La lingua Telegram è indipendente.
`,
    unavailable: 'n/d',
    start: '<b>🛡 Raspi Guardian</b>\n\n/status — riepilogo generale\n/ups — alimentazione e batteria\n/system — uptime, CPU, RAM, temperatura\n/disks — mount e spazio libero\n{dockerCommand}/lang — selezione lingua\n/start · /help — comandi e pulsanti\n\nAvvisi UPS automatici attivi. Lo shutdown resta gestito da NUT.',
    dockerCommand: '/docker — container attivi e health\n',
    languageMenu: '<b>🌐 Lingua</b>\nLingua attuale: Italiano.\nScegli la lingua per questo gruppo.',
    languageSaved: '✅ Lingua impostata: Italiano.',
    languageUsage: '⚠️ Usa /lang, /lang it oppure /lang en.',
    languageFailed: '⚠️ Impossibile salvare la lingua. La lingua precedente resta attiva. Verificare la directory di stato del servizio.',
    status: 'Stato', system: 'Sistema', disks: 'Dischi', help: 'Aiuto', refresh: 'Aggiorna', language: 'Lingua',
    power: 'Alimentazione', online: 'rete presente', battery: 'a batteria', nutStatus: 'Stato NUT', critical: 'critico',
    charge: 'Carica', runtime: 'Autonomia dichiarata',
    runtimeNote: 'Stima fornita dall’UPS, non un conto alla rovescia dello shutdown.',
    upsLoad: 'Carico UPS', input: 'Ingresso', model: 'Modello',
    cpuLoad: 'Carico CPU 1/5/15 min', usedRam: 'RAM usata', temperature: 'Temperatura',
    omitted: '<i>Altre {count} voci non mostrate.</i>',
    missingMounts: '⚠️ Mount importanti assenti: {count}', mountsPresent: '✅ Mount importanti presenti', missing: 'Assente',
    free: 'Liberi', used: 'usato', containers: 'Container in esecuzione', noHealthcheck: 'healthcheck non configurato',
    diagnosticFailed: '⚠️ <b>{view}</b>: dati non disponibili.\nVerificare disponibilità e permessi dei comandi locali.',
    blackout: '⚡ <b>Alimentazione assente</b>\nUPS a batteria da almeno 30 secondi.\nCarica: {charge} · autonomia dichiarata: {runtime}',
    criticalBattery: '🚨 <b>UPS critico</b>\nNUT segnala batteria bassa (LB) o shutdown forzato già richiesto (FSD).\nLo shutdown è gestito autonomamente da NUT.',
    shutdownWarning: '⏳ <b>Preavviso shutdown</b>\nDurata osservata del blackout: {elapsed}. Soglia configurata: {threshold}.\nQuesto avviso non indica quando avverrà lo shutdown. Il bot non legge né verifica i timer NUT. Lo shutdown resta gestito autonomamente da NUT.',
    restored: '✅ <b>Alimentazione ripristinata</b>\nRete confermata da una lettura UPS valida (OL).\nDurata osservata del blackout: {duration}.',
    criticalOnline: '🚨 <b>UPS critico</b>\nRete presente, ma NUT segnala LB o FSD. Lo shutdown resta gestito da NUT.',
  },
  en: {
    cores: 'cores',
    healthy: 'healthy',
    unhealthy: 'unhealthy',
    healthStarting: 'starting',
    invalidUpsName: 'GUARDIAN_UPS_NAME must be a valid upsname[@hostname[:port]] destination.',
    invalidDockerEnabled: 'GUARDIAN_DOCKER_ENABLED must be true or false.',
    invalidMounts: 'GUARDIAN_IMPORTANT_MOUNTS must contain comma-separated absolute paths.',
    cliTitle: 'Local CLI',
    cliInvalidArguments: 'Error: invalid command or arguments. Use raspi-guardian help.',
    cliError: 'Error: {message}',
    cliDockerDisabled: 'Error: Docker disabled. Set GUARDIAN_DOCKER_ENABLED=true to enable read access.',
    cliIncomplete: 'Error: incomplete diagnostics. Check services, local clients and permissions.',
    cliUnavailable: 'Error: local diagnostics unavailable.',
    cliLanguageCurrent: 'Current CLI language: {language} ({code}).',
    cliLanguageSaved: '✅ CLI language set: {language} ({code}).',
    cliLanguageFailed: 'Error: unable to save the CLI language. The previous preference is unchanged. Check permissions and free space in the user configuration directory.',
    languageNameIt: 'Italian',
    languageNameEn: 'English',
    cliHelp: `Usage: raspi-guardian <command> [--no-color]

  status   UPS, system and disks overview; Docker if enabled
  ups      Power, battery and NUT destination
  system   Uptime, CPU, RAM and temperature
  disks    Mounts and free space
  docker   Running containers and health (requires opt-in)
  help     This guide
  lang     Show the current CLI language
  lang it|en  Save the CLI language for this Linux user

Diagnostic environment options:
  GUARDIAN_UPS_NAME            NUT destination upsname[@hostname[:port]]
                              Required for status and ups; no default
  GUARDIAN_IMPORTANT_MOUNTS    Comma-separated expected mounts (default: /)
  GUARDIAN_DOCKER_ENABLED      true / false (default: false)

Automatic colors on TTY; NO_COLOR, TERM=dumb or --no-color disable them.
No Telegram configuration needed. Default language: English.
CLI preference: $XDG_CONFIG_HOME/raspi-guardian/cli.json or
$HOME/.config/raspi-guardian/cli.json. Telegram language is independent.
`,
    unavailable: 'n/a',
    start: '<b>🛡 Raspi Guardian</b>\n\n/status — general overview\n/ups — power and battery\n/system — uptime, CPU, RAM, temperature\n/disks — mounts and free space\n{dockerCommand}/lang — language selection\n/start · /help — commands and buttons\n\nAutomatic UPS alerts enabled. Shutdown remains managed by NUT.',
    dockerCommand: '/docker — running containers and health\n',
    languageMenu: '<b>🌐 Language</b>\nCurrent language: English.\nChoose the language for this group.',
    languageSaved: '✅ Language set: English.',
    languageUsage: '⚠️ Use /lang, /lang it or /lang en.',
    languageFailed: '⚠️ Unable to save the language. The previous language remains active. Check the service state directory.',
    status: 'Status', system: 'System', disks: 'Disks', help: 'Help', refresh: 'Refresh', language: 'Language',
    power: 'Power', online: 'mains available', battery: 'on battery', nutStatus: 'NUT status', critical: 'critical',
    charge: 'Charge', runtime: 'Reported runtime',
    runtimeNote: 'Estimate reported by the UPS, not a shutdown countdown.',
    upsLoad: 'UPS load', input: 'Input', model: 'Model',
    cpuLoad: 'CPU load 1/5/15 min', usedRam: 'RAM used', temperature: 'Temperature',
    omitted: '<i>{count} more entries not shown.</i>',
    missingMounts: '⚠️ Important mounts missing: {count}', mountsPresent: '✅ Important mounts present', missing: 'Missing',
    free: 'Free', used: 'used', containers: 'Running containers', noHealthcheck: 'healthcheck not configured',
    diagnosticFailed: '⚠️ <b>{view}</b>: data unavailable.\nCheck availability and permissions of local commands.',
    blackout: '⚡ <b>Mains power lost</b>\nUPS on battery for at least 30 seconds.\nCharge: {charge} · reported runtime: {runtime}',
    criticalBattery: '🚨 <b>UPS critical</b>\nNUT reports low battery (LB) or forced shutdown already requested (FSD).\nShutdown is managed independently by NUT.',
    shutdownWarning: '⏳ <b>Shutdown warning</b>\nObserved outage duration: {elapsed}. Configured threshold: {threshold}.\nThis alert does not indicate when shutdown will occur. The bot neither reads nor verifies NUT timers. Shutdown remains managed independently by NUT.',
    restored: '✅ <b>Mains power restored</b>\nMains confirmed by a valid UPS reading (OL).\nObserved outage duration: {duration}.',
    criticalOnline: '🚨 <b>UPS critical</b>\nMains available, but NUT reports LB or FSD. Shutdown remains managed by NUT.',
  },
};

export function t(language = 'en', key, values = {}) {
  const template = translations[language]?.[key] ?? translations.en[key];
  if (typeof template !== 'string') throw new Error('Unknown translation key.');
  // I valori HTML dinamici vanno già escapati dal chiamante.
  return template.replace(/\{(\w+)\}/g, (_, name) => String(values[name]));
}
