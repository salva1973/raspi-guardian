# Telegram: first-time setup

This guide configures a single Raspi Guardian bot for one private group and one
authorized human user. All names, tokens, IDs and NUT destinations in examples
are fictional. Run the commands on your own reviewed installation when ready;
they are instructions, not an automatic setup procedure. The local CLI needs
none of these Telegram steps. Return to the [README](../README.md) for Linux,
NUT, CLI and systemd installation.

When following [Quick Start](../README.md#quick-start), complete steps 1–4 here,
then return to [Quick Start step 4](../README.md#4-install-the-application-files).
Steps 5–6 below are configuration and startup references; they reuse the same
installation and must not create a second copy or start another poller.

## 1. Create the bot with BotFather

In Telegram, open the official [@BotFather](https://t.me/BotFather), checking the
exact username. Send `/newbot`, choose a display name such as `Example Guardian`
and an available username ending in `bot`, such as `example_guardian_test_bot`.
Save the exact username for addressed group commands. BotFather supplies the
API token. See the official [BotFather reference](https://core.telegram.org/bots/features#botfather).

An example of the token's shape is
`000000000:EXAMPLE_ONLY_NOT_A_REAL_TELEGRAM_BOT_TOKEN`. It will not authenticate.
The token controls the bot; it is not your user ID, group ID or bot username.
Store the real value in a trusted password manager until you enter it in the
root-only configuration. Never put it in Git, shell history, a browser address
bar, screenshots, issue reports, chat messages or third-party ID lookup sites.
Avoid commands such as `curl https://.../botTOKEN/...`: the expanded token can
appear in process arguments and error output.

If exposed, revoke/regenerate the token through BotFather's API Token menu,
update the private EnvironmentFile and restart only your bot during
maintenance. Removing an exposed file from the latest commit does not revoke a
token or remove it from Git history.

## 2. Create a private group and add the bot

Create a Telegram group, for example `Example Home Monitoring`, and keep it
private: no public username or public invite link. Add only trusted people; all
members can see the diagnostics and UPS notifications. Check the members list
and revoke any invitation link that is no longer needed. Telegram group chats
are cloud chats, not end-to-end encrypted Secret Chats; keep diagnostic exposure
within your intended audience. See [Telegram's chat security FAQ](https://telegram.org/faq#q-how-secure-is-telegram).

Add the bot using its exact username. It needs permission to send messages in
the group, not administrator privileges. Use an ordinary group without topics
for this initial setup; Raspi Guardian does not select a topic/thread. You may
also open a private conversation with the bot and press Start, but that does not
authorize your private chat when the configured destination is the group.

## 3. Set BotFather options

In BotFather, select this bot for each setting:

- `/setjoingroups`: enable group joining if it is disabled.
- `/setprivacy`: keep privacy mode **enabled**. Use commands addressed to the
  bot, such as `/status@example_guardian_test_bot`, so they are delivered even
  when there are other bots in the group. Disabling privacy or promoting the
  bot to administrator is unnecessary for Raspi Guardian.
- `/setcommands`: optional menu entries, listed below. The menu is a convenience;
  application authorization still checks every command and button.
- Inline mode (`/setinline`) is unnecessary. Inline keyboards on messages work
  without enabling inline-query mode.

These settings are described in [BotFather settings](https://core.telegram.org/bots/features#botfather)
and the [message delivery FAQ](https://core.telegram.org/bots/faq#what-messages-will-my-bot-get).
For an optional command menu, enter one command per line without a leading `/`:

```text
start - Show commands
help - Show help
status - System overview
ups - UPS power and battery
system - CPU RAM and temperature
disks - Mounts and free space
lang - Choose Italian or English
```

Add `docker - Running containers` only if Docker diagnostics are enabled in
your installation. BotFather menu descriptions are separate from the bot's
Italian/English response language.

## 4. Discover chat ID and your user ID directly through Telegram

Use Telegram's official HTTPS Bot API from a trusted terminal. No ID lookup bot,
forwarded message service or external website is required. The important fields
are `message.chat.id` (destination) and `message.from.id` (sender), not
`update_id`, `message_id`, the bot's own ID, or a username.

**Keep the Raspi Guardian service and every other poller for this token stopped
while discovering IDs.** On a fresh installation, do not enable the unit yet.
For an existing installation, schedule the interruption and stop only the bot:

```bash
sudo systemctl stop raspi-guardian.service
```

Check for manually launched instances, containers or services on other machines
using this token. Do not start a second `guardian.mjs` to discover IDs. The helper
below calls `getUpdates` briefly, then exits; it does not start Raspi Guardian.
Polling and webhooks are mutually exclusive. See
[getUpdates](https://core.telegram.org/bots/api#getupdates) and
[getWebhookInfo](https://core.telegram.org/bots/api#getwebhookinfo).

The following helper uses **Python 3 and its standard library**, with no Python
packages to install (`sudo apt-get install python3 ca-certificates` on Debian/
Raspberry Pi OS if needed). Run it in an interactive SSH terminal with a controlling
TTY. It prompts for the token without echo; the token is never an argument or
environment variable. Do not use a recorded/shared terminal session. It prints
only the bot username, candidate group names and IDs, never the token or raw API
responses. On an API/network error it prints a fixed message or numeric HTTP code.

```bash
python3 - <<'PY'
import getpass
import json
import re
import sys
import urllib.error
import urllib.request
import warnings

try:
    with open('/dev/tty', 'r+') as tty:
        warnings.simplefilter('error', getpass.GetPassWarning)
        token = getpass.getpass('Bot token (hidden): ', stream=tty)
        if not re.fullmatch(r'[0-9]+:[A-Za-z0-9_-]+', token):
            sys.exit('Invalid token format; no request sent.')

        def api(method, payload=None):
            request = urllib.request.Request(
                'https://api.telegram.org/bot' + token + '/' + method,
                data=json.dumps(payload or {}).encode(),
                headers={'Content-Type': 'application/json'}, method='POST')
            with urllib.request.urlopen(request, timeout=15) as response:
                body = json.load(response)
            if body.get('ok') is not True:
                raise RuntimeError('API request failed')
            return body['result']

        bot = api('getMe')
        username = bot['username']
        print('Bot username:', ascii(username))
        if api('getWebhookInfo').get('url'):
            tty.write('An active webhook prevents polling. Remove it for this bot? [yes/NO] ')
            tty.flush()
            if tty.readline().strip() != 'yes':
                sys.exit('No changes made. Use a separate bot or resolve the webhook first.')
            api('deleteWebhook', {'drop_pending_updates': False})

        command = '/status@' + username
        tty.write('From your own account, send ' + command +
                  ' in the intended private group, then press Enter here: ')
        tty.flush()
        tty.readline()
        offset = 0
        found = set()
        for _ in range(5):
            updates = api('getUpdates', {
                'offset': offset, 'timeout': 0, 'limit': 100,
                'allowed_updates': ['message', 'callback_query']})
            for update in updates:
                message = update.get('message', {})
                chat, user = message.get('chat', {}), message.get('from', {})
                if (message.get('text') == command and
                    chat.get('type') in ('group', 'supergroup') and
                    user.get('is_bot') is False and user.get('id')):
                    pair = (chat['id'], user['id'])
                    if pair not in found:
                        print('Group:', ascii(chat.get('title', '')))
                        print('TELEGRAM_CHAT_ID=' + str(pair[0]))
                        print('TELEGRAM_ALLOWED_USER_ID=' + str(pair[1]))
                        found.add(pair)
                offset = max(offset, update['update_id'] + 1)
            if len(updates) < 100:
                break
        if not found:
            print('No matching group command. Check membership/privacy, send it again and rerun.')
except urllib.error.HTTPError as error:
    print('Telegram HTTP error:', error.code, file=sys.stderr)
    sys.exit(1)
except Exception:
    print('Setup failed. Check network, token and single-poller operation; no details logged.', file=sys.stderr)
    sys.exit(1)
PY
```

The helper's optional webhook removal asks explicitly, keeps pending updates and
must be used only when this token belongs exclusively to this installation.
For a token serving another application, create a separate bot instead. See
[deleteWebhook](https://core.telegram.org/bots/api#deletewebhook). The helper
advances the update offset as it reads queued pages, so it can acknowledge old
updates; perform discovery before normal operation. It inspects at most 500
queued updates; if a large old backlog remains, rerun it with all other clients
still stopped. Telegram retains pending updates for at most 24 hours.

Verify the candidate group in your Telegram client. Use the entry for the
command **you sent as yourself**, not one sent by another group member. If there
are multiple candidates, do not copy an arbitrary pair. For example, the two
fictional values could be:

```dotenv
TELEGRAM_CHAT_ID=-1001234567890
TELEGRAM_ALLOWED_USER_ID=123456789
```

Preserve the negative sign and every digit; do not derive a group ID by adding a
prefix. Send the command as your personal account, not anonymously as an admin
or on behalf of a channel. A group upgraded to a supergroup can acquire a new
chat ID: repeat discovery with the bot stopped if that happens.

## 5. Configure the private EnvironmentFile

Use [Quick Start steps 4–5](../README.md#4-install-the-application-files) to
install the application, create the dedicated account and initialize the
private configuration with the correct ownership and permissions. Keep the
bot stopped until configuration is complete. There is no development directory
requirement. To edit an existing configuration:

```bash
sudoedit /etc/raspi-guardian/telegram.env
```

Do not copy the public template over an existing private configuration. Use the
real token and the IDs you verified, and the actual NUT destination. Example only:

```dotenv
TELEGRAM_BOT_TOKEN=000000000:EXAMPLE_ONLY_NOT_A_REAL_TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID=-1001234567890
TELEGRAM_ALLOWED_USER_ID=123456789
GUARDIAN_UPS_NAME=example-ups@localhost
GUARDIAN_DOCKER_ENABLED=false
GUARDIAN_IMPORTANT_MOUNTS=/
```

The unit contains `EnvironmentFile=/etc/raspi-guardian/telegram.env`. Use systemd
`NAME=value` syntax: no `export`, shell commands, substitutions or spaces around
`=`. There is no need to quote these example values. Do not source the file in a
shell or pass the token to `systemctl set-environment`. Keep it out of the source
tree. See [EnvironmentFile documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html#EnvironmentFile=).

Check metadata without displaying the file contents:

```bash
sudo chown root:root /etc/raspi-guardian /etc/raspi-guardian/telegram.env
sudo chmod 0700 /etc/raspi-guardian
sudo chmod 0600 /etc/raspi-guardian/telegram.env
sudo stat -c '%U:%G %a %n' /etc/raspi-guardian /etc/raspi-guardian/telegram.env
```

The system service manager reads this root-only file and supplies the environment
to the dedicated service account. That account does not need permission to open
the file. Do not make credentials world-readable to support the SSH CLI: use
only its non-secret diagnostic variables as explained in the README.

## 6. Start once and test

Ensure the discovery helper has exited and no other process uses this token.
For a new installation, use [Quick Start step 6](../README.md#6-install-systemd-and-enable-automatic-startup)
to install the unit, select the correct system-wide Node path, enable startup
and check status/logs.

For an existing service whose EnvironmentFile you changed, restart only the bot
in a maintenance window:

```bash
sudo systemctl restart raspi-guardian.service
```

No `daemon-reload` is needed for an EnvironmentFile-only change. Do not restart
NUT or Docker. See [everyday service management](../README.md#everyday-service-management)
for boot startup, live logs, stop and start.
In the intended group, using the authorized account, send addressed commands
(replace the fictional username):

```text
/help@example_guardian_test_bot
/status@example_guardian_test_bot
/ups@example_guardian_test_bot
/system@example_guardian_test_bot
/disks@example_guardian_test_bot
/lang@example_guardian_test_bot en
/lang@example_guardian_test_bot it
```

Verify that inline refresh updates the same message and language buttons work.
`/docker` is available only if explicitly enabled and the service can access the
socket. Never disconnect power or force a shutdown just to test Telegram setup.
An unavailable UPS diagnostic can indicate a NUT/client problem even when
Telegram is configured correctly. The service polls the UPS automatically;
command responses do not enable or disable monitoring.

## 7. Authorization and disclosure

Both the configured chat ID **and** the configured user ID must match every
command or callback. Exactly one human user is supported; comma-separated lists
are not accepted. Other users, other groups, bots and malformed actions are
ignored. Telegram group administrator status does not bypass this check.
English is the default for a new installation. Existing saved Italian or English
preferences are preserved. The allowed user can use `/lang` to select a language,
`/lang it` for Italian or `/lang en` for English for the whole authorized chat.
This preference is saved in `/var/lib/raspi-guardian/settings.json` (or the
service `STATE_DIRECTORY`) and survives bot restarts. It is independent of
`raspi-guardian lang it|en`, which saves only the calling Linux user's CLI language
in `${XDG_CONFIG_HOME:-$HOME/.config}/raspi-guardian/cli.json`. There is no
Telegram command to change the authorization IDs; an administrator must update
the private file and restart the bot to apply that change.

Test that a second trusted account cannot invoke commands or press the bot's
buttons, and that your private chat cannot control a bot configured for the
group. Silence is the expected rejection. All group members still see replies
and automatic alerts, including hostnames, mount sources, UPS details and
container names if Docker is enabled. Protect the group membership accordingly.

## 8. Common problems

| Symptom | Check and action |
| --- | --- |
| Startup rejects configuration | Check the three Telegram variables, a positive user ID, signed numeric chat ID and required `GUARDIAN_UPS_NAME`. Do not post the file in a bug report. |
| HTTP 401 / invalid token | Check you selected the right bot and copied the current token. Regenerate through BotFather if exposed; update the private file and restart only the bot. |
| HTTP 409 / `getUpdates` conflict | Stop all competing pollers: manual Node runs, the discovery helper, duplicate systemd units, containers, and copies on other hosts. Keep one process per token. Check for an active webhook separately. |
| Repeated service exits after a conflict | The bot treats polling conflicts as fatal; systemd retries after 10 seconds. Stopping only a manual copy may leave another instance restarting. Find the owner of each instance without printing its environment or token. |
| Active webhook | Use `getWebhookInfo` via the helper. If this is exclusively your bot, explicitly accept the helper's `deleteWebhook` step, which preserves pending updates. Raspi Guardian never removes webhooks itself. |
| Helper shows no IDs | Confirm the bot is in the group and permitted to join groups; send the exact addressed command as your personal account. Retry after sending a fresh message with all other pollers stopped. |
| Bot is silent in the group | Check both IDs, username spelling, privacy delivery and send-message permissions. Try `/help@actual_bot_username`. A menu entry alone does not authorize a sender. Check whether the group migrated to a supergroup. |
| HTTP 403 / bot cannot send | Re-add the correct bot if removed; restore permission to send. For private chats, unblock/start the bot and configure that chat's ID deliberately if it is the intended destination. |
| Timeout, DNS or TLS error | Check outbound HTTPS, DNS, CA certificates and system clock. No inbound port, public web server or webhook is needed. Do not disable TLS verification. |
| Telegram works, diagnostics fail | Verify `/usr/bin/upsc`, `/usr/bin/findmnt`, NUT destination and account permissions. Docker is optional; enabling it does not grant socket permission. See the README's root-equivalent Docker privilege warning. |
| Language will not persist | Check systemd `StateDirectory`, ownership and free space. Do not change credential-file permissions; settings contain only the language. |

Logs intentionally omit tokens, raw API responses and incoming messages. When
asking for help, share a redacted symptom and relevant fixed log messages, never
the token, `/proc/.../environ`, a service environment dump or the private file.
