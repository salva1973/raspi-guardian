import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const DEFAULT_STATE_DIRECTORY = '/var/lib/raspi-guardian';
export const isLanguage = value => value === 'it' || value === 'en';

export class Settings {
  language = 'en';

  constructor(directory = process.env.STATE_DIRECTORY || DEFAULT_STATE_DIRECTORY, {
    filename = 'settings.json',
    warnInvalid = () => console.warn('Invalid or unreadable language settings; using English.'),
    privateFile = false,
  } = {}) {
    // Il chiamante prepara la directory (systemd per il bot).
    this.directory = directory;
    this.path = join(directory, filename);
    this.filename = filename;
    this.warnInvalid = warnInvalid;
    this.privateFile = privateFile;
  }

  async load() {
    this.language = 'en';
    let file;
    try {
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 4096 ||
          (this.privateFile && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))) {
        throw new Error('Invalid settings file.');
      }
      const settings = JSON.parse(await file.readFile('utf8'));
      if (!settings || !isLanguage(settings.language)) throw new Error('Invalid language.');
      this.language = settings.language;
    } catch (error) {
      // Nessun contenuto del file o dettaglio dell’errore finisce nei log.
      if (error.code !== 'ENOENT') this.warnInvalid();
    } finally {
      await file?.close();
    }
  }

  async setLanguage(language) {
    if (!isLanguage(language)) throw new Error('Invalid language.');
    const temporary = join(this.directory, `.${this.filename.replace(/\.json$/, '')}-${randomUUID()}.tmp`);
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      // Si salva esclusivamente la lingua, mai la configurazione Telegram.
      await file.writeFile(`${JSON.stringify({ language })}\n`, 'utf8');
      await file.sync();
      await file.close();
      file = undefined;
      await rename(temporary, this.path);
      this.language = language;
    } finally {
      await file?.close();
      await unlink(temporary).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }
}
