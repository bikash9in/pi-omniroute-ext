# pi-omniroute-ext

Pi Coding Agent extension for [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — connect Pi to your OmniRoute AI gateway and route every model call through 370+ providers with quota-aware fallback.

**Install:** `pi install npm:pi-omniroute-ext`

The extension registers OmniRoute as a native Pi provider with dynamic model discovery, combo-aware model selection, optional reasoning levels, and interactive configuration — without touching your built-in providers.

## Features

* **Auto-discovery** — Fetches models and combos from OmniRoute's `GET /v1/models` (`?prefix=alias` to avoid duplicate ids), with a bounded 3s wait at startup so `/model` is usually populated immediately
* **Dynamic provider** — Registers `omniroute` as a Pi provider with a live model list under the `omniroute/` namespace
* **Combo support** — OmniRoute combos (`auto`, `auto/cheap`, your named combos) appear as selectable models marked `(combo)`; ids are passed to the gateway verbatim so routing works
* **Offline cache** — The last catalog is cached at `~/.cache/pi/omniroute-models.json`; Pi starts with cached models even when the gateway is down
* **Model metadata fallback** — Uses router-provided `context_length` / `max_output_tokens` when present, then cached metadata (`~/.cache/pi/omniroute-model-metadata.json`), then safe defaults (`128000` / `4096`)
* **Graceful startup** — Commands and tools register immediately; discovery is bounded at 3s during startup and continues in the background, so a down gateway never blocks Pi
* **Pi-native streaming** — Delegates to Pi's built-in OpenAI Chat Completions implementation (`openai-completions`), so message conversion, tool handling, usage accounting and cancellation stay Pi's job
* **Routing telemetry** — Reads `X-OmniRoute-Decision` and cost headers from responses to show which provider/strategy actually served a turn
* **Status line** — the TUI footer shows `OmniRoute · <provider> · <strategy> · <latency>` after every gateway response
* **Session tagging** — opt-in `X-OmniRoute-Session-Id` per Pi session so OmniRoute attributes cost per session (`call_logs.session_tag`)
* **Reasoning toggle** — Optionally expose Pi thinking levels and send `reasoning_effort` to OmniRoute
* **Status commands** — `/omniroute-status`, `/omniroute-models`, `/omniroute-config`, `/omniroute-combos`, `/omniroute-reasoning`, `/omniroute-reload`
* **LLM-callable status tool** — `omniroute_status` lets the model check gateway health and model counts
* **User-wide persistence** — Configuration survives new Pi instances via `~/.pi/agent/omniroute-config.json`

## Installation

### npm (Recommended)

```
pi install npm:pi-omniroute-ext
```

### Via local path

```bash
git clone https://github.com/bikash9in/pi-omniroute-ext.git
pi install ./pi-omniroute-ext
```

### Try without installing

```bash
pi -e ./pi-omniroute-ext
```

Full instructions (including installing and keying OmniRoute itself): **[docs/INSTALLATION.md](docs/INSTALLATION.md)**.

### Uninstall / disable

```bash
pi remove npm:pi-omniroute-ext   # uninstall completely (reverses the install)
pi config                        # or keep it installed and just toggle its resources off
```

`pi remove` drops the package from your settings; your OmniRoute config file
(`~/.pi/agent/omniroute-config.json`) and catalog cache are left in place, so a
re-install picks up where you left off. See [INSTALLATION.md §7](docs/INSTALLATION.md)
for `pi update --extensions` and scope details.

## Configuration

### Environment Variables

| Variable | Default | Description |
| --- | --- | --- |
| `OMNIROUTE_BASE_URL` | `http://localhost:20128` | Your OmniRoute instance URL |
| `OMNIROUTE_API_KEY` | — | OmniRoute API key (Dashboard → Endpoints / Settings → API Keys) |
| `OMNIROUTE_API` | `openai-completions` | Wire API: `openai-completions` or `anthropic-messages` |
| `OMNIROUTE_ENABLE_REASONING` | `false` | `true`/`1`/`on` exposes Pi thinking levels for OmniRoute models |
| `OMNIROUTE_SESSION_TAG` | `false` | `true`/`1`/`on` sends `X-OmniRoute-Session-Id` per Pi session (cost attribution) |
| `OMNIROUTE_DASHBOARD_URL` | same as base URL | Dashboard URL shown in messages |

```bash
OMNIROUTE_BASE_URL=http://my-vps:20128 OMNIROUTE_API_KEY=omni-... pi
```

### Interactive Configuration

Inside Pi, run:

```
/omniroute-config
```

This opens a menu for connection settings, wire API, reasoning, and telemetry defaults. It is saved to `~/.pi/agent/omniroute-config.json` and shared by new Pi instances. Environment variables take precedence when set.

## Usage

### Selecting an OmniRoute model

After discovery succeeds, OmniRoute models appear in Pi's model picker under the `omniroute/` namespace. Ids are passed to the gateway **verbatim**, so they match the catalog exactly:

```
/model omniroute/auto             # zero-config auto-combo channel
/model omniroute/glm/glm-5.2      # provider-prefixed catalog model
/model omniroute/CheapFix         # a named combo (shown with a (combo) marker)
```

Browse interactively with:

```
/omniroute-models
```

Built-in providers stay untouched — `openrouter/...`, `ollama-cloud/...`, etc. keep working exactly as before. This extension only registers the provider id `omniroute`.

### Reasoning / Thinking levels

Disabled by default (OmniRoute's model catalog does not reliably advertise reasoning support per model). If your routes support it:

```
/omniroute-reasoning
```

Then use Pi's normal controls (Shift+Tab, `--thinking high`, or a suffix like `omniroute/gpt-5.4:high`). The extension maps Pi levels to OpenAI-style `reasoning_effort` (`off → none`, `minimal → low`, `max → xhigh`; `low`, `medium`, `high`, `xhigh` pass through).

### Routing telemetry

When a response carries OmniRoute's `X-OmniRoute-Decision` header, `/omniroute-status` and the status tool report the strategy, provider and latency that actually served recent turns.

### Available Commands

| Command | Description |
| --- | --- |
| `/omniroute-status` | Connection status, model count, last routing decision, config |
| `/omniroute-models` | Browse and select from discovered OmniRoute models & combos |
| `/omniroute-config` | Menu for connection, wire API, reasoning and telemetry defaults |
| `/omniroute-combos` | Browse combos with their description, context size and capabilities |
| `/omniroute-reasoning` | Enable/disable thinking levels for OmniRoute models |
| `/omniroute-reload` | Re-run discovery against a running OmniRoute |

### Available Tools

* `omniroute_status` — gateway reachability, model/combo counts, configured base URL (never exposes the API key)

## How It Works

```
┌─────────┐  OpenAI-compatible   ┌───────────┐    ┌──────────────┐
│   Pi    │ ───────────────────▶ │ OmniRoute │ ──▶ │ 370+ providers│
│         │ /v1/chat/completions │  gateway  │    │ 150+ free     │
└─────────┘                      └───────────┘    └──────────────┘
     │  1. GET /v1/models (3s startup bound + background refresh + offline cache)
     │  2. registerProvider("omniroute") → openai-completions
     │  3. Streams via Pi's built-in OpenAI implementation
     │  4. Reads X-OmniRoute-* headers for telemetry
     │  5. Leaves built-in providers untouched
```

The full architecture/design document is part of the project's internal documentation (not published in this repository).

## Troubleshooting

**No `omniroute/` models after install**

* Expected before OmniRoute is reachable. Discovery runs in the background; Pi stays usable.
* Check the gateway: `curl http://localhost:20128/v1/models -H "Authorization: Bearer YOUR_KEY"`
* Run `/omniroute-reload`, or `/omniroute-config` to fix the base URL first.

**`401 Unauthorized` from OmniRoute**

* Set `OMNIROUTE_API_KEY` or configure the key in `/omniroute-config`.

**`auto` model fails**

* `auto` needs at least one eligible connected provider. Connect one in the OmniRoute dashboard, then `/omniroute-reload`.

**Models missing from the picker**

* Ensure the startup notification "OmniRoute connected — N models" appeared; run `/reload` after changing the extension.

**Built-in provider suddenly asks for login**

* The active model is probably `omniroute/...`, not the built-in one. Re-run `/login` for the built-in provider if needed; this extension never overrides built-in providers.

## Similar Projects

* [pi-9router-ext](https://www.npmjs.com/package/pi-9router-ext) — the equivalent extension for 9router
* [omniroute-pi-extension](https://www.npmjs.com/package/omniroute-pi-extension) — an OmniRoute manager/status-bar extension for Pi

## Documentation

| Document | Contents |
| --- | --- |
| [docs/INSTALLATION.md](docs/INSTALLATION.md) | End-to-end install (OmniRoute + extension), verify, uninstall |

> Product requirements, architecture, development, release-notes and OmniRoute-integration documents are maintained in the project's **internal (private) documentation repository** and are not published here.

## License

MIT
