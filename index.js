/**
 * dsh-browserbase-provider — Browserbase cloud browser as a DSH browser-use provider.
 *
 * Mounted from the seam's published contract (`ctx.browserUse.register(name)`
 * claims the single provider slot) and Browserbase's documented REST API
 * (`POST /v1/sessions` → `connectUrl`, then anything that speaks CDP).
 *
 * What it does:
 *   1. Claims the browser-use slot under the name `browserbase`.
 *   2. On the first tool call, creates a Browserbase session with the key and
 *      attaches playwright-core to it over CDP. The browser runs at Browserbase;
 *      nothing runs locally except the client connection.
 *   3. Exposes four tools: browser_navigate, browser_evaluate,
 *      browser_screenshot, browser_close.
 *
 * Key resolution: plugin config, then DSH's credential store, then the environment.
 */

import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'browserbase-provider';

/** The services this provider needs. */
export const inject = ['browserUse', 'tools'];

const BROWSERBASE_API = 'https://api.browserbase.com/v1';
const DEFAULT_KEY_REF = 'BROWSERBASE_API_KEY';

/** The key: plugin config, then DSH's credential store, then the environment. */
async function resolveKey(ctx, config) {
  const literal = config?.apiKey;
  if (typeof literal === 'string' && literal.trim()) return literal.trim();

  const ref =
    typeof config?.apiKeyRef === 'string' && config.apiKeyRef.trim() ? config.apiKeyRef.trim() : DEFAULT_KEY_REF;

  const credentials = ctx?.get?.('credentials');
  if (credentials !== undefined) {
    try {
      const resolved = await credentials.resolve(ref);
      const value = resolved?.value;
      if (typeof value === 'string' && value.trim()) return value.trim();
    } catch {
      /* no such reference; fall through */
    }
  }

  const fromEnv = process.env[ref];
  if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim();
  return undefined;
}

function missingKey() {
  return new Error(
    'browserbase: no API key. Set config.apiKey, or DSH\'s credential store as ' +
      `${DEFAULT_KEY_REF} (~/.dsh/.credentials.yaml), or $${DEFAULT_KEY_REF} in the environment.`,
  );
}

/** One Browserbase REST call; the body is returned exactly as it arrived. */
async function browserbaseRequest(path, { key, method = 'GET', body } = {}) {
  const res = await fetch(`${BROWSERBASE_API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-bb-api-key': key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text().catch(() => '');
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const detail = String(json?.message ?? json?.error ?? text ?? '').trim().slice(0, 300);
    throw new Error(`Browserbase HTTP ${res.status} ${res.statusText}${detail ? `: ${detail}` : ''}`);
  }
  return json;
}

/**
 * The browser handle. Lazily acquired, owned by this provider, torn down when
 * the registration is released.
 */
function createRuntime(ctx, config) {
  let browser;
  let page;
  let connecting;
  let idleTimer;
  /** Set by close(). Only a caller that names a URL may start a fresh session. */
  let closed = false;

  /** Seconds of no tool call after which the session is closed. 0 disables it. */
  const idleCloseMs = (Number.isInteger(config?.idleCloseSeconds) ? config.idleCloseSeconds : 60) * 1000;

  /** Browserbase ends the session on its own after this many seconds. */
  const sessionTimeoutSeconds = Number.isInteger(config?.sessionTimeoutSeconds)
    ? config.sessionTimeoutSeconds
    : 300;

  /**
   * The project sessions belong to. Browserbase's docs list `projectId` on session
   * creation; in practice a session also opens without it, so it is sent only when
   * one is configured — via config.projectId or $BROWSERBASE_PROJECT_ID.
   */
  const configuredProjectId =
    typeof config?.projectId === 'string' && config.projectId.trim()
      ? config.projectId.trim()
      : typeof process.env.BROWSERBASE_PROJECT_ID === 'string' && process.env.BROWSERBASE_PROJECT_ID.trim()
        ? process.env.BROWSERBASE_PROJECT_ID.trim()
        : undefined;

  function scheduleIdleClose() {
    if (idleCloseMs <= 0) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void close();
    }, idleCloseMs);
    idleTimer.unref?.();
  }

  async function connect(allowRestart = false) {
    if (page !== undefined) {
      scheduleIdleClose();
      return page;
    }
    if (closed && !allowRestart) {
      throw new Error(
        'browserbase: the session was closed. Call browser_navigate with a URL to open a new cloud browser session.',
      );
    }
    if (connecting !== undefined) return connecting;

    connecting = (async () => {
      const key = await resolveKey(ctx, config);
      if (key === undefined) throw missingKey();

      const session = await browserbaseRequest('/sessions', {
        key,
        method: 'POST',
        body: {
          timeout: sessionTimeoutSeconds,
          ...(configuredProjectId === undefined ? {} : { projectId: configuredProjectId }),
          ...(config?.sessionOptions ?? {}),
        },
      });
      const connectUrl = session?.connectUrl;
      if (typeof connectUrl !== 'string' || connectUrl === '') {
        throw new Error(`browserbase: session created but no connectUrl came back: ${JSON.stringify(session)}`);
      }

      // Imported lazily so a missing dependency fails one call, not the whole load.
      const { chromium } = await import('playwright-core');
      browser = await chromium.connectOverCDP(connectUrl);
      const context = browser.contexts()[0] ?? (await browser.newContext());
      page = context.pages()[0] ?? (await context.newPage());
      closed = false;
      scheduleIdleClose();
      return page;
    })();

    try {
      return await connecting;
    } finally {
      connecting = undefined;
    }
  }

  async function close() {
    clearTimeout(idleTimer);
    try {
      if (browser !== undefined) await browser.close();
    } catch {
      /* teardown is best-effort */
    }
    browser = undefined;
    page = undefined;
    closed = true;
  }

  return { connect, close };
}

/** Resolve a caller-supplied path against the session working directory. */
function resolvePath(target, exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return isAbsolute(target) ? target : resolve(cwd ?? process.cwd(), target);
}

function navigateTool(runtime) {
  return {
    name: 'browser_navigate',
    description:
      'Open a URL in the Browserbase cloud browser and return the page title and final URL. This provider drives a ' +
      'real Chromium running at Browserbase, not a local one.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'The URL to open.' },
        waitUntil: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle', 'commit'],
          description: 'When to consider navigation finished. Defaults to domcontentloaded.',
        },
      },
      required: ['url'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          status: { type: 'integer' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Opened ${value?.url ?? '(unknown)'}${value?.title ? ` — "${value.title}"` : ''}${
            value?.status === undefined ? '' : ` (HTTP ${value.status})`
          }`,
        },
      ],
    },
    async execute(args) {
      const url = typeof args?.url === 'string' ? args.url.trim() : '';
      if (url === '') throw new Error('browser_navigate: "url" must be a non-empty string.');
      const page = await runtime.connect(true);
      const response = await page.goto(url, { waitUntil: args?.waitUntil ?? 'domcontentloaded' });
      return {
        url: page.url(),
        title: await page.title(),
        status: response === null ? undefined : response.status(),
      };
    },
    isConcurrencySafe() {
      return false;
    },
    timeoutMs: 120000,
  };
}

function evaluateTool(runtime) {
  return {
    name: 'browser_evaluate',
    description:
      'Run a JavaScript expression in the current page of the Browserbase cloud browser and return its value as ' +
      'JSON. Use it for measurements — computed styles, contrast inputs, element sizes, overflow checks.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        expression: {
          type: 'string',
          description: 'A JavaScript expression evaluated in the page. Its value is returned, JSON-serialised.',
        },
      },
      required: ['expression'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { value: {} },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value?.value ?? null, null, 2) }],
    },
    async execute(args) {
      const expression = typeof args?.expression === 'string' ? args.expression : '';
      if (expression.trim() === '') throw new Error('browser_evaluate: "expression" must be a non-empty string.');
      const page = await runtime.connect();
      const value = await page.evaluate(expression);
      return { value: value === undefined ? null : value };
    },
    isConcurrencySafe() {
      return false;
    },
    timeoutMs: 60000,
  };
}

function screenshotTool(runtime) {
  return {
    name: 'browser_screenshot',
    description:
      'Capture a screenshot of the current page in the Browserbase cloud browser and save it to a file, returning ' +
      'the path. Use it to look at layout, breakpoints and visual quality.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'Where to write the PNG. Defaults to ./browserbase-screenshot.png.' },
        fullPage: { type: 'boolean', description: 'Capture the whole scrollable page. Defaults to false.' },
        width: { type: 'integer', description: 'Viewport width to set before capturing, e.g. 375, 768, 1280.' },
        height: { type: 'integer', description: 'Viewport height to set before capturing.' },
      },
      required: [],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { path: { type: 'string' }, bytes: { type: 'integer' } },
      },
      render: (_args, value) => [
        { type: 'text', text: `Screenshot saved to ${value?.path ?? '(unknown)'} (${value?.bytes ?? 0} bytes)` },
      ],
    },
    async execute(args, exec) {
      const page = await runtime.connect();
      if (Number.isInteger(args?.width) || Number.isInteger(args?.height)) {
        await page.setViewportSize({
          width: Number.isInteger(args?.width) ? args.width : 1280,
          height: Number.isInteger(args?.height) ? args.height : 800,
        });
      }
      const target = resolvePath(
        typeof args?.path === 'string' && args.path.trim() !== '' ? args.path.trim() : 'browserbase-screenshot.png',
        exec,
      );
      const buffer = await page.screenshot({ fullPage: args?.fullPage === true, type: 'png' });
      await writeFile(target, buffer);
      return { path: target, bytes: buffer.length };
    },
    isConcurrencySafe() {
      return false;
    },
    timeoutMs: 120000,
  };
}

/** Close the cloud browser now, so a metered session stops burning minutes. */
function closeTool(runtime) {
  return {
    name: 'browser_close',
    description:
      'Close the Browserbase cloud browser session immediately, ending its billing. Call this as soon as you are done ' +
      'with the page. A session also closes on its own after an idle period with no tool calls.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { closed: { type: 'boolean' } } },
      render: () => [{ type: 'text', text: 'Browserbase session closed.' }],
    },
    async execute() {
      await runtime.close();
      return { closed: true };
    },
    isConcurrencySafe() {
      return true;
    },
    timeoutMs: 30000,
  };
}

/**
 * Claim the browser-use slot and register this provider's tools.
 *
 * The slot is exclusive: a second provider fails to load while this one holds
 * it. Releasing the registration closes the cloud browser this provider owns.
 */
export function apply(ctx, config) {
  const runtime = createRuntime(ctx, config);

  ctx.effect(
    () => ctx.browserUse.register(BrowserUseProviderName('browserbase')),
    'browserbase provider registration',
  );

  ctx.effect(() => ctx.tools.register(navigateTool(runtime)), 'browser_navigate tool registration');
  ctx.effect(() => ctx.tools.register(evaluateTool(runtime)), 'browser_evaluate tool registration');
  ctx.effect(() => ctx.tools.register(screenshotTool(runtime)), 'browser_screenshot tool registration');
  ctx.effect(() => ctx.tools.register(closeTool(runtime)), 'browser_close tool registration');

  ctx.effect(() => () => runtime.close(), 'browserbase runtime teardown');
}
