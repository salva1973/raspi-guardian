import { lstat, mkdir, chmod } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { Settings, isLanguage } from './settings.mjs';

export class CliSettings extends Settings {
  constructor(env = process.env) {
    // XDG requires an absolute path. A relative value is ignored.
    const home = env.HOME || homedir();
    const configHome = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME : isAbsolute(home) ? join(home, '.config') : null;
    super(configHome ? join(configHome, 'raspi-guardian') : '.', {
      filename: 'cli.json', warnInvalid: () => {}, privateFile: true,
    });
    this.validPath = configHome !== null;
  }

  async checkDirectory() {
    if (!this.validPath) throw new Error('Invalid config directory.');
    const stat = await lstat(this.directory);
    if (!stat.isDirectory() || stat.uid !== process.getuid()) {
      throw new Error('Unsafe config directory.');
    }
    return stat;
  }

  async load() {
    this.language = 'en';
    try {
      const stat = await this.checkDirectory();
      if ((stat.mode & 0o077) !== 0) return;
      await super.load();
    } catch {
      // Missing/unsafe settings never reveal paths or file contents.
    }
  }

  async setLanguage(language) {
    if (!isLanguage(language)) throw new Error('Invalid language.');
    if (!this.validPath) throw new Error('Invalid config directory.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.checkDirectory();
    await chmod(this.directory, 0o700);
    await super.setLanguage(language);
  }
}
