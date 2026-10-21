# Development and controlled deployment

This path is for changing or maintaining Raspi Guardian. To install and use it,
start with [Quick Start](../README.md#quick-start) or [CLI-only](../README.md#cli-only).
Neither installation path requires a development directory or the test suite.

Raspi Guardian uses native JavaScript modules, Node.js 22, zero NPM dependencies
and no database. The CLI and Telegram bot use the same diagnostic code. Install
[Linux prerequisites](linux-setup.md#packages-and-nodejs-22) before development.

## Create a separate development checkout

Keep `/opt/raspi-guardian-dev` owned by your development user, separate from the
root-owned production installation at `/opt/raspi-guardian`. Editing or testing
the checkout must not change the running service. For a new, empty checkout
location, clone the official public repository:

```bash
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 /opt/raspi-guardian-dev
git clone https://github.com/salva1973/raspi-guardian.git /opt/raspi-guardian-dev
cd /opt/raspi-guardian-dev
git remote -v
git status --short
```

For an existing checkout, enter it and review its status instead of repeating
creation/cloning. Keep credentials and installation-specific drop-ins outside
Git. A fresh production installation is covered by the README; the deployment
and rollback procedure below assumes it already exists.

## Offline verification

From `/opt/raspi-guardian-dev`, in the reviewed checkout, without loading private
configuration or starting a real bot:

```bash
node --check src/guardian.mjs
node --check src/i18n.mjs
node --check src/settings.mjs
node --check src/config.mjs
node --check src/diagnostics.mjs
node --check src/cli.mjs
node --check src/cli-settings.mjs
node --check bin/raspi-guardian
node --check tests/guardian.test.mjs
node --check tests/cli.test.mjs
mkdir -p .test-tmp
TMPDIR="$PWD/.test-tmp" node tests/guardian.test.mjs
TMPDIR="$PWD/.test-tmp" node tests/cli.test.mjs
rmdir .test-tmp
systemd-analyze verify systemd/raspi-guardian.service
git diff --check
```

All 46 pre-internationalization tests are retained with English default
expectations updated. Additional cases cover CLI EN → IT → EN, process/session
persistence, separate Linux users, XDG/HOME fallback, independent Telegram state,
translated diagnostics/errors, corrupt settings, atomic writes, private permissions,
symlink protection, Unicode and NO_COLOR. Telegram tests also check the English
initial language and preservation of previously saved Italian and English.
The launcher is tested through a temporary symlink and fresh asynchronous Node
processes with network access trapped; the environment must permit spawning Node.
Telegram, diagnostic child processes and diagnostic reads are mocked, except
for the launcher's `system` smoke test, which reads the host's public system
metrics. Only disposable test settings and CLI links are written inside
`.test-tmp`. No credentials are loaded, no Telegram,
NUT or Docker connection is made, and no blackout/shutdown is triggered.
`systemd-analyze verify` is a static check; it does not start the service.

## Internationalization v1.2

Both interfaces default to English and reuse `src/i18n.mjs` and the diagnostic
renderers. Add every translation key to both dictionaries with matching
parameters. Pass the selected language through rendering and configuration
validation. Preserve hostnames, NUT destinations/flags, Docker names and raw
status strings, filesystem types/paths and other technical data.

Telegram `/lang` (or `/lang it|en`) changes the authorized chat's preference in
`$STATE_DIRECTORY/settings.json`, normally `/var/lib/raspi-guardian/settings.json`.
A valid saved preference always wins over the new default; leave that file in
place during upgrades. Authorization, UPS flags, timers and deduplication are
independent of localization.

`raspi-guardian lang` displays the CLI preference. `raspi-guardian lang it` and
`raspi-guardian lang en` persist it for the calling Linux user in
`${XDG_CONFIG_HOME:-$HOME/.config}/raspi-guardian/cli.json`. The CLI creates its
private directory (`0700`) and uses the shared language-file implementation for
exclusive temporary files (`0600`), sync and atomic rename. It rejects unsafe
application directories and ignores missing, corrupt, unreadable or unsafe
preferences, falling back to English. It does not read Telegram state or
credentials. No language environment variable, database or dependency is needed.
The two preferences remain independent across SSH reconnects and bot restarts.

For a credential-free manual CLI check, use a disposable configuration location
inside the checkout; do not overwrite your actual user preference:

```bash
mkdir -p .test-tmp
XDG_CONFIG_HOME="$PWD/.test-tmp/config" node bin/raspi-guardian lang
# Current CLI language: English (en).
XDG_CONFIG_HOME="$PWD/.test-tmp/config" node bin/raspi-guardian lang it
# ✅ Lingua CLI impostata: Italiano (it).
XDG_CONFIG_HOME="$PWD/.test-tmp/config" NO_COLOR=1 node bin/raspi-guardian help
XDG_CONFIG_HOME="$PWD/.test-tmp/config" node bin/raspi-guardian lang en
# ✅ CLI language set: English (en).
rm -r .test-tmp/config
rmdir .test-tmp
```

## Updating, migration and rollback

### Develop, test and publish source changes

Work only in `/opt/raspi-guardian-dev`, as the development user. For an existing
checkout, review local changes before updating; do not discard work or pull into
the installed `/opt/raspi-guardian` tree. Example workflow (replace branch and
file names as appropriate):

```bash
cd /opt/raspi-guardian-dev
git status --short
git switch main
git pull --ff-only origin main
git switch -c docs/setup-update
# Edit the intended files, then run all Offline verification commands above.
git diff --check
git diff -- README.md docs/telegram-setup.md docs/linux-setup.md docs/development.md guardian.env.example
git add -- README.md docs/telegram-setup.md docs/linux-setup.md docs/development.md guardian.env.example
git diff --cached --check
git diff --cached
git commit -m "docs: clarify installation and operations"
git push -u origin docs/setup-update
```

Use your repository's actual default branch instead of `main` if different.
Commit only reviewed files; do not use a blanket add for private installation
files. Review/merge through your normal GitHub workflow. Push publishes source;
it does not deploy, restart the service or change the global CLI. Configuration,
state and local drop-ins stay outside Git.

### Deploy a reviewed revision

Use a maintenance window. In the development checkout, finish or save local
work, fetch the reviewed revision and select it explicitly:

```bash
cd /opt/raspi-guardian-dev
git status --short
git fetch origin --tags
git switch --detach YOUR_REVIEWED_TAG_OR_COMMIT
git rev-parse HEAD
# Run all Offline verification commands above on this exact revision.
```

Require a clean checkout, including no unexpected untracked source modules.
Record the full commit ID in private deployment notes. Stop on any failed check
or copy command; do not continue to service startup with a partial installation.
Never pull new Git history directly into the running installation.

The following backup/copy sequence is for an installation using the public
paths and unit. Keep a separately protected backup of the private configuration
and local drop-ins if you plan to change them; this deployment leaves them and
the language state in place. If replacing another version, record its revision
before stopping it. Run from the reviewed checkout, with no CLI requests in
progress:

```bash
backup=/opt/raspi-guardian-backups/$(date -u +%Y%m%dT%H%M%SZ)
sudo install -d -o root -g root -m 0700 "$backup"
sudo systemctl stop raspi-guardian.service
sudo cp -a /opt/raspi-guardian "$backup/application"
sudo cp -a /etc/systemd/system/raspi-guardian.service "$backup/raspi-guardian.service"
git rev-parse HEAD | sudo tee "$backup/new-revision.txt" > /dev/null
```

Still in `/opt/raspi-guardian-dev`, repeat only the file-copy block in
[Quick Start step 4](../README.md#4-install-the-application-files). It copies all
application files with root ownership and the required modes; it does not touch
the private configuration or service account. Install the reviewed unit separately:

```bash
sudo install -o root -g root -m 0644 systemd/raspi-guardian.service /etc/systemd/system/raspi-guardian.service
```

The service must stay stopped throughout copying: a running process can still
import modules on first use. Replacing only `guardian.mjs` can break startup.
The global CLI link continues to point at the installed launcher. Preserve
local drop-ins and check their compatibility with the new unit.

### Migration from v1.1

For migration from v1.1, keep the existing private Telegram values and explicitly
set `GUARDIAN_UPS_NAME` to the previous NUT destination. Set
`GUARDIAN_DOCKER_ENABLED=true` only if Docker diagnostics were previously used;
otherwise keep it `false`. Transfer the previous expected mount list into
`GUARDIAN_IMPORTANT_MOUNTS`. If a notification threshold was previously used,
set `GUARDIAN_SHUTDOWN_WARNING_SECONDS` to that number of seconds; otherwise
omit it or leave it empty. The warning now makes no prediction about shutdown.
Do not overwrite the existing private environment file with the public example.

If retaining an existing Linux account, create a local systemd override **before
starting the new unit**. Replace both placeholders with the current service user
and effective group (use the existing unit's `Group`, or the account's primary
group if unset; `id -gn ACCOUNT` identifies the primary group):

```ini
[Service]
User=YOUR_EXISTING_ACCOUNT
Group=YOUR_EXISTING_GROUP
# Only if Docker diagnostics were enabled and this group exists:
SupplementaryGroups=docker
```

Keep `StateDirectory=raspi-guardian`, `StateDirectoryMode=0700` and the same
`/var/lib/raspi-guardian/settings.json` path. Leave the existing language file
in place: do not recreate, copy, delete or initialize it. Keeping the same account
and group avoids systemd changing the existing state's ownership when starting
the new unit. Defer any move to the dedicated account to a separate maintenance
operation; systemd can recursively adjust ownership when a state directory's
owner changes.

### Start and verify the deployed revision

After installing the reviewed modules and unit, and preparing any drop-in:

```bash
sudo systemctl daemon-reload
sudo systemctl restart raspi-guardian.service
sudo systemctl status raspi-guardian.service --no-pager
sudo journalctl -u raspi-guardian.service -n 50 --no-pager
```

This briefly restarts only the bot and clears its in-memory UPS episode. Do not
restart NUT or Docker. Verify `/help`, `/status`, `/ups`, expected Docker visibility,
authorized callbacks and the **existing** language before deliberately changing
it. Do not launch a second instance with the same token.

### Roll back the installed files

If verification fails, restore the saved installation as a complete set. Set
`backup` to the directory created above, not an arbitrary release checkout:

```bash
backup=/opt/raspi-guardian-backups/YOUR_BACKUP_TIMESTAMP
sudo test -d "$backup/application/src"
sudo test -f "$backup/raspi-guardian.service"
# Continue only if both checks succeeded; use an unused failed-application path.
sudo systemctl stop raspi-guardian.service
sudo mv /opt/raspi-guardian "$backup/failed-application"
sudo cp -a "$backup/application" /opt/raspi-guardian
sudo cp -a "$backup/raspi-guardian.service" /etc/systemd/system/raspi-guardian.service
sudo systemctl daemon-reload
sudo systemctl start raspi-guardian.service
sudo systemctl status raspi-guardian.service --no-pager
sudo journalctl -u raspi-guardian.service -n 50 --no-pager
```

If you also changed drop-ins or private configuration, restore their matching
protected backups before reloading/starting; credentials remain `root:root`
and `0600`. Leave `/var/lib/raspi-guardian/settings.json` in place; the language
format is unchanged. Both upgrade and rollback reset the in-memory UPS episode.
Verify diagnostics and the existing language again. Return to your development
branch with `git switch YOUR_DEVELOPMENT_BRANCH` when development resumes;
rolling back installed files does not require rewriting or force-pushing Git.
