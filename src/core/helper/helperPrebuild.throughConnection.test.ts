// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The work in the background on the helper image of an SSH host never logs in to the host (docs/requirements.md
// R-ENG-002): the prebuild waits for the connection of the relay of this window to the host (HelperPrebuildDeps
// .connection), asks nothing before it, and runs as an operation without a login; the build of a missing image that a
// refresh asks for runs only while that connection is open (dockerEngineAnswers with `connected`). The maintenance that
// changes the engine (the rebuild that a check asked for) is put off while it may not change the engine
// (mayChangeEngine: on an SSH host, before that connection). A rebuild of the existing tag reports `refresh`, so that
// the open connection stays usable for new workers.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_DOCKER_TARGET, remoteDockerTarget } from '../docker/dockerHost';
import { operationDockerTarget, operationWithoutLogin } from '../docker/dockerTargets';
import { abortError, type Logger } from '../ports';
import { HELPER_PREBUILD_TIMEOUT_MS, HelperPrebuild, dockerEngineAnswers, type HelperPrebuildDeps } from './helperPrebuild';
import { ensureHelperImageUse, helperImageTag } from './helperImage';
import { HelperImages, helperStatePathFor, type HelperImageDocker } from './helperImages';
import { readHelperState, type HelperState } from './helperState';

const DOCKERFILE = 'FROM node:22-bookworm-slim\n';
const TAG = helperImageTag(DOCKERFILE);
const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const OLD = '2026-09-01T12:00:00.000Z';
const TODAY = '2026-10-09T06:00:00.000Z';
const ID1 = `sha256:${'1'.repeat(64)}`;
const ID2 = `sha256:${'2'.repeat(64)}`;
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const SSH_HOST = remoteDockerTarget('build-box');
/** The record of a tag whose check (of today) asked for a rebuild. */
const REBUILD_ASKED = { baseImage: 'node:22-bookworm-slim', baseDigest: DIGEST_A, latestBaseDigest: DIGEST_B, builtAt: OLD, checkedAt: TODAY, lastUsedAt: TODAY };

type BuildOptions = Parameters<HelperImageDocker['buildImage']>[0];

/** A Docker engine with the tags of its images; each call records whether it ran without a login. */
class FakeDocker implements HelperImageDocker {
  readonly tags = new Map<string, string>();
  readonly builds: BuildOptions[] = [];
  /** For each call: its name, and whether it ran in the work without a login. */
  readonly calls: Array<{ call: string; withoutLogin: boolean }> = [];
  buildHandler: (options: BuildOptions) => Promise<void> = async () => undefined;
  nextId = ID2;

  private record(call: string): void {
    this.calls.push({ call, withoutLogin: operationWithoutLogin() !== undefined });
  }

  async imageExists(reference: string): Promise<boolean> {
    this.record('imageExists');
    return this.tags.has(reference);
  }

  async imageId(reference: string): Promise<string | undefined> {
    this.record('imageId');
    return this.tags.get(reference);
  }

  async buildImage(options: BuildOptions): Promise<string | undefined> {
    this.record('build');
    this.builds.push(options);
    await this.buildHandler(options);
    this.tags.set(options.tag, this.nextId);
    return this.nextId;
  }
}

class RecordingLogger implements Logger {
  readonly lines: string[] = [];
  info(message: string): void {
    this.lines.push(`info ${message}`);
  }
  warn(message: string): void {
    this.lines.push(`warn ${message}`);
  }
  error(message: string): void {
    this.lines.push(`error ${message}`);
  }
  output(): void {}
}

let dir: string;
let docker: FakeDocker;
let logger: RecordingLogger;

const statePath = (): string => path.join(dir, 'storage', 'helper.json');

function writeState(state: Omit<HelperState, 'version'>, engineKey = ''): void {
  const file = helperStatePathFor(statePath(), engineKey);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, ...state }));
}

/** The helper image of a window: the engine of the operation, the state file and the clock of these tests. */
function images(overrides: Partial<ConstructorParameters<typeof HelperImages>[0]> = {}): HelperImages {
  return new HelperImages({
    docker,
    logger,
    dockerfilePath: path.join(dir, 'Dockerfile'),
    clock: { now: () => NOW },
    statePath: statePath(),
    engine: async () => ({ key: operationDockerTarget()?.host ?? '' }),
    ...overrides,
  });
}

/** A connection of the window that the test opens with `open`. */
function connectionOf(): { connection: HelperPrebuildDeps['connection']; open: () => void; waits: string[] } {
  const waits: string[] = [];
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  const connection = vi.fn((host: string, signal: AbortSignal) => {
    waits.push(host);
    return new Promise<void>((resolve, reject) => {
      // As HostPipes.whenDockerHost: a signal that aborted already rejects at once (a stop during the first check of
      // the prebuild, on a slow machine).
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      signal.addEventListener('abort', () => reject(abortError()), { once: true });
      void opened.then(resolve);
    });
  });
  return { connection, open: () => open(), waits };
}

function prebuild(helper: HelperImages, overrides: Partial<HelperPrebuildDeps> = {}): HelperPrebuild {
  return new HelperPrebuild({
    helper,
    dockerRunning: vi.fn(async () => true),
    dockerfilePath: path.join(dir, 'Dockerfile'),
    statePath: statePath(),
    checkBaseImage: () => true,
    logger,
    ...overrides,
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-relay-only-'));
  fs.writeFileSync(path.join(dir, 'Dockerfile'), DOCKERFILE);
  docker = new FakeDocker();
  logger = new RecordingLogger();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('ensureHelperImageUse: mayChangeEngine', () => {
  it('puts off the rebuild that a check asked for while the engine may not be changed, and runs it when it may', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: REBUILD_ASKED } });
    const dockerfile = path.join(dir, 'Dockerfile');
    let may = false;
    const options = { statePath: statePath(), clock: { now: () => NOW }, logger, mayChangeEngine: () => may };
    const use = await ensureHelperImageUse(docker, dockerfile, options);
    expect(use).toEqual({ tag: TAG, id: ID1 });
    expect(docker.builds).toEqual([]);
    expect(docker.calls.map((c) => c.call)).toEqual(['imageId']);
    const state = await readHelperState(statePath());
    expect(state.images[TAG]?.latestBaseDigest).toBe(DIGEST_B);
    expect(logger.lines).toContain(`info The workspace helper image ${TAG} is built again later, through the connection of this window to the Docker host. The existing image is used.`);
    may = true;
    const rebuilt = await ensureHelperImageUse(docker, dockerfile, options);
    expect(rebuilt).toEqual({ tag: TAG, id: ID2 });
    expect(docker.builds.map((b) => [b.pull, b.noCache])).toEqual([[true, true]]);
    expect((await readHelperState(statePath())).images[TAG]?.latestBaseDigest).toBeUndefined();
  });
});

describe('HelperImages.onImageBuilt names the kind of the build', () => {
  it('create for a missing tag, refresh for a rebuild of the existing tag', async () => {
    const built: string[] = [];
    const helper = images({ onImageBuilt: (kind) => built.push(kind) });
    await helper.prebuildImage({ signal: new AbortController().signal, checkBaseImage: true });
    expect(built).toEqual(['create']);
    writeState({ images: { [TAG]: REBUILD_ASKED } });
    const again = images({ onImageBuilt: (kind) => built.push(kind) });
    await again.prebuildImage({ signal: new AbortController().signal, checkBaseImage: true });
    expect(built).toEqual(['create', 'refresh']);
  });
});

describe('HelperPrebuild on an SSH host: only through the connection of this window', () => {
  it('does not wait and asks nothing when it is not due', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: { checkedAt: TODAY, lastUsedAt: TODAY } } }, 'build-box');
    const { connection, waits } = connectionOf();
    const dockerRunning = vi.fn(async () => true);
    expect(await prebuild(images(), { connection, dockerRunning }).start(SSH_HOST)).toBe('notDue');
    expect(waits).toEqual([]);
    expect(dockerRunning).not.toHaveBeenCalled();
    expect(docker.calls).toEqual([]);
  });

  it('waits for the connection when it is due, asks nothing before it, and then runs the rebuild without a login of its own', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: REBUILD_ASKED } }, 'build-box');
    const { connection, open, waits } = connectionOf();
    const dockerRunning = vi.fn(async () => true);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let run: Promise<string>;
    try {
      run = prebuild(images(), { connection, dockerRunning }).start(SSH_HOST);
      await vi.waitFor(() => expect(waits).toEqual(['build-box']));
      // Longer than the time limit of the work: the limit starts after the wait.
      await vi.advanceTimersByTimeAsync(2 * HELPER_PREBUILD_TIMEOUT_MS);
      expect(docker.calls).toEqual([]);
      open();
      expect(await run).toBe('present');
    } finally {
      vi.useRealTimers();
    }
    expect(dockerRunning).not.toHaveBeenCalled();
    expect(docker.builds).toHaveLength(1);
    expect(docker.calls.length).toBeGreaterThan(0);
    expect(docker.calls.every((c) => c.withoutLogin)).toBe(true);
    expect(logger.lines).toContain('info The workspace helper image on build-box is prepared in the background through the connection of this window to the host, when that connection is open.');
  });

  it('runs the rebuild that an open of the same window put off before the connection, without its cached result', async () => {
    docker.tags.set(TAG, ID1);
    writeState({ images: { [TAG]: REBUILD_ASKED } }, 'build-box');
    let connected = false;
    const helper = images({ mayChangeEngine: () => connected });
    const { connection, open } = connectionOf();
    const run = prebuild(helper, { connection }).start(SSH_HOST);
    // The open of the window, before its connection: the existing image, no rebuild.
    const { runWithDockerTarget } = await import('../docker/dockerTargets');
    expect(await runWithDockerTarget(SSH_HOST, () => helper.ensureImageUse({ signal: new AbortController().signal }))).toEqual({ tag: TAG, id: ID1 });
    expect(docker.builds).toEqual([]);
    // Its connection opens: the prebuild rebuilds through it.
    connected = true;
    open();
    expect(await run).toBe('present');
    expect(docker.builds.map((b) => [b.pull, b.noCache])).toEqual([[true, true]]);
    expect(docker.tags.get(TAG)).toBe(ID2);
  });

  it('is cancelled while it waits by a removal of Devspaces from the host, and by dispose', async () => {
    writeState({ images: { [TAG]: REBUILD_ASKED } }, 'build-box');
    const stopped = prebuild(images(), { connection: connectionOf().connection });
    const run = stopped.start(SSH_HOST);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await stopped.stop(SSH_HOST);
    expect(await run).toBe('cancelled');
    const disposed = prebuild(images(), { connection: connectionOf().connection });
    const second = disposed.start(SSH_HOST);
    await new Promise((resolve) => setTimeout(resolve, 5));
    disposed.dispose();
    expect(await second).toBe('cancelled');
    expect(docker.calls).toEqual([]);
  });

  it('stops when the connection ended during its work (a refused call), and an open that joined its build builds for itself', async () => {
    writeState({ images: {} }, 'build-box');
    const { connection, open } = connectionOf();
    open();
    let refusals = 0;
    // The tag is missing (another program removed it): the build of the prebuild is refused, as BootstrapDocker
    // refuses a call that would log in, once the connection ended.
    docker.buildHandler = async () => {
      const withoutLogin = operationWithoutLogin();
      if (withoutLogin === undefined) return;
      refusals++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      withoutLogin.abort(abortError());
      throw abortError();
    };
    const helper = images();
    const background = prebuild(helper, { connection });
    const run = background.start(SSH_HOST);
    while (docker.builds.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    // An open in the same window joins the build of the prebuild.
    const { runWithDockerTarget } = await import('../docker/dockerTargets');
    const joined = runWithDockerTarget(SSH_HOST, () => helper.ensureImageUse({ signal: new AbortController().signal }));
    expect(await run).toBe('connectionEnded');
    expect(await joined).toEqual({ tag: TAG, id: ID2 });
    expect(refusals).toBe(1);
    expect(docker.builds).toHaveLength(2);
    expect(docker.calls.filter((c) => c.call === 'build').map((c) => c.withoutLogin)).toEqual([true, false]);
    expect(logger.lines.join('\n')).toContain('The background preparation of the workspace helper image on build-box stopped: the connection of this window to the host ended');
  });

  it('runs as before on the local Docker, also with the dependency of the connection', async () => {
    const { connection, waits } = connectionOf();
    const dockerRunning = vi.fn(async () => true);
    expect(await prebuild(images(), { connection, dockerRunning }).start(LOCAL_DOCKER_TARGET)).toBe('built');
    expect(waits).toEqual([]);
    expect(dockerRunning).toHaveBeenCalledTimes(1);
    expect(docker.calls.every((c) => !c.withoutLogin)).toBe(true);
  });
});

// A switch to another Docker host starts the prebuild there (src/vscode/extension.ts, prebuildAfterSwitch): one prebuild
// per host in a window, each with its own stop.
describe('HelperPrebuild once per Docker host', () => {
  const VM_HOST = remoteDockerTarget('lima:devspaces');

  it('runs on a second host while the first one waits for its connection, and a second start of a host returns its first run', async () => {
    writeState({ images: {} }, 'build-box');
    const { connection, waits } = connectionOf();
    const dockerRunning = vi.fn(async () => true);
    const background = prebuild(images(), { connection, dockerRunning });
    const first = background.start(SSH_HOST);
    await vi.waitFor(() => expect(waits).toEqual(['build-box']));
    // The setup of the VM, a switch to it: its prebuild runs at once, without the connection of an SSH host.
    const second = background.start(VM_HOST);
    expect(await second).toBe('built');
    expect(dockerRunning).toHaveBeenCalledTimes(1);
    expect(docker.builds).toHaveLength(1);
    expect(background.start(VM_HOST)).toBe(second);
    expect(background.start(SSH_HOST)).toBe(first);
    expect(dockerRunning).toHaveBeenCalledTimes(1);
    expect(logger.lines).toContain('info The workspace helper image is built in the background.');
    // The removal of Devspaces from the first host stops only its prebuild; dispose ends the rest.
    await background.stop(SSH_HOST);
    expect(await first).toBe('cancelled');
    expect(waits).toEqual(['build-box']);
  });

  it('starts again on a host where the first start found Docker not running (the VM of Devspaces before its setup)', async () => {
    let running = false;
    const dockerRunning = vi.fn(async () => running);
    const background = prebuild(images(), { dockerRunning });
    const first = background.start(VM_HOST);
    expect(await first).toBe('dockerNotRunning');
    expect(docker.builds).toHaveLength(0);
    // The setup of the VM, then the switch to it.
    running = true;
    const second = background.start(VM_HOST);
    expect(second).not.toBe(first);
    expect(await second).toBe('built');
    expect(docker.builds).toHaveLength(1);
    // A start while that run goes on, or after it built, returns that run.
    expect(background.start(VM_HOST)).toBe(second);
    expect(dockerRunning).toHaveBeenCalledTimes(2);
  });

  it('stops only the prebuild of the host of a removal, and dispose stops every one', async () => {
    writeState({ images: { [TAG]: REBUILD_ASKED } }, 'build-box');
    const other = remoteDockerTarget('other-box');
    writeState({ images: { [TAG]: REBUILD_ASKED } }, 'other-box');
    const { connection, waits } = connectionOf();
    const background = prebuild(images(), { connection });
    const first = background.start(SSH_HOST);
    const second = background.start(other);
    // Both read their state files at the same time, so either one may wait first.
    await vi.waitFor(() => expect([...waits].sort()).toEqual(['build-box', 'other-box']));
    await background.stop(other);
    expect(await second).toBe('cancelled');
    let firstEnded = false;
    void first.then(() => (firstEnded = true));
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(firstEnded).toBe(false);
    background.dispose();
    expect(await first).toBe('cancelled');
    expect(docker.calls).toEqual([]);
  });
});

describe('dockerEngineAnswers with `connected` (the build of a missing image that a refresh asks for)', () => {
  const deps = (connected: boolean, daemonStatus = vi.fn(async () => ({ running: true }))) => ({
    daemonStatus,
    ssh: { runner: { run: vi.fn() }, env: {}, sshPath: '/usr/bin/ssh' } as never,
    connected: vi.fn(() => connected),
    logger,
  });

  it('answers for an SSH host exactly when the connection of this window is open, without ssh and without docker info', async () => {
    const open = deps(true);
    expect(await dockerEngineAnswers(SSH_HOST, open, new AbortController().signal)).toBe(true);
    expect(open.daemonStatus).not.toHaveBeenCalled();
    const closed = deps(false);
    expect(await dockerEngineAnswers(SSH_HOST, closed, new AbortController().signal)).toBe(false);
    expect(closed.daemonStatus).not.toHaveBeenCalled();
    expect((closed.ssh as unknown as { runner: { run: ReturnType<typeof vi.fn> } }).runner.run).not.toHaveBeenCalled();
    expect(logger.lines).toContain('info The work in the background does not reach build-box now: it uses only the connection of this window to the host, and that connection is not open.');
  });

  it('asks the local Docker with docker info as before', async () => {
    const local = deps(false);
    expect(await dockerEngineAnswers(LOCAL_DOCKER_TARGET, local, new AbortController().signal)).toBe(true);
    expect(local.daemonStatus).toHaveBeenCalledTimes(1);
    expect(local.connected).not.toHaveBeenCalled();
  });
});
