import { t } from './i18n.mjs';
import { isIP } from 'node:net';

function validUpsName(value) {
  if (typeof value !== 'string' || value.length > 512) return false;
  const match = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)(?:@(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?)?$/.exec(value);
  if (!match) return false;
  const [, , host, port] = match;
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) return false;
  if (!host) return true;
  if (host.startsWith('[')) return isIP(host.slice(1, -1)) === 6;
  return host.length <= 253 && host.split('.').every(label =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}

// Opzioni condivise; nessuna lettura di file o dipendenza da Telegram.
export function loadDiagnosticConfig(env, { requireUps = true, language = 'en' } = {}) {
  if ((requireUps || env.GUARDIAN_UPS_NAME !== undefined) && !validUpsName(env.GUARDIAN_UPS_NAME)) {
    throw new Error(t(language, 'invalidUpsName'));
  }
  if (env.GUARDIAN_DOCKER_ENABLED !== undefined && !['true', 'false'].includes(env.GUARDIAN_DOCKER_ENABLED)) {
    throw new Error(t(language, 'invalidDockerEnabled'));
  }
  const importantMounts = [...new Set(
    (env.GUARDIAN_IMPORTANT_MOUNTS ?? '/').split(',')
      .map(p => p.trim()).map(p => p === '/' ? p : p.replace(/\/+$/, '')),
  )];
  if (importantMounts.some(p => !p.startsWith('/') || p.includes('\n'))) {
    throw new Error(t(language, 'invalidMounts'));
  }
  return {
    upsName: env.GUARDIAN_UPS_NAME,
    dockerEnabled: env.GUARDIAN_DOCKER_ENABLED === 'true',
    importantMounts,
  };
}
