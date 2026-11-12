// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Records the GIF of the README (docs/images/devspaces.gif) from a real VS Code with the packaged extension, in the
// style of the GIFs of nimblescape PlantUML, Mindbug and Comment Links: a window of 1440 x 816 pixels at a zoom of
// 120 %, the theme Dark Modern, a blue band above the window with the number and the caption of the scene, 15 frames
// per second. CI only (.github/workflows/readme-gif.yml), after
//   DEVSPACE_TEST_ATTACH_PREPARE=gif npm run test:vscode:attach:prepare   (the demo devspace, test/vscode/attach/prepare.ts)
//   node scripts/install-attach-extensions.mjs                           (the VSIX files of the extension and of the test sign-in)
// because it points api.github.com of this computer to the fake GitHub API of fakeGitHub.mjs (/etc/hosts) and adds its
// certificate authority to the certificates of the system. It needs Xvfb, xdotool, ffmpeg and the font Inter.
//
// The six scenes: the sign-in, after which the view lists the demo repositories; the start of the demo devspace (the
// wait for its container is cut out); the view Docker Hosts with the objects of the host; the report of a volume and of
// the devspace container in a preview tab, which a double-click keeps; the report and the log of the Monitor; and the
// utilization page of the host. The output folder test/gif/output/ gets the GIF, the video of the take with its marks,
// a screenshot of each scene and the logs.
/* global document, window -- The functions that Workbench.evaluate runs in the page of the window use them. */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, click, jump, move, placeWindow, record, screenshot, SCREEN, startXvfb, targets, wait, xdo } from './desktop.mjs';
import { makeCertificates, startFakeGitHub } from './fakeGitHub.mjs';
import { writeGif } from './gif.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT = path.join(ROOT, 'test', 'gif', 'output');
const GIF = path.join(OUT, 'devspaces.gif');
const PORT = 9222;
const EXTENSION_ID = 'nimblescape.nimblescape-devspaces-2';
/** The longest wait for the window of the devspace: the build of its image, the container, and the VS Code Server. */
const OPEN_TIMEOUT_MS = 8 * 60_000;

/** The captions of the band, one for each scene. */
const CAPTIONS = [
  'Sign in with GitHub: the repositories with a Dev Container configuration',
  'Start: Devspaces builds the container and connects the window (the wait is shortened)',
  'Docker Hosts: the containers, images, volumes and networks of each host',
  'A click opens the report of an object in a preview tab; a double-click keeps it',
  'The report of the Monitor lists its runs; Show Log of the Monitor opens its log',
  'Show Utilization: CPU, memory and disk of the host and of each container',
];

/**
 * VS Code as in the other GIFs, but with the activity bar and the side bar, where the views of Devspaces are, and with
 * dialogs inside the window (there is no window manager on the display).
 */
const SETTINGS = {
  'workbench.colorTheme': 'Default Dark Modern',
  'window.zoomLevel': 1,
  'window.titleBarStyle': 'custom',
  'window.dialogStyle': 'custom',
  'window.restoreWindows': 'none',
  'window.menuBarVisibility': 'classic',
  'window.commandCenter': true,
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.layoutControl.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'workbench.enableExperiments': false,
  'chat.disableAIFeatures': true,
  'editor.minimap.enabled': false,
  'editor.stickyScroll.enabled': false,
  'security.workspace.trust.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.ignoreRecommendations': true,
  'extensions.autoCheckUpdates': false,
  'extensions.autoUpdate': 'off',
  'git.openRepositoryInParentFolders': 'never',
};

const log = (message) => console.log(`${new Date().toISOString()} ${message}`);

/** A command as root: directly when this process is root, else with sudo (the runners of GitHub need no password). */
function asRoot(command, args, input) {
  const [file, list] = process.getuid?.() === 0 ? [command, args] : ['sudo', [command, ...args]];
  execFileSync(file, list, { input, stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'] });
}

/**
 * api.github.com of this computer is the fake GitHub API on port 443 of 127.0.0.1 with the certificate authority of
 * `certs`; the font Inter is the font of the user interface, as on the computer of the other GIFs.
 */
function prepareComputer(certs) {
  if (process.getuid?.() !== 0) asRoot('sysctl', ['-w', 'net.ipv4.ip_unprivileged_port_start=443']);
  asRoot('cp', [certs.ca, '/usr/local/share/ca-certificates/devspaces-readme-gif.crt']);
  asRoot('update-ca-certificates', []);
  if (!fs.readFileSync('/etc/hosts', 'utf8').includes(' api.github.com')) asRoot('tee', ['-a', '/etc/hosts'], '127.0.0.1 api.github.com\n');
  const fontconfig = path.join(process.env.HOME ?? '/root', '.config', 'fontconfig', 'fonts.conf');
  fs.mkdirSync(path.dirname(fontconfig), { recursive: true });
  const alias = (family) => `  <alias><family>${family}</family><prefer><family>Inter</family></prefer></alias>`;
  fs.writeFileSync(fontconfig, `<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "fonts.dtd">\n<fontconfig>\n${alias('sans-serif')}\n${alias('system-ui')}\n</fontconfig>\n`);
}

/**
 * The user data folder: the settings, and in the storage of the extension the ID of this computer, the Docker host of
 * the seed (as "Use a Remote Docker Host…" writes it) and the mark that Devspaces was used before, so that the view
 * restores the demo devspace from its volume labels.
 */
function userDataFolder(seed) {
  const folder = path.join(OUT, 'user-data');
  const storage = path.join(folder, 'User', 'globalStorage', EXTENSION_ID);
  fs.mkdirSync(storage, { recursive: true });
  fs.writeFileSync(path.join(folder, 'User', 'settings.json'), JSON.stringify(SETTINGS, null, 2));
  fs.writeFileSync(path.join(storage, 'computer.id'), seed.computerId);
  fs.writeFileSync(path.join(storage, 'remote-docker.json'), JSON.stringify({ dockerHost: seed.remoteHost, remoteHosts: [seed.remoteHost] }));
  fs.writeFileSync(path.join(storage, 'used'), '');
  return folder;
}

/** Starts the test VS Code (prepare.ts downloaded it) with the extensions that install-attach-extensions.mjs installed. */
async function startVscode(userData, account, ca) {
  process.chdir(ROOT);
  const { downloadAndUnzipVSCode } = await import('@vscode/test-electron');
  const executable = await downloadAndUnzipVSCode(process.env.VSCODE_TEST_VERSION || 'stable');
  const args = [
    `--user-data-dir=${userData}`,
    `--extensions-dir=${path.join(ROOT, '.vscode-test', 'extensions')}`,
    '--disable-extension=vscode.github-authentication',
    `--remote-debugging-port=${PORT}`,
    '--no-sandbox',
    '--disable-gpu',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
    '--password-store=basic',
    '--disable-updates',
    '--new-window',
  ];
  const env = {
    ...process.env,
    DISPLAY: ':99',
    DEVSPACE_TEST_GITHUB_SIGNED_OUT: '1',
    DEVSPACE_TEST_GITHUB_ACCOUNT: JSON.stringify({ id: account.id, label: account.login }),
    NODE_EXTRA_CA_CERTS: ca,
  };
  const output = fs.openSync(path.join(OUT, 'vscode.log'), 'w');
  log(`${executable} ${args.join(' ')}`);
  return spawn(executable, args, { env, stdio: ['ignore', output, output] });
}

/** The workbench page of the window through the remote debugging port; it connects again after a reload. */
class Workbench {
  async connection() {
    if (this.cdp && this.cdp.socket.readyState === WebSocket.OPEN) return this.cdp;
    const page = (await targets(PORT)).find((target) => target.type === 'page' && target.url.includes('workbench'));
    if (!page) throw new Error('No workbench page.');
    this.cdp = await Cdp.connect(page.webSocketDebuggerUrl);
    return this.cdp;
  }

  async evaluate(fn, arg) {
    try {
      return await (await this.connection()).evaluate(fn, arg);
    } catch (error) {
      this.cdp?.close();
      this.cdp = undefined;
      throw error;
    }
  }

  /** The rectangle of `spec` on the screen (find), as soon as it is visible. */
  async find(spec, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    for (;;) {
      try {
        const rect = spec.webview ? await this.webviewRect(spec.webview) : await this.evaluate(locate, spec);
        if (rect) return rect;
      } catch (error) {
        last = error;
      }
      if (Date.now() > deadline) throw new Error(`Not found within ${timeoutMs / 1000} s: ${JSON.stringify(spec)}${last ? ` (${last.message})` : ''}`);
      await wait(200);
    }
  }

  /** The rectangle of the button with the text `text` in a webview of the window: its frame, its page and the button. */
  async webviewRect(text) {
    for (const target of (await targets(PORT)).filter((t) => t.type === 'iframe' && t.url.startsWith('vscode-webview://'))) {
      const id = new URL(target.url).searchParams.get('id');
      const frame = await Cdp.connect(target.webSocketDebuggerUrl);
      try {
        const inner = await frame.evaluate((wanted) => {
          const active = document.getElementById('active-frame');
          const button = [...(active?.contentDocument?.querySelectorAll('button') ?? [])].find((b) => b.textContent.trim() === wanted && b.getBoundingClientRect().width > 0);
          if (!active || !button) return undefined;
          const a = active.getBoundingClientRect();
          const b = button.getBoundingClientRect();
          return { x: a.x + b.x, y: a.y + b.y, width: b.width, height: b.height };
        }, text);
        if (!inner) continue;
        const outer = await this.evaluate((wanted) => {
          const element = [...document.querySelectorAll('iframe')].find((f) => {
            try {
              return new URL(f.src).searchParams.get('id') === wanted && f.getBoundingClientRect().width > 0;
            } catch {
              return false;
            }
          });
          const r = element?.getBoundingClientRect();
          return r ? { x: r.x, y: r.y, zoom: window.devicePixelRatio } : undefined;
        }, id);
        if (outer) return { x: (outer.x + inner.x) * outer.zoom, y: (outer.y + inner.y) * outer.zoom, width: inner.width * outer.zoom, height: inner.height * outer.zoom };
      } finally {
        frame.close();
      }
    }
    return undefined;
  }

  /** The texts of the rows of the side bar, for the log. */
  async rows() {
    return this.evaluate(() =>
      [...document.querySelectorAll('.part.sidebar .monaco-list-row')].map((row) => `${'  '.repeat(Number(row.getAttribute('aria-level') ?? 1) - 1)}${row.querySelector('.label-name')?.textContent ?? ''}  ${row.querySelector('.label-description')?.textContent ?? ''}`),
    );
  }
}

/**
 * The rectangle on the screen of the element of `spec`, run in the workbench page, or undefined while it is not
 * visible. `spec`: `{ activity }` an item of the activity bar; `{ button }` a button of the window (a welcome view, a
 * dialog); `{ paneHeader, expanded }` the header of the pane with that index in the side bar, open or closed;
 * `{ row, pane, under, prefix, expanded }` a row of the side bar with that label (`prefix`: the label starts with it),
 * in the pane with that index, below the row `under`, open or closed; `{ rowAction, row, pane }` the action of a row;
 * `{ tab, preview }` an editor tab, in preview (italic) or not; `{ explorer }` a row of the Explorer; `{ text }` an
 * element of the editor area with that text.
 */
function locate(spec) {
  const zoom = window.devicePixelRatio;
  const screen = (element) => {
    const r = element?.getBoundingClientRect();
    if (!r || r.width === 0 || r.height === 0 || r.bottom > window.innerHeight || r.top < 0) return undefined;
    return { x: r.x * zoom, y: r.y * zoom, width: r.width * zoom, height: r.height * zoom };
  };
  const text = (element) => (element?.textContent ?? '').replace(/\u00a0/g, ' ').trim();
  if (spec.activity) return screen(document.querySelector(`.activitybar .action-item .action-label[aria-label^="${spec.activity}"]`));
  if (spec.button) return screen([...document.querySelectorAll('.monaco-button, .monaco-dialog-box button')].find((b) => text(b) === spec.button && b.getBoundingClientRect().width > 0));
  // The panes of the view container that the side bar shows: the side bar keeps the panes of the other containers hidden.
  const panes = [...document.querySelectorAll('.part.sidebar .pane')].filter((pane) => pane.getBoundingClientRect().height > 0);
  if (spec.paneHeader !== undefined) {
    const header = panes[spec.paneHeader]?.querySelector('.pane-header');
    if (spec.expanded !== undefined && header?.getAttribute('aria-expanded') !== String(spec.expanded)) return undefined;
    return screen(header);
  }
  if (spec.row !== undefined) {
    const rows = [...(panes[spec.pane ?? 0]?.querySelectorAll('.monaco-list-row') ?? [])];
    let start = 0;
    let end = rows.length;
    if (spec.under) {
      const parent = rows.findIndex((row) => text(row.querySelector('.label-name')) === spec.under);
      if (parent < 0) return undefined;
      const level = Number(rows[parent].getAttribute('aria-level'));
      start = parent + 1;
      const next = rows.findIndex((row, index) => index >= start && Number(row.getAttribute('aria-level')) <= level);
      end = next < 0 ? rows.length : next;
    }
    const row = rows.slice(start, end).find((r) => {
      const label = text(r.querySelector('.label-name'));
      return spec.prefix ? label.startsWith(spec.row) : label === spec.row;
    });
    if (!row) return undefined;
    if (spec.expanded !== undefined && row.getAttribute('aria-expanded') !== String(spec.expanded)) return undefined;
    if (spec.rowAction) return screen(row.querySelector(`.actions .action-label[aria-label^="${spec.rowAction}"]`));
    return screen(row.querySelector('.label-name') ?? row);
  }
  if (spec.tab) {
    const tab = [...document.querySelectorAll('.part.editor .tab')].find((t) => text(t.querySelector('.label-name')) === spec.tab);
    if (!tab) return undefined;
    // VS Code writes the title of a preview tab in italics: the class italic of its label.
    if (spec.preview !== undefined && (tab.querySelector('.tab-label.italic') !== null) !== spec.preview) return undefined;
    if (spec.ready && ![...document.querySelectorAll('iframe.webview.ready')].some((f) => f.getBoundingClientRect().width > 0)) return undefined;
    return screen(tab);
  }
  if (spec.explorer) return screen([...document.querySelectorAll('.explorer-folders-view .monaco-list-row .label-name')].find((l) => text(l) === spec.explorer));
  if (spec.text) return screen([...document.querySelectorAll('.part.editor .view-line')].find((l) => text(l).includes(spec.text)));
  return undefined;
}

/**
 * Before the take: the window is placed and ready, the view container of Devspaces is known, and the side bar is wider
 * than its default, so that the rows show their descriptions. The Explorer stays the view of the side bar.
 */
async function setUp(ui) {
  await placeWindow();
  await ui.find({ activity: 'Devspaces' }, 120_000);
  await wait(3000);
  await click(await ui.find({ activity: 'Explorer' }), { ms: 1 });
  await widenSideBar(ui);
}

/**
 * The drag of the edge of the side bar makes it 560 pixels wide. The window of the devspace (another workspace) starts
 * with the default width again.
 */
async function widenSideBar(ui) {
  const edge = await ui.evaluate(() => {
    const r = document.querySelector('.part.sidebar').getBoundingClientRect();
    return { x: r.right * window.devicePixelRatio, y: (r.top + r.height / 2) * window.devicePixelRatio };
  });
  jump(edge.x + 2, edge.y);
  xdo('mousedown', 1);
  await move(560, edge.y, 300);
  xdo('mouseup', 1);
  jump(SCREEN.width - 40, SCREEN.height - 20);
  await wait(1000);
}

/** The view container `title` in the side bar: a click on its item of the activity bar, unless it shows already. */
async function showContainer(ui, title) {
  const shown = await ui.evaluate(() => document.querySelector('.part.sidebar .title-label h2')?.textContent?.trim() ?? '');
  if (shown.toLowerCase() !== title.toLowerCase()) await click(await ui.find({ activity: title }));
}

/**
 * The row or pane header of `spec` (locate) open (`expanded` true) or closed: a click on it when it is not, and the wait
 * until it is. VS Code opens the groups of a host in the view Docker Hosts by itself.
 */
async function setExpanded(ui, spec, expanded, timeoutMs = 30_000) {
  const rect = await ui.find(spec, timeoutMs);
  if (await ui.evaluate(locate, { ...spec, expanded })) return;
  await click(rect);
  await ui.find({ ...spec, expanded }, 10_000);
}

/** The palette command `title`, run with the keyboard (only where the take cuts it out). */
async function paletteCommand(title) {
  xdo('key', '--clearmodifiers', 'ctrl+shift+p');
  await wait(600);
  xdo('type', '--delay', 20, title);
  await wait(800);
  xdo('key', 'Return');
  await wait(600);
}

/**
 * Waits until the window of the devspace shows the files of the repository in the Explorer. A question of VS Code
 * whether the extension may sign in (only when the window of the devspace has no session) gets "Allow".
 */
async function openedDevspace(ui) {
  const deadline = Date.now() + OPEN_TIMEOUT_MS;
  let indicator = '';
  while (!(await ui.find({ explorer: 'index.html' }, 2_000).catch(() => undefined))) {
    if (Date.now() > deadline) throw new Error(`The window of the devspace did not open within ${OPEN_TIMEOUT_MS / 60_000} minutes (remote indicator "${indicator}").`);
    const allow = await ui.find({ button: 'Allow' }, 1_000).catch(() => undefined);
    if (allow) {
      log('The window of the devspace asked for the sign-in: Allow.');
      await click(allow, { ms: 200 });
    }
    // Connected, but the side bar shows another view than the Explorer: the Explorer shows the files.
    const now = await ui.evaluate(() => document.querySelector('.statusbar-item.remote-kind')?.textContent?.trim() ?? '').catch(() => '');
    if (now !== indicator) log(`Remote indicator: "${now}"`);
    indicator = now;
    if (indicator !== '' && !/opening|connecting|reconnecting|open a remote/i.test(indicator) && !(await ui.evaluate(() => !!document.querySelector('.explorer-folders-view')).catch(() => true))) {
      await click(await ui.find({ activity: 'Explorer' }), { ms: 200 });
    }
  }
}

/** The take: returns the marks of its scenes and of its cut, in ms since the start of the recording. */
async function take(ui, video) {
  const recording = record(video);
  const scenes = [];
  const cuts = [];
  const shots = [];
  const scene = (n) => {
    scenes.push({ n, at: Date.now() - recording.started });
    log(`Scene ${n}`);
  };
  const shot = async (name) => {
    const file = path.join(OUT, `scene-${name}.png`);
    screenshot(file);
    shots.push(file);
    log(`Rows: ${JSON.stringify(await ui.rows().catch(() => []))}`);
  };
  try {
    await wait(500);
    // 1: the sign-in.
    scene(1);
    await wait(2000);
    await click(await ui.find({ activity: 'Devspaces' }));
    await wait(1200);
    await click(await ui.find({ button: 'Sign in with GitHub' }, 60_000));
    const allow = await ui.find({ button: 'Allow' }, 5_000).catch(() => undefined);
    if (allow) await click(allow, { ms: 400 });
    await ui.find({ row: 'web-basics', pane: 0 }, 60_000);
    await move(SCREEN.width - 40, SCREEN.height - 20, 600);
    await wait(2500);
    await shot('1');
    // 2: the start; the wait for the window of the devspace is cut out.
    scene(2);
    await click(await ui.find({ row: 'web-basics', pane: 0 }), { count: 2 });
    await move(SCREEN.width - 40, SCREEN.height - 20, 600);
    await wait(3500);
    const cut = { from: Date.now() - recording.started };
    await shot('2-opening');
    await openedDevspace(ui);
    await wait(4000);
    await widenSideBar(ui);
    await paletteCommand('Notifications: Clear All Notifications');
    await wait(1000);
    cuts.push({ ...cut, to: Date.now() - recording.started });
    await wait(2500);
    await shot('2');
    // 3: the view Docker Hosts with the objects of the host; the pane of the repositories and the images close.
    scene(3);
    await showContainer(ui, 'Devspaces');
    await wait(1200);
    await setExpanded(ui, { paneHeader: 0 }, false);
    await wait(800);
    await setExpanded(ui, { row: 'school-server', pane: 1 }, true);
    await ui.find({ row: 'Containers', pane: 1, expanded: true }, 60_000);
    await wait(1500);
    await setExpanded(ui, { row: 'Images', pane: 1 }, false);
    await ui.find({ row: 'Volumes', pane: 1, expanded: true });
    await move(SCREEN.width - 40, SCREEN.height - 20, 600);
    await wait(2500);
    await shot('3');
    // 4: the report of the volume of the VS Code Server and of the devspace container, which a double-click keeps.
    scene(4);
    await click(await ui.find({ row: 'devspaces-vscode', pane: 1, under: 'Volumes' }));
    await ui.find({ tab: 'devspaces-vscode', preview: true, ready: true }, 60_000);
    await wait(3500);
    const devspace = { row: 'devspaces-demo-school-web-basics', prefix: true, pane: 1, under: 'Containers' };
    await click(await ui.find(devspace));
    await ui.find({ tab: (await ui.evaluate(locateLabel, devspace)) ?? '', preview: true, ready: true }, 60_000);
    await wait(3000);
    await click(await ui.find(devspace), { count: 2 });
    await wait(3000);
    await shot('4');
    // 5: the report and the log of the Monitor.
    scene(5);
    await click(await ui.find({ row: 'devspaces-monitor', pane: 1, under: 'Containers' }));
    await ui.find({ tab: 'devspaces-monitor', ready: true }, 60_000);
    await wait(3500);
    await click(await ui.find({ webview: 'Show Log of the Monitor' }, 30_000));
    await move(SCREEN.width - 40, SCREEN.height - 20, 600);
    await wait(3500);
    await shot('5');
    // 6: the utilization page of the host.
    scene(6);
    const host = await ui.find({ row: 'school-server', pane: 1 });
    await move(host.x + host.width / 2, host.y + host.height / 2, 500);
    await click(await ui.find({ row: 'school-server', pane: 1, rowAction: 'Show Utilization' }), { ms: 300 });
    await move(SCREEN.width - 40, SCREEN.height - 20, 600);
    await wait(6500);
    await shot('6');
  } finally {
    await recording.stop();
  }
  return { scenes, cuts, shots };
}

/** The label of the row of `spec` (locate), run in the workbench page. */
function locateLabel(spec) {
  const panes = [...document.querySelectorAll('.part.sidebar .pane')].filter((pane) => pane.getBoundingClientRect().height > 0);
  const labels = [...(panes[spec.pane ?? 0]?.querySelectorAll('.monaco-list-row .label-name') ?? [])].map((l) => l.textContent.trim());
  return labels.find((label) => (spec.prefix ? label.startsWith(spec.row) : label === spec.row));
}

async function main() {
  if (process.env.CI !== 'true') throw new Error('The README GIF changes /etc/hosts and the certificates of this computer. It runs only on CI (CI=true).');
  const seed = JSON.parse(fs.readFileSync(path.join(ROOT, 'out', 'test', 'vscode', 'attach', 'seed.json'), 'utf8')).gif;
  if (!seed) throw new Error('out/test/vscode/attach/seed.json has no seed "gif" (DEVSPACE_TEST_ATTACH_PREPARE=gif).');
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const account = { id: seed.accountId, login: 'demo-student', name: 'Demo Student' };
  const owner = seed.repository.split('/')[0];
  const demo = {
    account,
    organizations: [owner],
    repositories: [
      { nameWithOwner: seed.repository },
      { nameWithOwner: `${owner}/css-layouts` },
      { nameWithOwner: `${owner}/javascript-intro` },
      { nameWithOwner: `${account.login}/portfolio`, permission: 'ADMIN' },
    ],
  };
  const certs = makeCertificates(path.join(OUT, 'certs'));
  prepareComputer(certs);
  const githubLog = path.join(OUT, 'github.log');
  const server = await startFakeGitHub({ port: 443, key: certs.key, cert: certs.cert, demo, log: (line) => fs.appendFileSync(githubLog, `${new Date().toISOString()} ${line}\n`) });
  const xvfb = await startXvfb();
  const vscode = await startVscode(userDataFolder(seed), account, certs.ca);
  const ui = new Workbench();
  try {
    await setUp(ui);
    const video = path.join(OUT, 'take.mkv');
    const marks = await take(ui, video);
    fs.writeFileSync(`${video}.marks.json`, JSON.stringify(marks, null, 1));
    const gif = writeGif(video, marks, CAPTIONS, GIF);
    log(`${gif.file}: ${(gif.bytes / 1e6).toFixed(1)} MB, ${gif.seconds.toFixed(1)} s (the take ${gif.takeSeconds.toFixed(1)} s).`);
  } catch (error) {
    screenshot(path.join(OUT, 'failure.png'));
    log(`Rows at the failure: ${JSON.stringify(await ui.rows().catch(() => []))}`);
    throw error;
  } finally {
    vscode.kill();
    xvfb.kill();
    server.close();
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
