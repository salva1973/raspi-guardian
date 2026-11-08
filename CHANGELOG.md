# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-11-08

### Changed

- Node.js 22 **or newer** is supported; the installation checks in the README and the Linux setup guide no longer require exactly Node 22. The Node.js installation recipe now installs the current LTS line (26), set in one `node_major` variable.
- Service log and internal error messages are now in English (for example `Raspi Guardian started: long polling and UPS monitoring active.`). Telegram and CLI output remain available in English and Italian, as before.
- Test names and code comments are in English.

### Fixed

- The CLI test comparing colored and plain `status` output no longer fails when live host values (uptime, load, memory) change between the two runs.

### Added

- GitHub Actions CI on Node.js 22, 24 and 26: syntax checks and the offline test suite.
- Dependabot for GitHub Actions, with a 7-day cooldown. The project still has no npm dependencies.

### Upgrading

No configuration changes are needed. Follow [Deploy a reviewed revision](docs/development.md#deploy-a-reviewed-revision) with tag `v1.0.1`. If you monitor the journal for specific messages, update them to the new English text.

## [1.0.0] - 2026-10-21

### Added

- First open-source release: Telegram bot and CLI for Raspberry Pi/Linux system, disk and UPS (NUT) diagnostics, automatic UPS alerts, English/Italian interface, optional Docker diagnostics.

[1.0.1]: https://github.com/salva1973/raspi-guardian/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/salva1973/raspi-guardian/releases/tag/v1.0.0
