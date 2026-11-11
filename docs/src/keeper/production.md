# Running in Production

A keeper earns by being there when a call comes due, so it runs around the clock. This page covers
what that takes: how many processes, where the keeper keeps its state and how restarts use it, the
Docker image, systemd and pm2 samples, alerts, logs, upgrades, backups and monitoring.

## One Process per Set of Wallets

Run one keeper process for each set of wallets. Each wallet is a nonce sequence the process manages
itself; two processes signing with the same wallet would take each other's nonces. To split work
across machines, give each process its own wallets (and its own jobs or markets).

One process can run every job on every market. To keep latency-critical sends off the queue of
slower work, give `liquidation` and `triggers` their own wallet in the same process
([Wallets & Secrets](wallets.md#several-wallets)).

## The State Directory and Restarts

The keeper keeps three files under `state.dir` (`~/.bazaar` by default; `state/` beside the config
when `init` wrote it), in `keeper/<chainId>-<first 8 hex digits of the factory>/`:

| File | What it holds | Written |
|---|---|---|
| `snapshot.json` | the index: markets, open positions, live orders, and the block it is current to | every `engine.snapshotSeconds` (60 s) and on a clean stop, atomically (a temporary file renamed over it) |
| `ledger.jsonl` | one line per sent transaction: the earnings record and what the daily budgets count | appended after each receipt |
| `status.json` | what `bazaar keeper status` reads | every 5 s, atomically |

**Restarts.** A restart loads the snapshot and replays every block since it, from the chain's logs (the
subgraph is not asked again), so nothing is missed while the keeper was down. A snapshot for another
chain, another factory or another snapshot format is ignored, and the keeper builds its index afresh.
Deleting the snapshot forces that too. While the replay is 64 or more blocks behind the head, the
price-driven planners wait for it to finish.

**Stopping.** SIGINT or SIGTERM stops cleanly: no new call is dispatched, in-flight sends get their
receipts (up to 60 s), `collect` claims every balance that covers its gas if `onShutdown` is on, and
the snapshot is saved. A second signal leaves at once (exit code 130). Give your process manager at
least 90 seconds before it kills the process.

**Exit codes.** `bazaar keeper start` exits 0 after a clean stop, 2 for a configuration or wallet
problem (fix the config; restarting will not help), and 1 for anything else (an RPC that cannot be
reached at start, say).

## Docker

The repository's `Dockerfile` builds an image that runs the keeper as an unprivileged user, with
everything it keeps in the directory mounted at `/config`:

```bash
git clone https://github.com/liberta-labs/bazaar-sdk && cd bazaar-sdk
docker build -t bazaar-keeper .
```

The image's entry point is the `bazaar` command, and its default command is `keeper start`. Its working
directory is `/config`, so the default config path, `bazaar-keeper.yaml`, is `/config/bazaar-keeper.yaml`.
`HOME` is `/config` as well, so any `~/` path (the default `state.dir`, `~/.bazaar`; `bazaar wallet
new`'s `~/.bazaar/keys`) also lands on the mount.

Set it up once, interactively, then run it detached:

```bash
mkdir -p keeper
# once: the wizard, inside the container
docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD/keeper:/config" bazaar-keeper keeper init
# check it
docker run --rm -it --user "$(id -u):$(id -g)" -v "$PWD/keeper:/config" bazaar-keeper keeper doctor
# run it
docker run -d --name keeper --restart unless-stopped --user "$(id -u):$(id -g)" \
  -v "$PWD/keeper:/config" bazaar-keeper
```

`init` run this way writes `/config/bazaar-keeper.yaml` and `/config/.env`, a new keystore under
`/config/keys/`, and `state.dir: /config/state`: all of it in `./keeper` on the host.

- **`--user "$(id -u):$(id -g)"`** runs the keeper as you, so it can write to the mounted directory
  and you own what it writes. Without it, the container runs as uid 10001, and the directory must be
  writable by that user.
- **Store the keystore password in `.env`** when `init` asks. A detached container has no terminal to
  ask for it, and stops with `wallet default (default.json) needs a password: …`.
- `docker stop keeper` sends SIGTERM, which stops the keeper cleanly. Docker waits 10 seconds by
  default before killing; give it longer: `docker stop -t 90 keeper` (or `--stop-timeout 90` on
  `docker run`).
- Other commands run the same way: `docker exec keeper node /app/packages/keeper/dist/cli/main.js
  keeper status`, or `docker run --rm --user … -v … bazaar-keeper keeper earnings --since 7d`.
- Logs: `docker logs -f keeper`. Set `log.format: json` for a log collector.

## systemd

A unit for a keeper installed from the repository in `/opt/bazaar-sdk`, with its directory at
`/srv/keeper`, running as a dedicated `keeper` user:

```ini
# /etc/systemd/system/bazaar-keeper.service
[Unit]
Description=Bazaar keeper
After=network-online.target
Wants=network-online.target

[Service]
User=keeper
Group=keeper
WorkingDirectory=/srv/keeper
ExecStart=/usr/bin/node /opt/bazaar-sdk/packages/keeper/dist/cli/main.js keeper start -c /srv/keeper/bazaar-keeper.yaml
# SIGTERM stops cleanly; give in-flight sends and the shutdown collect time to finish.
KillSignal=SIGTERM
TimeoutStopSec=90
Restart=on-failure
RestartSec=10
# A config or wallet error exits 2: restarting will not fix it.
RestartPreventExitStatus=2
# The keeper writes only its state directory (state.dir must be under /srv/keeper, as init sets it).
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/keeper
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now bazaar-keeper
journalctl -u bazaar-keeper -f
```

The keystore password must come from `.env` (or an `EnvironmentFile=` the unit reads): a service
cannot answer a prompt. With a global npm install, `ExecStart=/usr/bin/env bazaar keeper start -c …`.

## pm2

```js
// ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "bazaar-keeper",
      script: "/opt/bazaar-sdk/packages/keeper/dist/cli/main.js",
      args: "keeper start -c /srv/keeper/bazaar-keeper.yaml",
      cwd: "/srv/keeper",
      // pm2 sends SIGINT, then kills after kill_timeout ms: leave time for a clean stop.
      kill_timeout: 90000,
      autorestart: true,
      restart_delay: 10000,
    },
  ],
};
```

```bash
pm2 start ecosystem.config.cjs
pm2 logs bazaar-keeper
```

## Alerts

The keeper can send alerts to Telegram, Discord and any webhook. Each channel is its own request, so
one that is down does not hold back the others. Every alert is also logged as a warning (`alert
(lowBalance): …`), configured channels or not.

```yaml
alerts:
  telegram:
    botToken: ${TG_BOT_TOKEN}
    chatId: "123456789"
  discord:
    webhook: ${DISCORD_WEBHOOK_URL}
  webhook:
    url: ${ALERT_WEBHOOK_URL}
  notify: [lowBalance, jobPaused, endpointDown, opportunity, dailySummary]
```

| Channel | What it sends |
|---|---|
| `telegram` | `sendMessage` to `chatId` as the bot, plain text (no parse mode) |
| `discord` | the message as `content`, with every mention disabled (no `@everyone`, roles or users) |
| `webhook` | `POST` JSON: `{"kind": "lowBalance", "message": "…", "ts": 1762600998.1}` |

The bot token and the Discord webhook URL are secret keys, and a generic webhook URL usually carries
its own token in its path: put all three in `.env` ([the secrets rules](wallets.md#the-secrets-rules)).
Messages are prefixed `Bazaar keeper: ` and stripped of control characters.

`notify` chooses the kinds. Only the kinds listed are sent or logged.

| Kind | When | Repeats |
|---|---|---|
| `lowBalance` | a wallet is below `budget.minEthBalance` and sending is paused | the same message at most every 10 min |
| `jobPaused` | a job was paused on a market after `safety.pauseAfterReverts` on-chain reverts | every 10 min at most |
| `endpointDown` | the send endpoint gave no answer and the transaction has no receipt (booked as unknown) | every 10 min at most |
| `opportunity` | a manual operation is available or will open (scanned every 5 min, only when a channel is configured) | each one once a day |
| `dailySummary` | the last 24 hours' net, once a day (the first at start, when the ledger has entries) | daily |
| `action` | every sent call's result (not in the defaults) | every time |

A price endpoint that is down shows in the log (`price endpoint: …`) and in `status` (`prices down:
…`), not as an alert; watch `status.json` for it ([below](#monitoring)).

## Logs

The CLI logs to standard output. `log.level` is `debug`, `info` (default), `warning` or `error`;
`log.format` is `pretty` (default) or `json`:

```text
12:03:17 INFO    liquidation ETH/USD: sent 0x5c1e…a9 (earns $0.1000 for $0.0021 of gas)
```

```json
{"ts":1762600997.512,"level":"info","logger":"bazaar_sdk.exec","msg":"liquidation ETH/USD: sent 0x5c1e…a9 (earns $0.1000 for $0.0021 of gas)"}
```

A JSON line carries `exc` with the stack trace when there is one. At `info` the keeper logs each sent
call and its result, each distinct skip reason at most every five minutes (repeats at `debug`), new
listings, reorgs, catch-ups and warnings. Repeated failures (a planning error, a failing engine step)
are logged at most every 30 to 60 seconds. URLs and keys are never logged.

## Upgrades

1. Stop the keeper cleanly (SIGTERM, and wait for it to exit).
2. Upgrade: `npm install -g @liberta-labs/bazaar-keeper@latest` once published; from the repository,
   `git pull && npm install && npm run build`; with Docker, rebuild the image.
3. Run `bazaar keeper doctor` (a new version may refuse a key it no longer knows, or need a new one).
4. Start it again. It resumes from the snapshot. If the new version uses another snapshot format, it
   ignores the old snapshot and builds its index afresh (from the subgraph or the logs), which takes as
   long as a first start.

The ledger keeps its format across versions, so earnings and the daily budgets carry over.

## Backups

| What | Why | How |
|---|---|---|
| the keystores (`keys/`) | the wallets themselves: lose them and you lose what they hold and have not claimed | copy them anywhere; they are encrypted |
| the keystore passwords (`.env`) | a keystore without its password is useless | keep them apart from the keystores, in a password manager |
| `ledger.jsonl` | your earnings record, and what the daily budgets count after a restart | copy it now and then |
| `bazaar-keeper.yaml` | your settings | it holds no secrets: commit it if you like |

The snapshot needs no backup: the keeper rebuilds it. A wallet's unclaimed bounties stay on chain on
each market's claimable balance whatever happens to the machine; restoring the keystore anywhere lets
you claim them (`bazaar keeper run collect`).

## Monitoring

`status.json` in the state directory is rewritten every 5 seconds while the keeper runs, so it is the
simplest thing to watch. `bazaar keeper status` renders it; a script can read it directly:

| Field | Meaning |
|---|---|
| `updated` | when it was written (seconds since the epoch): older than 30 s means the keeper is not running |
| `network`, `factory`, `official` | what it keeps, and whether the factory is a network's official one |
| `block`, `indexed` | the chain's head and the last block whose logs are applied: a growing gap means the keeper is behind |
| `prices` | `{healthy, error, feeds}`: whether prints are arriving, the endpoint's last error, how many feeds have a print |
| `markets[]` | per market: `label`, `address`, `status` (`live`, `adl`, `limbo`, `settling`, `terminated`, `unknown`), `positions`, `orders`, `inventory` (units), `atRisk` (positions within `watchBufferPct` of liquidation; null without the liquidation job), `priceAge` (seconds since the base leg's print) |
| `jobs` | per job: `markets` (count, or `all`), `last` (its latest sent call), `today` (the ledger's last 24 h: `calls`, `reward`, `cost`, `net`, `claimed`, `reverted`) |
| `wallets` | name to address |
| `halted` | empty, or why sending is paused (a wallet below `minEthBalance`) |

A watchdog in TypeScript that exits non-zero when the keeper is unwell, for cron or a monitoring
agent:

```ts
{{#include ../../examples/keeper/monitor.ts:monitor}}
```

Or in a shell, with `jq`:

```bash
S=/srv/keeper/state/keeper/42161-*/status.json
jq -e --argjson now "$(date +%s)" '($now - .updated) < 30 and .prices.healthy and (.halted == "")' $S >/dev/null \
  || echo "keeper unwell"
```

For metrics, run the keeper as a library and feed its `action` events to your metrics system, or
serve `keeper.statusDict()` over HTTP ([The Keeper as a Library](library.md#embedding-in-a-service)).

## Related Pages

- [Setting Up a Keeper](setup.md): the first run.
- [Wallets & Secrets](wallets.md): keystores and passwords.
- [Troubleshooting](troubleshooting.md): what each warning means.
