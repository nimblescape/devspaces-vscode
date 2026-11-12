// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// readDevspaceStates, the refresh that runs in the worker.
import { describe, expect, it } from 'vitest';
import type { ContainerInfo, ListedContainer } from '../docker/dockerObjects';
import { LABEL_DEVSPACE_ID } from '../names';
import type { RunResult } from '../ports';
import type { DockerEngine, EngineExecOptions } from '../worker/dockerEngine';
import { scriptCommand } from '../worker/containerScripts';
import { EngineDocker } from '../worker/engineDocker';
import { BRANCH_EXEC_TIMEOUT_MS, BRANCH_READ_CONCURRENCY, readDevspaceStates, readRunningGitState, type StateDocker, type StateDevspace } from './refreshStates';
import { ENV_OPS, EXPECTED_STATES, REFRESH_DEVSPACES, fixtureContainerId, fixtureEngine } from './refreshStates.testkit';

/**
 * The Docker of the refresh is the worker's EngineDocker over the engine of the fixture (fixtureEngine, whose every
 * other method fails: unusedEngine). Records the options of each exec.
 */
function engineDocker(): { docker: EngineDocker; execs: Array<{ container: string; command: readonly string[]; options: EngineExecOptions }> } {
  const { engine } = fixtureEngine();
  const execs: Array<{ container: string; command: readonly string[]; options: EngineExecOptions }> = [];
  const recording: DockerEngine = {
    ...engine,
    exec: (container, command, options = {}) => {
      execs.push({ container, command, options });
      return engine.exec(container, command, options);
    },
  };
  return { docker: new EngineDocker(recording), execs };
}

describe('readDevspaceStates', () => {
  it('reads the states of the dev containers and volumes, and the Git state (branch, change counts) of the running ones that were asked for', async () => {
    expect(await readDevspaceStates(engineDocker().docker, REFRESH_DEVSPACES)).toEqual(EXPECTED_STATES);
  });

  it('only reads, and no exec has an input, a secret input or variables', async () => {
    const { docker, execs } = engineDocker();
    await readDevspaceStates(docker, REFRESH_DEVSPACES);
    // The refresh runs over the Engine API, whose fake answers only the reads of the refresh and exec (fixtureEngine
    // over unusedEngine: any other call fails the refresh), and each exec has no standard input, no secret input and no
    // variables (EngineExecOptions has no `env`).
    for (const { container, command, options } of execs) {
      expect(options.input).toBeUndefined();
      expect(options.secretInputName).toBeUndefined();
      expect(Object.keys(options).every((key) => ['user', 'timeoutMs', 'signal'].includes(key))).toBe(true);
      // The script `gitSummary` of the registry in the folder of the devspace (the script `branch` after it failed); the
      // exec names the dev container by its ID.
      const folder = REFRESH_DEVSPACES.find((env) => fixtureContainerId(env.containerName) === container)!.folder;
      expect([scriptCommand('gitSummary', [folder]), scriptCommand('branch', [folder])]).toContainEqual(command);
    }
    // No Git state of a devspace whose Git state was not asked for (another account).
    const containers = execs.map((exec) => exec.container);
    // The IDs of these dev containers: one read of the Git state each, and the branch alone after the failed read of
    // git-fails.
    expect([...containers].sort()).toEqual(['devspaces-api', 'devspaces-detached', 'devspaces-git-fails', 'devspaces-git-fails'].map(fixtureContainerId).sort());
    const gitFails = fixtureContainerId('devspaces-git-fails');
    expect(execs.filter((exec) => exec.container === gitFails).map((exec) => exec.command)).toEqual([
      scriptCommand('gitSummary', ['/workspaces/git-fails']),
      scriptCommand('branch', ['/workspaces/git-fails']),
    ]);
    const ops = REFRESH_DEVSPACES.find((env) => env.id === ENV_OPS)!.containerName;
    expect(containers).not.toContain(ops);
    expect(containers).not.toContain(fixtureContainerId(ops));
    // Every read has a time limit, so a stuck exec cannot hang the refresh.
    expect(execs.length).toBe(4);
    for (const exec of execs) expect(exec.options.timeoutMs).toBe(BRANCH_EXEC_TIMEOUT_MS);
  });

  // A leftover stopped dev container never hides the running one.
  for (const order of ['running first', 'stopped first'] as const) {
    it(`shows a devspace with a running and a stopped dev container as running (${order})`, async () => {
      const dev = (name: string, running: boolean): ContainerInfo => ({
        id: name,
        name,
        state: running ? 'running' : 'stopped',
        rawState: running ? 'running' : 'exited',
        labels: { [LABEL_DEVSPACE_ID]: 'env-dup' },
        image: 'img',
        volumes: [],
        volumeSubpaths: [],
        mountTargets: [],
      });
      const pair = [dev('devspaces-dup', true), dev('devspaces-dup-old', false)];
      const docker: StateDocker = {
        listDevspaceContainers: async () => (order === 'running first' ? pair : [...pair].reverse()),
        listDevspaceVolumes: async () => [{ name: 'v-dup', labels: {} }],
        volumeExists: async () => true,
        exec: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }),
      };
      const env: StateDevspace = { id: 'env-dup', containerName: 'devspaces-dup', volumeName: 'v-dup', folder: '/workspaces/r', branch: false };
      const states = await readDevspaceStates(docker, [env]);
      expect(states.runtime.get('env-dup')?.container).toBe('running');
    });
  }

  it('fails when the containers cannot be listed', async () => {
    const docker: StateDocker = {
      listDevspaceContainers: async () => {
        throw new Error('Cannot connect to the Docker daemon');
      },
      listDevspaceVolumes: async () => [],
      volumeExists: async () => false,
      exec: async () => ({ exitCode: 0, stdout: 'main\n', stderr: '', timedOut: false }),
    };
    await expect(readDevspaceStates(docker, REFRESH_DEVSPACES)).rejects.toThrow(/Docker daemon/);
  });

  it(`reads at most ${BRANCH_READ_CONCURRENCY} Git states at a time`, async () => {
    const devspaces: StateDevspace[] = Array.from({ length: 10 }, (_, index) => ({
      id: `env-${index}`,
      containerName: `c-${index}`,
      volumeName: `v-${index}`,
      folder: `/workspaces/r${index}`,
      branch: true,
    }));
    const containers: ContainerInfo[] = devspaces.map((env) => ({
      id: env.containerName,
      name: env.containerName,
      state: 'running',
      rawState: 'running',
      labels: { [LABEL_DEVSPACE_ID]: env.id },
      image: 'img',
      volumes: [],
      volumeSubpaths: [],
      mountTargets: [],
    }));
    let active = 0;
    let peak = 0;
    const docker: StateDocker = {
      listDevspaceContainers: async () => containers,
      listDevspaceVolumes: async () => devspaces.map((env) => ({ name: env.volumeName, labels: {} })),
      volumeExists: async () => true,
      exec: async (container): Promise<RunResult> => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        return { exitCode: 0, stdout: `b-${container}\n0\n1\n0\n`, stderr: '', timedOut: false };
      },
    };
    const states = await readDevspaceStates(docker, devspaces);
    expect(peak).toBe(BRANCH_READ_CONCURRENCY);
    expect(states.branches.size).toBe(10);
    expect(states.branches.get('env-3')).toBe('b-c-3');
    expect(states.changes.get('env-3')).toEqual({ uncommittedFiles: 0, unpushedCommits: 1, stashes: 0 });
  });
});

describe('readDevspaceStates: the dev container by the rule', () => {
  const env: StateDevspace = { id: 'env-u4', containerName: 'devspaces-u4', volumeName: 'v-u4', folder: '/workspaces/u4', branch: true };
  const listed = (id: string, name: string, state: 'running' | 'stopped', created?: string): ListedContainer => ({
    id,
    name,
    state,
    rawState: state === 'running' ? 'running' : 'exited',
    labels: { [LABEL_DEVSPACE_ID]: env.id },
    image: 'img',
    ...(created !== undefined ? { created } : {}),
  });
  function docker(containers: ListedContainer[], execs: string[]): StateDocker {
    return {
      listDevspaceContainers: async () => containers,
      listDevspaceVolumes: async () => [{ name: env.volumeName, labels: {} }],
      volumeExists: async () => true,
      exec: async (container) => (execs.push(container), { exitCode: 0, stdout: `branch-of-${container}\n0\n0\n0\n`, stderr: '', timedOut: false }),
    };
  }

  it('the state of the named dev container while another dev container runs; that one sets servicesRunning, so Stop is offered', async () => {
    const execs: string[] = [];
    const states = await readDevspaceStates(docker([listed('id-named', env.containerName, 'stopped'), listed('id-other', 'devspaces-u4-old', 'running', '2026-10-08T09:00:00Z')], execs), [env]);
    expect(states.runtime.get(env.id)).toEqual({ container: 'stopped', volume: true, servicesRunning: true });
    expect(states.branches.size).toBe(0);
    expect(execs).toEqual([]);
  });

  it('without the named one: the newest running dev container by its time, its branch read by its ID; another running one sets servicesRunning', async () => {
    const execs: string[] = [];
    const containers = [
      listed('id-older', 'devspaces-a', 'running', '2026-10-08T08:00:00Z'),
      // Half a second later than id-text, which sorts after it as text.
      listed('id-newer', 'devspaces-b', 'running', '2026-10-08T09:00:00.5Z'),
      listed('id-text', 'devspaces-c', 'running', '2026-10-08T09:00:00Z'),
    ];
    const states = await readDevspaceStates(docker(containers, execs), [env]);
    expect(states.runtime.get(env.id)).toEqual({ container: 'running', volume: true, servicesRunning: true });
    expect(execs).toEqual(['id-newer']);
    expect(states.branches.get(env.id)).toBe('branch-of-id-newer');
  });

  it('the named running dev container alone: no servicesRunning, its branch by its ID', async () => {
    const execs: string[] = [];
    const states = await readDevspaceStates(docker([listed('id-named', env.containerName, 'running'), listed('id-old', 'devspaces-u4-old', 'stopped', '2026-10-08T09:00:00Z')], execs), [env]);
    expect(states.runtime.get(env.id)).toEqual({ container: 'running', volume: true });
    expect(execs).toEqual(['id-named']);
  });
});

describe('readRunningGitState', () => {
  /** A Docker whose exec answers the script `gitSummary` with `summary` and the script `branch` with `branch`. */
  function docker(summary: Partial<RunResult> | Error, branch: Partial<RunResult> | Error): { docker: Pick<StateDocker, 'exec'>; scripts: string[] } {
    const scripts: string[] = [];
    const answer = (value: Partial<RunResult> | Error): RunResult => {
      if (value instanceof Error) throw value;
      return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...value };
    };
    return {
      scripts,
      docker: {
        exec: async (_container, command) => {
          const isSummary = command.join(' ') === scriptCommand('gitSummary', ['/workspaces/r']).join(' ');
          scripts.push(isSummary ? 'gitSummary' : 'branch');
          return answer(isSummary ? summary : branch);
        },
      },
    };
  }

  it('reads the branch and the change counts with one script; a detached HEAD has the branch null', async () => {
    const one = docker({ stdout: 'main\n1\n2\n3\n' }, new Error('not run'));
    expect(await readRunningGitState(one.docker, 'c', 'node', '/workspaces/r')).toEqual({ branch: 'main', changes: { uncommittedFiles: 1, unpushedCommits: 2, stashes: 3 } });
    expect(one.scripts).toEqual(['gitSummary']);
    const detached = docker({ stdout: '\n0\n0\n0\n' }, new Error('not run'));
    expect(await readRunningGitState(detached.docker, 'c', undefined, '/workspaces/r')).toEqual({ branch: null, changes: { uncommittedFiles: 0, unpushedCommits: 0, stashes: 0 } });
  });

  it('reads the branch alone when the Git state fails, ends without its time limit, or is no Git state; no counts then', async () => {
    for (const summary of [{ exitCode: 128, stderr: 'fatal' }, { exitCode: null, timedOut: true }, { stdout: 'main\n' }, new Error('exec failed')] as Array<Partial<RunResult> | Error>) {
      const reads = docker(summary, { stdout: 'main\n' });
      expect(await readRunningGitState(reads.docker, 'c', 'node', '/workspaces/r')).toEqual({ branch: 'main' });
      expect(reads.scripts).toEqual(['gitSummary', 'branch']);
    }
  });

  it('gives nothing when neither the Git state nor the branch can be read', async () => {
    const reads = docker({ exitCode: 127, stderr: 'Git is not installed.' }, { exitCode: 127 });
    expect(await readRunningGitState(reads.docker, 'c', 'node', '/workspaces/r')).toEqual({});
  });
});
