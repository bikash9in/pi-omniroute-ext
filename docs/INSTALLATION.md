# Installation — pi-omniroute-ext

End-to-end setup: get OmniRoute running, key it, install the Pi extension, verify. Uninstall and upgrade at the end.

## 1. Prerequisites

| Requirement | Version | Check |
| --- | --- | --- |
| Node.js | ≥ 20 (24 recommended) | `node --version` |
| Pi Coding Agent | current stable (package manifest + `registerProvider` support) | `pi --version` |
| OmniRoute | v3.8.x (v2.9+ minimum) | see §2 |
| Network | `localhost:20128` reachable from the Pi process (or your remote instance over HTTPS) | `curl` in §4 |

## 2. Install & start OmniRoute

Pick one:

```bash
# A. npm (global)
npm install -g omniroute
omniroute

# B. npx (no install)
npx -y omniroute

# C. Docker
docker run -d --name omniroute -p 20128:20128 diegosouzapw/omniroute

# D. From source
git clone https://github.com/diegosouzapw/OmniRoute.git && cd OmniRoute
npm install && npm run dev
```

The dashboard listens on **`http://localhost:20128`** by default.

1. Open the dashboard and **connect at least one provider** (API key, OAuth, or a keyless/free one). The `auto` model only routes when an eligible connection exists.
2. Copy your **OmniRoute API key** — Dashboard → *Endpoints* (or *Settings → API Keys*). If the instance runs with key enforcement, this step is mandatory.

Quick sanity check:

```bash
curl http://localhost:20128/v1/models -H "Authorization: Bearer YOUR_OMNIROUTE_KEY"
# → {"object":"list","data":[ ... models and combos ... ]}
```

## 3. Install the Pi extension

### Option A — npm (recommended)

```
pi install npm:pi-omniroute-ext
```

Installs to your personal settings (`~/.pi/agent/settings.json`).

Project-scoped (written to `.pi/settings.json`, loads after project trust):

```
pi install npm:pi-omniroute-ext --local
```

### Option B — git

```
pi install git:github.com/bikash9in/pi-omniroute-ext
```

### Option C — local path (development)

```bash
git clone https://github.com/bikash9in/pi-omniroute-ext.git
cd pi-omniroute-ext
pi install "$PWD"          # installs the working tree
# or one-shot without installing:
pi -e "$PWD"
```

### Option D — try before buying

```
pi -e npm:pi-omniroute-ext
```

> Prefer installing the **package directory** over copying `src/index.ts` into `~/.pi/agent/extensions`. Copying a single file bypasses `package.json` metadata and can miss companion modules.

## 4. Configure

### 4.1 Environment variables (take highest precedence)

| Variable | Default | Description |
| --- | --- | --- |
| `OMNIROUTE_BASE_URL` | `http://localhost:20128` | Gateway URL (no `/v1` suffix) |
| `OMNIROUTE_API_KEY` | — | Bearer key from the dashboard |
| `OMNIROUTE_API` | `openai-completions` | `openai-completions` or `anthropic-messages` |
| `OMNIROUTE_ENABLE_REASONING` | `false` | `true` / `1` / `on` enables thinking levels |
| `OMNIROUTE_SESSION_TAG` | `false` | `true` / `1` / `on` sends `X-OmniRoute-Session-Id` per Pi session |
| `OMNIROUTE_DASHBOARD_URL` | base URL | Dashboard link shown in messages |

```bash
# Windows (PowerShell)
$env:OMNIROUTE_API_KEY="omni-..."; pi

# macOS / Linux
OMNIROUTE_API_KEY=omni-... pi
```

### 4.2 Interactive config (persists)

Inside Pi:

```
/omniroute-config
```

Set base URL, key, wire API, reasoning and telemetry toggles. Saved to `~/.pi/agent/omniroute-config.json`, shared by every new Pi instance. **Precedence: env var > config file > default.**

### 4.3 Remote / HTTPS instance

```
OMNIROUTE_BASE_URL=https://omni.example.com OMNIROUTE_API_KEY=omni-... pi
```

## 5. Verify

1. Start Pi — expect startup notification: `OmniRoute connected — N models, M combos`.
2. Check status:

   ```
   /omniroute-status
   ```

   Should show: reachable ✓, base URL, model/combo counts, API (no key shown).
3. Pick a model:

   ```
   /model omniroute/auto
   ```

   or browse `/omniroute-models`, then send a message.
4. After a turn, `/omniroute-status` should show the last routing decision:

   ```
   Last routing   strategy=priority · provider=groq · latency=412ms · just now
   ```

### Verification checklist

- [ ] `curl /v1/models` returns data with the key
- [ ] Pi startup shows the connected notification with counts
- [ ] `/model` lists `omniroute/...` entries
- [ ] A test turn on `omniroute/auto` completes
- [ ] Built-in providers (e.g. `openrouter/...`) still work
- [ ] New Pi instance picks up saved config (no re-entry)

## 6. Troubleshooting

| Symptom | Fix |
| --- | --- |
| No notification / no models | `curl` the base URL; verify `OMNIROUTE_BASE_URL` (host/port); run `/omniroute-reload` |
| `401 Unauthorized` | Set `OMNIROUTE_API_KEY` or save the key in `/omniroute-config` |
| `auto` fails with no route | Connect a provider in the dashboard → `/omniroute-reload` |
| Models missing/duplicated | Instance may use `dual` catalog prefix mode — extension requests `?prefix=alias`; reload after server-side catalog changes |
| Extension not loading | `pi list` shows the package? `/reload`? Check project trust if installed `--local` |
| Wrong Pi defaults (context/output) | Metadata cache: delete `~/.cache/pi/omniroute-model-metadata.json` and `/omniroute-reload` |

## 7. Upgrade, disable, uninstall

```bash
pi update --extensions        # reconcile installed packages
pi list                       # confirm what's configured
pi remove npm:pi-omniroute-ext   # uninstall
```

Disable without uninstalling: `pi config` → toggle the package's resources off (Tab switches scope).

Local dev loop: edit code → `/reload` inside the running Pi session.

## 8. Related documents

* [README.md](../README.md) — features & usage

> Architecture, development, release-notes (changelog) and OmniRoute-integration documents are internal
> (kept in the project's private documentation repository).
