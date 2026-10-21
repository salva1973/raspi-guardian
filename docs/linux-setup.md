# Linux prerequisites and NUT

These are installation instructions for Debian/Raspberry Pi OS, to run on your
target host as a normal user with `sudo`. Return to [Quick Start](../README.md#quick-start)
or [CLI-only](../README.md#cli-only) after the requested steps. Nothing here
requires a development checkout. Resolve any failed command before continuing.

## Packages and Node.js 22

Use a supported OS with `/proc`, `/sys`, network access and a working system
clock. Raspberry Pi OS 64-bit is suitable for recent Raspberry Pi models.
Install the tools used by the guides:

```bash
sudo apt-get update
sudo apt-get install git curl ca-certificates xz-utils libstdc++6 nut-client util-linux
```

For the Telegram ID discovery helper, also install Python 3 (CLI-only users can
skip it):

```bash
sudo apt-get install python3
```

Check whether a system-wide Node.js 22 is already available:

```bash
command -v node
node --version
/usr/bin/node --version
```

On a new system, missing-command errors at this check are expected. If both
version commands report `v22.x`, continue to NUT or return to the README. A Node
installation under a user's home or shell version manager is unsuitable for
the hardened system service, which cannot access home directories.

If `/usr/bin/node` does not provide Node 22, the block below installs the official
Node 22 executable at `/usr/local/bin/node`, without replacing a distribution
package. It selects the binary by **OS architecture** (`arm64`, `armhf` or
`amd64`), verifies its SHA-256 checksum and needs no NPM packages. These binaries
require a compatible OS; see [Node 22 supported platforms](https://github.com/nodejs/node/blob/v22.x/BUILDING.md#platform-list).
Older ARMv6 hardware is outside this recipe.

The block stops if `/usr/local/bin/node` already exists: inspect and update that
existing Node installation using its own installation procedure instead of
overwriting it. Run this block once on a fresh host:

```bash
(
set -eu
test ! -e /usr/local/bin/node
test ! -L /usr/local/bin/node
case "$(dpkg --print-architecture)" in
    arm64) node_arch=arm64 ;;
    armhf) node_arch=armv7l ;;
    amd64) node_arch=x64 ;;
    *) printf '%s\n' 'Unsupported architecture for this recipe.' >&2; exit 1 ;;
esac
node_tmp=$(mktemp -d)
trap 'rm -rf "$node_tmp"' EXIT
cd "$node_tmp"
node_base=https://nodejs.org/download/release/latest-v22.x
curl --fail --silent --show-error --location "$node_base/SHASUMS256.txt" -o SHASUMS256.txt
node_archive=$(awk -v arch="$node_arch" '$2 ~ ("^node-v22\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") {print $2}' SHASUMS256.txt)
test -n "$node_archive"
curl --fail --silent --show-error --location "$node_base/$node_archive" -o "$node_archive"
awk -v archive="$node_archive" '$2 == archive {print}' SHASUMS256.txt | sha256sum --check -
tar -xf "$node_archive"
sudo install -d -o root -g root -m 0755 /usr/local/bin
sudo install -o root -g root -m 0755 "${node_archive%.tar.xz}/bin/node" /usr/local/bin/node
/usr/local/bin/node --version
)
```

The archive and checksum list come from the [official Node 22 release directory](https://nodejs.org/download/release/latest-v22.x/).
This installs the runtime needed by Raspi Guardian; NPM is not required. For
future Node security updates, use a reviewed Node 22 release and your chosen
system-wide installation method.

Ensure the CLI finds this Node in the current shell:

```bash
export PATH="/usr/local/bin:$PATH"
hash -r
node --version
node -e 'if (process.versions.node.split(".")[0] !== "22") process.exit(1)'
```

Continue only after this check succeeds. Keep `/usr/local/bin` in your login
`PATH` for future SSH sessions. [Quick Start step 6](../README.md#6-install-systemd-and-enable-automatic-startup)
includes the local systemd override needed when `/usr/bin/node` does not provide
Node 22. CLI-only users need no systemd override.

## NUT setup

Choose **one** path. If NUT is already configured and working, preserve it and
skip to [read-only verification](#read-only-verification). Raspi Guardian needs
only `upsc` data access; it never needs NUT administrative credentials.

### Existing remote NUT server

Use the name exposed by your NUT server and its hostname. For example:

```bash
/usr/bin/upsc -l nut.example.org
/usr/bin/upsc example-ups@nut.example.org:3493
```

Replace `nut.example.org` and `example-ups` with your server's values. Configure
the server's access rules and network protection; do not expose an unprotected
NUT server to the Internet. This provides diagnostic data only. If this Raspberry
Pi also needs NUT-managed shutdown, configure its own `upsmon` in `MODE=netclient`
with the remote monitor credentials and role from your NUT administrator.
Follow the [NUT configuration manual](https://networkupstools.org/docs/user-manual.chunked/ar01s06.html).
Setting `GUARDIAN_UPS_NAME` alone does not provide shutdown protection.

### New local USB UPS

The example below is for **one USB UPS supported by `usbhid-ups`**. Check the
[NUT hardware compatibility list](https://networkupstools.org/stable-hcl.html)
first; other devices require their own driver and port settings. Connect the UPS
data cable to the Raspberry Pi. These steps configure NUT independently of
Raspi Guardian; do not replace a working NUT configuration with this example.

```bash
sudo apt-get install nut-server nut-client
sudoedit /etc/nut/nut.conf /etc/nut/ups.conf /etc/nut/upsd.conf /etc/nut/upsd.users /etc/nut/upsmon.conf
```

If the driver later reports USB permission errors, reconnect only the UPS data
cable after package installation so the packaged udev rules apply. NUT's driver
owns device access; the Raspi Guardian account does not need USB permissions.

In `/etc/nut/nut.conf`, set:

```ini
MODE=standalone
```

Add this device section in `/etc/nut/ups.conf`:

```ini
[example-ups]
    driver = usbhid-ups
    port = auto
```

In `/etc/nut/upsd.conf`, use local listeners only:

```text
LISTEN 127.0.0.1 3493
LISTEN ::1 3493
```

If IPv6 is disabled on the host, omit the second listener. In
`/etc/nut/upsd.users`, add:

```ini
[guardian-monitor]
    password = YOUR_PRIVATE_NUT_PASSWORD
    upsmon primary
```

Choose a new private NUT password and replace `YOUR_PRIVATE_NUT_PASSWORD` in
both files. A long random alphanumeric password avoids NUT quoting issues.
It is unrelated to Telegram and is never entered into Raspi Guardian.
In `/etc/nut/upsmon.conf`, add the monitor line and ensure `MINSUPPLIES` is set
once, as follows:

```text
MONITOR example-ups@localhost 1 guardian-monitor YOUR_PRIVATE_NUT_PASSWORD primary
MINSUPPLIES 1
```

Keep the distribution's active `SHUTDOWNCMD` and `POWERDOWNFLAG` settings and its
shutdown hooks; do not replace the whole file with the two lines above. Those
settings control system shutdown and UPS power-off integration. Follow the
[upsmon configuration reference](https://networkupstools.org/docs/man/upsmon.conf.html)
before relying on protection. NUT versions before 2.8 use `master` instead of
`primary` in **both** private files.

Protect the configuration (Debian/Raspberry Pi OS packages create the `nut`
group), then start the packaged components:

```bash
sudo chown root:nut /etc/nut/nut.conf /etc/nut/ups.conf /etc/nut/upsd.conf /etc/nut/upsd.users /etc/nut/upsmon.conf
sudo chmod 0640 /etc/nut/nut.conf /etc/nut/ups.conf /etc/nut/upsd.conf /etc/nut/upsd.users /etc/nut/upsmon.conf
systemctl list-unit-files 'nut*'
```

For packages listing `nut-driver-enumerator.service`, initialize the per-device
drivers and enable the supplied boot target:

```bash
sudo systemctl enable nut-driver-enumerator.service
sudo systemctl restart nut-driver-enumerator.service
sudo systemctl enable --now nut.target
```

Older packages listing `nut-driver.service` instead use that driver service:

```bash
sudo systemctl enable --now nut-driver.service
```

Run only the driver block matching the installed package. Then enable and
start the data server and shutdown monitor:

```bash
sudo systemctl enable nut-server.service nut-monitor.service
sudo systemctl restart nut-server.service nut-monitor.service
sudo systemctl status nut-server.service nut-monitor.service --no-pager
sudo journalctl -u nut-server.service -u nut-monitor.service -n 50 --no-pager
```

The enumerator maps `ups.conf` devices to driver instances; see the
[NUT driver enumerator reference](https://networkupstools.org/docs/man/nut-driver-enumerator.html).
If your package supplies different unit names, use its documented integration
before proceeding. A driver error needs resolving even if the server is running.

### Read-only verification

For the local example:

```bash
/usr/bin/upsc -l localhost
/usr/bin/upsc example-ups@localhost
```

Use the actual UPS name returned by the server. For a remote UPS, substitute its
hostname and optional port as above. Expect an `ups.status` containing `OL`
(online) or `OB` (on battery), rather than connection, stale-data or driver
errors. Run these queries as your SSH user; Quick Start step 5 also verifies
access for the dedicated service account after creating it. Successful `upsc` output
confirms data access, **not a working shutdown procedure**. Verify NUT's
independent shutdown setup according to its manual before relying on the UPS;
do not force a shutdown or unplug power just to test Raspi Guardian setup.

Use this verified destination in `GUARDIAN_UPS_NAME`. See the
[upsc destination syntax](https://networkupstools.org/docs/man/upsc.html).
Missing charge, runtime, load, voltage or model values are reported as unavailable.
Manufacturer/model strings and NUT status flags remain as reported by NUT;
surrounding labels are translated. Return to [Quick Start step 3](../README.md#3-create-the-private-telegram-group-and-discover-ids)
or continue your [CLI-only installation](../README.md#cli-only).
