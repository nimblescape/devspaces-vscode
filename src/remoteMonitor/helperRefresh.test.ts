// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The part "the workspace helper image" of the background run of the Monitor (docs/requirements.md R-DS-003).
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEVCONTAINER_CLI_VERSION, helperImageTag } from '../core/helper/helperImageBuild';
import type { HttpRequest, HttpResponse, HttpTransport } from '../core/http';
import type { ProcessRunner, RunOptions, RunResult } from '../core/ports';
import { engineHelperRecordText, parseEngineHelperRecordText, type EngineHelperRecord } from '../core/remoteMonitor/helperCheck';
import { BackgroundRun } from './background';
import { cliHelperBuild, ownHelperImage, refreshHelperImage, type HelperBuild, type HelperRefreshDeps } from './helperRefresh';

const BASE = 'ghcr.io/acme/base:1';
const DOCKERFILE = `ARG BASE_IMAGE=${BASE}\nFROM \${BASE_IMAGE}\nCOPY Dockerfile /usr/local/share/devspaces/helper/Dockerfile\n`;
const TAG = helperImageTag(DOCKERFILE);
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const IMAGE_ID = `sha256:${'1'.repeat(64)}`;
const NOW = Date.parse('2026-11-04T06:07:00Z');
const LABEL = 'nimblescape.devspaces.worker-base-digest';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function dockerfile(content = DOCKERFILE): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devspaces-helper-refresh-'));
  dirs.push(dir);
  const file = path.join(dir, 'Dockerfile');
  fs.writeFileSync(file, content);
  return file;
}

/** The registry of BASE: its manifest has `digest`; `unreachable` refuses the connection. */
function registry(answer: string | 'unreachable'): { transport: () => HttpTransport; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const transport: HttpTransport = {
    request: async (request): Promise<HttpResponse> => {
      requests.push(request);
      if (answer === 'unreachable') throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      if (request.url === 'https://ghcr.io/v2/acme/base/manifests/1') return { status: 200, headers: { 'docker-content-digest': answer }, body: '' };
      return { status: 404, headers: {}, body: '' };
    },
  };
  return { transport: () => transport, requests };
}

interface Setup {
  deps: HelperRefreshDeps;
  log: string[];
  builds: HelperBuild[];
  inspects: string[];
  written: () => EngineHelperRecord | undefined;
  requests: HttpRequest[];
}

function setup(options: {
  label?: string;
  image?: boolean;
  registry?: string | 'unreachable';
  stored?: EngineHelperRecord;
  build?: (build: HelperBuild, signal: AbortSignal) => Promise<void>;
  file?: string;
}): Setup {
  const log: string[] = [];
  const builds: HelperBuild[] = [];
  const inspects: string[] = [];
  let record: string | undefined = options.stored === undefined ? undefined : engineHelperRecordText(options.stored);
  let now = NOW;
  const fake = registry(options.registry ?? DIGEST_A);
  const deps: HelperRefreshDeps = {
    log: (message) => log.push(message),
    // Each read of the clock is a minute later (the build takes its time).
    now: () => (now += 60_000) - 60_000,
    engine: {
      inspect: async (kind, reference) => {
        inspects.push(`${kind} ${reference}`);
        if (options.image === false) return undefined;
        return { Id: IMAGE_ID, Config: { Labels: { 'nimblescape.devspaces.worker': 'true', ...(options.label !== undefined ? { [LABEL]: options.label } : {}) } } };
      },
    },
    registryTransport: fake.transport,
    record: { read: async () => record, write: async (text) => void (record = text) },
    dockerfile: options.file ?? dockerfile(),
    build: async (build, signal) => {
      builds.push(build);
      await options.build?.(build, signal);
    },
  };
  return { deps, log, builds, inspects, written: () => (record === undefined ? undefined : parseEngineHelperRecordText(record)), requests: fake.requests };
}

const iso = (offsetMinutes: number): string => new Date(NOW + offsetMinutes * 60_000).toISOString();

describe('the part "the workspace helper image" of the background run', () => {
  it('records the check when the label of the image names the current digest, and builds nothing', async () => {
    const s = setup({ label: DIGEST_A });
    expect(await refreshHelperImage(s.deps)).toBe('reached');
    expect(s.inspects).toEqual([`image ${TAG}`]);
    expect(s.requests.map((request) => `${request.method} ${request.url}`)).toEqual(['HEAD https://ghcr.io/v2/acme/base/manifests/1']);
    expect(s.builds).toEqual([]);
    expect(s.written()).toEqual({ tag: TAG, baseImage: BASE, baseDigest: DIGEST_A, checkedAt: iso(0) });
    expect(s.log).toEqual([`The workspace helper image ${TAG} is built from the current base image ${BASE}.`]);
  });

  it('builds the tag again when the base image changed, and records the check at the end of the build', async () => {
    const s = setup({ label: DIGEST_A, registry: DIGEST_B, stored: { tag: TAG, baseImage: BASE, baseDigest: DIGEST_A, checkedAt: iso(-1440), attemptedAt: iso(-2880) } });
    expect(await refreshHelperImage(s.deps)).toBe('reached');
    expect(s.builds).toEqual([{ tag: TAG, dockerfile: s.deps.dockerfile, baseDigest: DIGEST_B }]);
    // The previous attempt stays in the record.
    expect(s.written()).toEqual({ tag: TAG, baseImage: BASE, baseDigest: DIGEST_B, checkedAt: iso(2), builtAt: iso(2), attemptedAt: iso(-2880) });
    expect(s.log).toEqual([
      `The base image ${BASE} of the workspace helper has changed. The image ${TAG} is built again.`,
      `The workspace helper image ${TAG} was built again from the current base image ${BASE} in 60 s.`,
    ]);
  });

  it('builds an image without the label of its base digest again (a build without --pull, or of an older version)', async () => {
    const s = setup({});
    expect(await refreshHelperImage(s.deps)).toBe('reached');
    expect(s.builds).toEqual([{ tag: TAG, dockerfile: s.deps.dockerfile, baseDigest: DIGEST_A }]);
    expect(s.log[0]).toBe(`The workspace helper image ${TAG} does not name the digest of its base image ${BASE}. It is built again from the current base image.`);
    expect(s.written()).toMatchObject({ baseDigest: DIGEST_A, builtAt: iso(2), checkedAt: iso(2) });
  });

  it('keeps the existing image and records only the attempt when the build fails, so the windows check it', async () => {
    const stored: EngineHelperRecord = { tag: TAG, baseImage: BASE, baseDigest: DIGEST_A, checkedAt: iso(-1440) };
    const s = setup({ label: DIGEST_A, registry: DIGEST_B, stored, build: async () => Promise.reject(new Error('E: Unable to fetch some archives')) });
    expect(await refreshHelperImage(s.deps)).toBe('reached');
    expect(s.written()).toEqual({ ...stored, attemptedAt: iso(0) });
    expect(s.log[1]).toBe(`The workspace helper image ${TAG} could not be built again, so the existing image stays and the windows check it: E: Unable to fetch some archives`);
  });

  it('records only the attempt when the registry does not answer, and tells the run that it found no network', async () => {
    const s = setup({ label: DIGEST_A, registry: 'unreachable', stored: { tag: TAG, baseImage: BASE, baseDigest: DIGEST_A, checkedAt: iso(-1440) } });
    expect(await refreshHelperImage(s.deps)).toBe('offline');
    expect(s.builds).toEqual([]);
    expect(s.written()).toEqual({ tag: TAG, baseImage: BASE, baseDigest: DIGEST_A, checkedAt: iso(-1440), attemptedAt: iso(0) });
    expect(s.log.at(-1)).toMatch(new RegExp(`^The base image ${BASE} of the workspace helper could not be checked: its registry did not answer`));
  });

  it('starts a new record for another tag (a Monitor of another version wrote the old one)', async () => {
    const s = setup({ label: DIGEST_A, stored: { tag: 'devspaces-worker:0123456789ab', baseImage: BASE, baseDigest: DIGEST_B, checkedAt: iso(-60), attemptedAt: iso(-90) } });
    await refreshHelperImage(s.deps);
    expect(s.written()).toEqual({ tag: TAG, baseImage: BASE, baseDigest: DIGEST_A, checkedAt: iso(0) });
  });

  it('does nothing without the image of the tag on the engine, without its Dockerfile, or when the inspect fails', async () => {
    const missing = setup({ image: false });
    expect(await refreshHelperImage(missing.deps)).toBe('none');
    expect(missing.requests).toEqual([]);
    expect(missing.written()).toBeUndefined();
    expect(missing.log).toEqual([`The workspace helper image ${TAG} is not on this engine. A window builds it when it needs it.`]);

    const noFile = setup({ file: path.join(os.tmpdir(), 'devspaces-no-such-folder', 'Dockerfile') });
    expect(await refreshHelperImage(noFile.deps)).toBe('none');
    expect(noFile.inspects).toEqual([]);
    expect(noFile.log[0]).toMatch(/^The image of the Monitor holds no Dockerfile of the workspace helper at .*, so the background run leaves the helper image out\.$/);

    const failing = setup({});
    failing.deps.engine = { inspect: async () => Promise.reject(new Error('Cannot connect to the Docker daemon')) };
    expect(await refreshHelperImage(failing.deps)).toBe('none');
    expect(failing.log).toEqual([`The workspace helper image ${TAG} could not be read: Cannot connect to the Docker daemon`]);
    expect(failing.written()).toBeUndefined();
  });

  it('logs a record that cannot be written, and goes on', async () => {
    const s = setup({ label: DIGEST_A });
    s.deps.record.write = async () => Promise.reject(new Error('no space left on device'));
    expect(await refreshHelperImage(s.deps)).toBe('reached');
    expect(s.log.at(-1)).toBe('The check of the workspace helper image could not be recorded in the volume: no space left on device');
  });
});

describe('cliHelperBuild', () => {
  class FakeRunner implements Pick<ProcessRunner, 'run'> {
    readonly calls: Array<{ file: string; args: readonly string[]; options?: RunOptions; config?: boolean }> = [];
    result: RunResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false };
    async run(file: string, args: readonly string[], options?: RunOptions): Promise<RunResult> {
      // The configuration folder exists while the build runs.
      this.calls.push({ file, args, options, config: options?.env?.DOCKER_CONFIG !== undefined && fs.existsSync(options.env.DOCKER_CONFIG) });
      return this.result;
    }
  }

  it('runs docker build --pull --no-cache with the labels and the CLI version, from the folder of the Dockerfile', async () => {
    const runner = new FakeRunner();
    const signal = new AbortController().signal;
    await cliHelperBuild({ tag: TAG, dockerfile: '/usr/local/share/devspaces/helper/Dockerfile', baseDigest: DIGEST_A }, signal, runner as ProcessRunner);
    expect(runner.calls).toHaveLength(1);
    const call = runner.calls[0];
    expect(call.file).toBe('docker');
    expect(call.args).toEqual([
      'build', '--pull', '--no-cache', '--tag', TAG, '--file', '/usr/local/share/devspaces/helper/Dockerfile',
      '--label', 'nimblescape.devspaces.worker=true', '--label', `${LABEL}=${DIGEST_A}`,
      '--build-arg', `DEVCONTAINER_CLI_VERSION=${DEVCONTAINER_CLI_VERSION}`, '/usr/local/share/devspaces/helper',
    ]);
    // Only PATH, the socket and a configuration folder of its own, which is removed after the build.
    const env = call.options?.env ?? {};
    expect(Object.keys(env).sort()).toEqual(['DOCKER_CONFIG', 'DOCKER_HOST', 'HOME', 'PATH']);
    expect(env.DOCKER_HOST).toBe('unix:///var/run/docker.sock');
    expect(env.HOME).toBe(env.DOCKER_CONFIG);
    expect(call.config).toBe(true);
    expect(fs.existsSync(env.DOCKER_CONFIG!)).toBe(false);
    expect(call.options?.signal).toBe(signal);
  });

  it('rejects with the last lines of the output of a failed build', async () => {
    const runner = new FakeRunner();
    const lines = Array.from({ length: 8 }, (_, index) => `#${index} step ${index}`);
    runner.result = { exitCode: 1, stdout: '', stderr: `${lines.join('\n')}\n\nERROR: failed to solve\n`, timedOut: false };
    await expect(cliHelperBuild({ tag: TAG, dockerfile: '/x/Dockerfile', baseDigest: DIGEST_A }, new AbortController().signal, runner as ProcessRunner)).rejects.toThrow(
      '#4 step 4 | #5 step 5 | #6 step 6 | #7 step 7 | ERROR: failed to solve',
    );
    runner.result = { exitCode: 2, stdout: '', stderr: '', timedOut: false };
    await expect(cliHelperBuild({ tag: TAG, dockerfile: '/x/Dockerfile', baseDigest: DIGEST_A }, new AbortController().signal, runner as ProcessRunner)).rejects.toThrow(
      'docker build ended with the exit code 2.',
    );
  });
});

describe('the background run with the part of the helper image', () => {
  it('runs it right after the images, and a helper part that found the network counts for the run', async () => {
    const order: string[] = [];
    const state = { read: async () => ({}), update: async () => undefined };
    const run = new BackgroundRun({
      log: (message) => order.push(message),
      now: () => NOW,
      images: async () => (order.push('images'), 'offline'),
      helperImage: async () => (order.push('helper image'), 'reached'),
      vscode: () => undefined,
      state,
      prepares: async () => void order.push('prepares'),
    });
    // The images found no network, but the registry of the helper image answered: the run reached the network.
    expect(await run.run()).toBe(true);
    expect(order.filter((line) => !line.startsWith('The background run') && !line.startsWith('The Monitor mounts'))).toEqual(['images', 'helper image', 'prepares']);
  });

  it('a helper part that failed is one line of the log, and the run goes on', async () => {
    const log: string[] = [];
    const run = new BackgroundRun({
      log: (message) => log.push(message),
      now: () => NOW,
      images: async () => 'none',
      helperImage: async () => Promise.reject(new Error('boom')),
      vscode: () => undefined,
      state: { read: async () => ({}), update: async () => undefined },
    });
    expect(await run.run()).toBe(true);
    expect(log).toContain('The background run could not do the workspace helper image: boom');
    expect(log.at(-1)).toBe('The background run ended.');
  });
});

// What the cleanup of the engine keeps of the Monitor's own helper image (engineCleanup.ts, R-DS-007).
describe('ownHelperImage', () => {
  it('gives the helper tag and the base image of the copy of the Dockerfile', async () => {
    expect(await ownHelperImage(dockerfile())).toEqual({ tag: TAG, baseImage: BASE });
  });

  it('gives no base image for a Dockerfile without one, and nothing without a Dockerfile', async () => {
    const content = 'FROM scratch AS x\n';
    expect((await ownHelperImage(dockerfile(content)))?.tag).toBe(helperImageTag(content));
    expect(await ownHelperImage(path.join(os.tmpdir(), 'devspaces-no-such-dir', 'Dockerfile'))).toBeUndefined();
  });
});
