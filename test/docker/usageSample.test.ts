// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The utilization samples of a host (docs/architecture.md "The utilization samples") with real shells and a real SSH
// server: USAGE_SCRIPT through UsageSampler in a container of Alpine (BusyBox ash) and of the helper image (Debian,
// dash), with `docker exec -i … sh -s`; and on the shared shell of a host (RemoteShells) over SSH to the SSH server of
// the remote host tests (test/docker/sshd, Alpine with the Docker CLI and the socket of the engine), with the transport
// of the extension (sshHostTransport). The samples must leave nothing on the host: no process once the shell closed,
// and no change of the file system (`docker diff`).
import * as fs from 'fs';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BootstrapDocker } from '../../src/core/docker/bootstrapDocker';
import { findExecutable } from '../../src/core/docker/dockerCli';
import { helperDockerSocket } from '../../src/core/helper/helperImages';
import { NodeProcessRunner } from '../../src/core/process';
import { RemoteShells } from '../../src/core/relay/remoteShells';
import { sshHostTransport } from '../../src/core/relay/transport';
import { UsageSampler, type UsageEnd, type UsageRun, type UsageSamplerOptions } from '../../src/core/hosts/usageSampler';
import type { UsageBlock, UsageHeader } from '../../src/core/hosts/usageSample';
import { TEST_BASE_IMAGE, TEST_RUN_LABEL, removeRunObjects } from './dockerRun';
import { dockerTestContext, testHelperImage } from './harness';

const ALIAS = 'devspaces-test-usage';
const SSHD_DOCKERFILE_FOLDER = path.resolve(__dirname, 'sshd');

/** The samples of a test: their blocks as they come, and their end. */
interface TestSamples {
  sampler: UsageSampler;
  headers: UsageHeader[];
  blocks: UsageBlock[];
  names: Array<ReadonlyMap<string, string> | undefined>;
  ends: UsageEnd[];
  /** Resolves once `count` blocks came (rejects after 30 s or when the samples ended before). */
  blocksCame(count: number): Promise<void>;
}

describe('the utilization samples with real shells and a real SSH server', () => {
  const { run, env, cli, log } = dockerTestContext('usageSample');
  const runner = new NodeProcessRunner();
  const dir = path.join(run.runDir, 'usage-sample');
  const sshdImage = `devspaces-test-sshd-usage:${run.runId}`;
  const sshdContainer = `devspaces-test-sshd-usage-${run.runId}`;
  let sshPath: string;

  function samples(runSample: UsageSamplerOptions['run'], docker?: UsageSamplerOptions['docker'], intervalMs = 500): TestSamples {
    const result = { headers: [], blocks: [], names: [], ends: [] } as unknown as TestSamples;
    const waiters: Array<() => void> = [];
    result.sampler = UsageSampler.start({
      logger: log,
      name: 'test host',
      intervalMs,
      run: runSample,
      docker,
      onHeader: (header) => result.headers.push(header),
      onBlock: (block, _usage, names) => {
        result.blocks.push(block);
        result.names.push(names);
        for (const wake of waiters.splice(0)) wake();
      },
      onEnd: (end) => {
        log.info(`The samples ended: ${JSON.stringify(end)}`);
        result.ends.push(end);
        for (const wake of waiters.splice(0)) wake();
      },
    });
    result.blocksCame = async (count) => {
      const deadline = Date.now() + 30_000;
      while (result.blocks.length < count) {
        if (result.ends.length > 0) throw new Error(`The samples ended before block ${count}: ${JSON.stringify(result.ends)}`);
        if (Date.now() > deadline) throw new Error(`No block ${count} within 30 seconds.`);
        await new Promise<void>((resolve) => {
          waiters.push(resolve);
          setTimeout(resolve, 1_000);
        });
      }
    };
    return result;
  }

  /** The changes of the files of `container` (`docker diff`), sorted: Docker does not keep their order. */
  function changes(container: string): string[] {
    return cli.lines(['diff', container]).sort();
  }

  /** The commands of the processes in `container` (`docker top`, read on this computer). */
  function processes(container: string): string[] {
    // Docker needs the column PID; the command is the rest of each line.
    const lines = cli.lines(['top', container, '-o', 'pid,args']);
    return lines.slice(1).map((line) => line.trim().replace(/^\d+\s+/, ''));
  }

  /** Waits until `container` runs only processes that `allowed` accepts; returns them. */
  async function onlyProcesses(container: string, allowed: (command: string) => boolean): Promise<string[]> {
    const deadline = Date.now() + 15_000;
    for (;;) {
      const left = processes(container);
      if (left.every(allowed) || Date.now() > deadline) return left;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  afterAll(() => {
    removeRunObjects(cli, run.runId);
    expect(cli.container(sshdContainer)).toBeUndefined();
  });

  /** The shells: BusyBox ash in Alpine, and dash in the helper image (Debian). */
  const shells: Array<{ name: string; image: () => Promise<string> }> = [
    { name: 'BusyBox ash (Alpine)', image: async () => TEST_BASE_IMAGE },
    { name: 'dash (the helper image, Debian)', image: async () => (await testHelperImage(new BootstrapDocker(runner, run.dockerPath, env, log), log, env)).tag },
  ];
  for (const { name: shellName, image: imageOf } of shells) {
    it(`runs in ${shellName} with docker exec, and leaves nothing`, async () => {
      const image = await imageOf();
      const container = `devspaces-test-usage-${shellName.split(' ')[0].toLowerCase()}-${run.runId}`;
      cli.ok(['run', '-d', '--name', container, '--label', `${TEST_RUN_LABEL}=${run.runId}`, '--entrypoint', 'sleep', image, '600']);
      try {
        const runSample = async (script: string, timeoutMs: number): Promise<UsageRun> => ({
          kind: 'ran',
          result: await runner.run(run.dockerPath, ['exec', '-i', container, 'sh', '-s'], { env, input: script, timeoutMs }),
        });
        const test = samples(runSample);
        await test.blocksCame(6);
        expect(test.headers).toHaveLength(1);
        // A container has no folder of Docker data, so no line `D`; the counters of the kernel are there.
        const [first] = test.blocks;
        expect(first.cpu).toBeDefined();
        expect(first.memoryKb.MemTotal).toBeGreaterThan(0n);
        expect(test.blocks.map((block) => block.seq)).toEqual([1, 2, 3, 4, 5, 6]);
        expect(test.blocks.every((block) => block.skipped === 0)).toBe(true);
        test.sampler.stop();
        expect(test.ends).toEqual([{ kind: 'stopped' }]);
        expect(await onlyProcesses(container, (command) => command === 'sleep 600')).toEqual(['sleep 600']);
        expect(cli.ok(['diff', container])).toBe('');
      } finally {
        cli.run(['rm', '-f', container]);
      }
    });
  }

  describe('over SSH', () => {
    beforeAll(async () => {
      fs.mkdirSync(dir, { recursive: true });
      const ssh = findExecutable('ssh', process.env, process.platform);
      const keygen = findExecutable('ssh-keygen', process.env, process.platform);
      if (!ssh || !keygen) throw new Error('The Docker test of the utilization samples needs the OpenSSH client (ssh and ssh-keygen).');
      const key = path.join(dir, 'id_ed25519');
      const generated = await runner.run(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', 'devspaces-test', '-f', key]);
      expect(generated.exitCode, generated.stderr).toBe(0);
      cli.ok(['build', '-q', '--label', `${TEST_RUN_LABEL}=${run.runId}`, '--build-arg', `BASE_IMAGE=${TEST_BASE_IMAGE}`, '-t', sshdImage, SSHD_DOCKERFILE_FOLDER]);
      cli.ok([
        'run', '-d', '--name', sshdContainer, '--label', `${TEST_RUN_LABEL}=${run.runId}`,
        '-e', `AUTHORIZED_KEY=${fs.readFileSync(`${key}.pub`, 'utf8').trim()}`,
        '-v', `${helperDockerSocket(env, process.platform)}:/var/run/docker.sock`,
        '-p', '127.0.0.1::22',
        sshdImage,
      ]);
      const port = Number(cli.ok(['port', sshdContainer, '22/tcp']).split('\n')[0].split(':').pop());
      expect(port).toBeGreaterThan(0);
      const hostKey = cli.ok(['exec', sshdContainer, 'cat', '/etc/ssh/ssh_host_ed25519_key.pub']).split(' ').slice(0, 2).join(' ');
      const knownHosts = path.join(dir, 'known_hosts');
      fs.writeFileSync(knownHosts, `[127.0.0.1]:${port} ${hostKey}\n`);
      const config = path.join(dir, 'ssh_config');
      fs.writeFileSync(
        config,
        [`Host ${ALIAS}`, '  HostName 127.0.0.1', `  Port ${port}`, '  User root', '  IdentitiesOnly yes', '  StrictHostKeyChecking yes', `  IdentityFile ${key}`, `  UserKnownHostsFile ${knownHosts}`, ''].join('\n'),
      );
      sshPath = path.join(dir, 'ssh');
      fs.writeFileSync(sshPath, `#!/bin/sh\nexec '${ssh}' -F '${config}' "$@"\n`, { mode: 0o755 });
      // The SSH server answers once sshd runs.
      const deadline = Date.now() + 30_000;
      for (;;) {
        const login = await runner.run(sshPath, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', ALIAS, 'true'], { env, timeoutMs: 15_000 });
        if (login.exitCode === 0) break;
        if (Date.now() > deadline) throw new Error(`The SSH server does not answer: ${login.stderr}`);
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    });

    it('runs on the shared shell of the host over SSH with the transport of the extension: one login, and nothing left once the shell closed', async () => {
      const before = changes(sshdContainer);
      // The server and its processes of a session (`sshd: root@notty`, or `sshd-session: root@notty` from OpenSSH 9.8 on).
      const sshdOnly = (command: string) => /^(\/usr\/sbin\/|\/usr\/lib\/ssh\/)?sshd(-session)?\b/.test(command);
      let logins = 0;
      const shells = new RemoteShells({
        logger: log,
        start: (host) => {
          const transport = sshHostTransport(host, sshPath, env);
          if (transport === undefined) return undefined;
          logins++;
          return { process: runner.startBytes(transport.file, transport.args, { env: transport.env }) };
        },
      });
      try {
        const runSample = async (script: string, timeoutMs: number): Promise<UsageRun> => {
          const result = await shells.run(ALIAS, 'sh -s', { input: script, timeoutMs });
          return result === undefined ? { kind: 'notRun', reason: 'noTransport' } : { kind: 'ran', result };
        };
        const docker = async (args: readonly string[], timeoutMs: number): Promise<UsageRun> => {
          const result = await shells.docker(ALIAS, args, { timeoutMs });
          return result === undefined ? { kind: 'notRun', reason: 'noTransport' } : { kind: 'ran', result };
        };
        const test = samples(runSample, docker);
        await test.blocksCame(6);
        expect(test.headers[0]).toMatchObject({ uid: 0 });
        expect(test.blocks.map((block) => block.seq)).toEqual([1, 2, 3, 4, 5, 6]);
        // All samples on one login.
        expect(logins).toBe(1);
        // The Docker CLI of the host on the same shell: the names of the containers of the engine.
        const names = await docker(['ps', '--no-trunc', '--format', '{{.ID}} {{.Names}}'], 10_000);
        expect(names.kind === 'ran' ? names.result.stdout : '').toContain(sshdContainer);
        test.sampler.stop();
        expect(test.ends).toEqual([{ kind: 'stopped' }]);
        // Between two samples, the host runs nothing of them.
        expect((await onlyProcesses(sshdContainer, (command) => sshdOnly(command) || command === 'sh -s')).filter((command) => !sshdOnly(command) && command !== 'sh -s')).toEqual([]);
      } finally {
        shells.dispose();
      }
      // The shell closed: sshd ends its session, and nothing of the samples stays.
      expect((await onlyProcesses(sshdContainer, sshdOnly)).filter((command) => !sshdOnly(command))).toEqual([]);
      expect(changes(sshdContainer)).toEqual(before);
    });
  });
});
