# dsh-browserbase-provider

Browserbase cloud browser as a [DeepSeek Harness (DSH)](https://github.com/stansz) `browser-use` provider.

This bundle claims the harness's exclusive `browser-use` slot under the provider name `browserbase`. On the first
browser tool call it creates a Browserbase session through Browserbase's REST API, attaches `playwright-core` to it
over CDP, and exposes the browser as four agent tools. Nothing runs locally except the CDP client connection.

## Requirements

- A DSH build that provides the `browser-use` seam (`@deepseek-ai/dsh-browser-use`) and the `ctx.tools` service.
  This bundle was developed against `@deepseek-ai/dsh-browser-use` `0.2.0-rc.2`.
- Node.js 20 or newer (the same floor as `playwright-core`).
- A [Browserbase](https://www.browserbase.com/) account and API key. Sessions are metered against that account.

## Install

Install the package into your DSH profile as a normal bundle — the profile's plugin manager accepts a registry name,
a git address, or an absolute local path:

- **GUI:** sidebar → **Plugins** → **Add plugin** → `https://github.com/stansz/dsh-browserbase-provider`
- **Profile dependency:** add `"dsh-browserbase-provider": "github:stansz/dsh-browserbase-provider"` to the
  profile's `package.json` and reinstall.

The bundle ships a `cordis.patch.yml` that inserts the two rows this provider needs:

| Row | Module | Role |
|---|---|---|
| `browser-use` | `./browser-use.js` | The seam, re-exported from inside the bundle so it resolves under every install form |
| `browserbase-provider` | `dsh-browserbase-provider` | Claims the slot and registers the tools |

Nothing shipped by DSH is overridden. The slot is exclusive: a second provider cannot load while this one holds it.

## Configure

There is no settings page; configure the `browserbase-provider` row in the profile's `cordis.patch.yml`:

```yaml
- id: browserbase-provider
  name: dsh-browserbase-provider
  config:
    # Every field here is optional; the row loads without any config. An API key
    # is still required to open a session — it just resolves from the credential
    # store or the environment by default (see "API key handling" below).
    apiKeyRef: BROWSERBASE_API_KEY   # credential reference to read the key from
    projectId: <browserbase-project-id>
    idleCloseSeconds: 60             # close a session after this long with no tool call (0 disables)
    sessionTimeoutSeconds: 300       # Browserbase-side session timeout
    sessionOptions: {}               # extra fields merged into POST /v1/sessions
```

An API key is always required to create a session, but only one of the three sources listed under **API key
handling** needs to provide it — a row with no `config` block at all is valid when the key lives in the credential
store (the usual setup).

An id-targeted patch replaces the whole matched config, not a deep merge — restate any field you keep.

| Field | Default | Meaning |
|---|---|---|
| `apiKey` | (unset) | Literal key; overrides the reference. Prefer the credential store. |
| `apiKeyRef` | `BROWSERBASE_API_KEY` | Credential reference holding the key |
| `projectId` | `$BROWSERBASE_PROJECT_ID` | Project new sessions belong to; sessions also open without it |
| `idleCloseSeconds` | `60` | Idle auto-close; `0` disables it |
| `sessionTimeoutSeconds` | `300` | Browserbase session timeout |
| `sessionOptions` | `{}` | Extra fields sent with the session-create request |

## API key handling

The key is resolved per session, in this order:

1. `apiKey` in the row's config
2. DSH's credential store — the reference named by `apiKeyRef` (default `BROWSERBASE_API_KEY`), e.g. a `refs:` entry
   in `~/.dsh/.credentials.yaml`
3. DSH's process environment — `$BROWSERBASE_API_KEY`

The resolved key is sent only to `https://api.browserbase.com` over HTTPS. It is never written to disk and never
logged. **Never commit a key**: put it in the DSH credential store or the launch environment, and keep `.env` files
out of git (this repo ignores them).

`projectId` is read from the row config or `$BROWSERBASE_PROJECT_ID` only; the credential store is not consulted for it.

## Tools

| Tool | Purpose |
|---|---|
| `browser_navigate` | Open a URL; returns final URL, title, and HTTP status |
| `browser_evaluate` | Evaluate a JavaScript expression in the current page and return its JSON value |
| `browser_screenshot` | Capture the page (optionally full-page or at a set viewport) to a PNG file |
| `browser_close` | End the Browserbase session immediately |

Sessions are metered. The provider closes one after `idleCloseSeconds` without a tool call, and `browser_close`
ends it explicitly. After a close, only `browser_navigate` (which names a URL) may open a fresh session.

## Notes

- **Row resolution.** A loader row's `name` is imported relative to the profile's config file. A bare
  `@deepseek-ai/dsh-browser-use` therefore fails to resolve when the package is a dependency of this bundle rather
  than of the profile (`ERR_MODULE_NOT_FOUND`), and the provider would stay pending forever. The `browser-use` row
  points at `./browser-use.js` instead — a re-export anchored beside the bundle's patch file — so it resolves for
  git installs, registry installs, and local `link:` installs alike.
- **Errors.** A missing key fails one tool call with a message naming all three places to set it, rather than
  failing the plugin load.
- **Screenshots** are written locally; the default path is `./browserbase-screenshot.png` (git-ignored).

## License

MIT — see [LICENSE](./LICENSE).
