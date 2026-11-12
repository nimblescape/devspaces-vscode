// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The reads of the report of one resource of the view Docker Hosts (docs/requirements.md R-ENG-010): only calls that the
// shared shell of a host carries; the facts of Docker always, the shared volumes only for the reports that need them,
// with the reader mounting only volumes that exist (a mount of a missing volume would create it); a failure becomes a
// note of the report, only an abort ends the read.
import { describe, expect, it } from 'vitest';
import { isSharedShellCall } from '../docker/bootstrapDocker';
import type { HostObject } from './hostObjects';
import type { RunOptions, RunResult } from '../ports';
import type { ReportComputer } from './monitorReport';
import { CLOCK, HELPER } from './reportFixtures.testkit';
import { readResourceReport } from './reportRead';
import { isVolumeReaderCall } from './volumeReader';

const COMPUTER: ReportComputer = { id: 'computer-1', repositories: new Map(), version: '0.4.1' };
const ok = (stdout = ''): RunResult => ({ exitCode: 0, stdout, stderr: '', timedOut: false });
const failed = (stderr: string, exitCode = 1): RunResult => ({ exitCode, stdout: '', stderr, timedOut: false });
const READER_OUTPUT = JSON.stringify({ reader: 1, stopped: false, monitor: { files: [] } });

/** A Docker that answers each call by its first words (`volume ls`, `run`), and records the calls. */
function fakeDocker(answers: Record<string, RunResult | (() => Promise<RunResult>)>) {
  const calls: Array<{ args: string[]; options: RunOptions | undefined }> = [];
  return {
    calls,
    words: () => calls.map((call) => call.args.slice(0, 2).join(' ')),
    run: async (args: string[], options?: RunOptions): Promise<RunResult> => {
      calls.push({ args, options });
      const key = Object.keys(answers)
        .filter((prefix) => args.join(' ').startsWith(prefix))
        .sort((a, b) => b.length - a.length)[0];
      if (key === undefined) throw new Error(`No answer for docker ${args.join(' ')}`);
      const answer = answers[key];
      return typeof answer === 'function' ? answer() : answer;
    },
  };
}

const monitorContainer: HostObject = { kind: 'container', id: 'm1', name: 'devspaces-monitor', purpose: 'monitor', state: 'running' };
const vscodeVolume: HostObject = { kind: 'volume', id: 'devspaces-vscode', name: 'devspaces-vscode', purpose: 'sharedVolume' };
const nginx: HostObject = { kind: 'image', id: 'sha256:n', name: 'nginx:1.27', tags: ['nginx:1.27'], purpose: 'notDevspaces' };

describe('readResourceReport', () => {
  it('reads only the facts of Docker for a report without shared volumes', async () => {
    const docker = fakeDocker({ 'image inspect': ok(`${JSON.stringify({ Id: 'sha256:n', RepoTags: ['nginx:1.27'], Size: 1000, Created: '2026-11-01T10:00:00Z', Config: { Labels: {} } })}\n`) });
    const report = await readResourceReport(docker, { object: nginx, computer: COMPUTER, clock: CLOCK });
    expect(docker.words()).toEqual(['image inspect']);
    expect(report.notices).toEqual([]);
    expect(report.sections.length).toBeGreaterThan(0);
  });

  it('gives a failed inspect as a note of the report, and reads the volumes all the same', async () => {
    const docker = fakeDocker({
      'container inspect': failed('Error response from daemon: No such container: m1\n'),
      'volume ls': ok('devspaces-monitor\nother\n'),
      'image ls': ok(`nginx:1.27\n${HELPER}\n`),
      run: ok(READER_OUTPUT),
    });
    const report = await readResourceReport(docker, { object: monitorContainer, currentHelperTag: HELPER, computer: COMPUTER, clock: CLOCK });
    expect(report.notices).toContain('Docker could not give the facts of this object: Error response from daemon: No such container: m1');
    expect(docker.words()).toEqual(['container inspect', 'volume ls', 'image ls', 'run --rm']);
  });

  it('runs the reader with the helper image of this version first, mounts only the volumes that exist, and reads the platform for the store of VS Code', async () => {
    const docker = fakeDocker({
      'volume inspect': ok(`${JSON.stringify({ Name: 'devspaces-vscode', Driver: 'local', Scope: 'local', Labels: {} })}\n`),
      'container ls': ok(''),
      // The volume of the Monitor is not there: the reader must not mount it (a mount would create it).
      'volume ls': ok('devspaces-vscode\n'),
      'image ls': ok(`devspaces-worker:111111111111\n${HELPER}\n`),
      'info --format': ok('aarch64\n'),
      run: ok(JSON.stringify({ reader: 1, stopped: false, vscode: { servers: [], extensions: [], packs: [] } })),
    });
    const report = await readResourceReport(docker, { object: vscodeVolume, currentHelperTag: HELPER, computer: COMPUTER, clock: CLOCK });
    const reader = docker.calls.find((call) => isVolumeReaderCall(call.args));
    expect(reader).toBeDefined();
    const args = reader?.args ?? [];
    expect(args[args.indexOf('--pull') + 1]).toBe('never');
    expect(args.join(' ')).toContain('source=devspaces-vscode,');
    expect(args.join(' ')).not.toContain('source=devspaces-monitor,');
    expect(args).toContain(HELPER);
    expect(args).not.toContain('devspaces-worker:111111111111');
    expect(docker.words()).toContain('info --format');
    expect(report.notices.filter((notice) => notice.includes('could not be read'))).toEqual([]);
  });

  it('runs no reader when none of the volumes exists, and says so', async () => {
    const docker = fakeDocker({ 'container inspect': ok(`${JSON.stringify({ Id: 'm1', Name: '/devspaces-monitor', State: { Status: 'running' }, Config: { Labels: {} } })}\n`), 'volume ls': ok('other\n') });
    const report = await readResourceReport(docker, { object: monitorContainer, computer: COMPUTER, clock: CLOCK });
    expect(docker.words()).toEqual(['container inspect', 'volume ls']);
    expect(report.notices).toContain('What the volume contains could not be read: the volume is not there anymore.');
  });

  it('gives a failed list as a note with its reason, and a list that took too long says so', async () => {
    const inspect = ok(`${JSON.stringify({ Id: 'm1', Name: '/devspaces-monitor', Config: { Labels: {} } })}\n`);
    const refused = await readResourceReport(fakeDocker({ 'container inspect': inspect, 'volume ls': failed('permission denied while trying to connect to the Docker daemon socket\n') }), {
      object: monitorContainer,
      computer: COMPUTER,
      clock: CLOCK,
    });
    expect(refused.notices.some((notice) => notice.startsWith('What the volume contains could not be read:') && notice.includes('permission denied'))).toBe(true);
    const slow = await readResourceReport(fakeDocker({ 'container inspect': inspect, 'volume ls': { exitCode: null, stdout: '', stderr: '', timedOut: true } }), {
      object: monitorContainer,
      computer: COMPUTER,
      clock: CLOCK,
    });
    expect(slow.notices.some((notice) => notice.includes('did not end within the time limit'))).toBe(true);
  });

  it('keeps the store report when the platform cannot be read', async () => {
    const docker = fakeDocker({
      'volume inspect': ok(`${JSON.stringify({ Name: 'devspaces-vscode', Driver: 'local', Labels: {} })}\n`),
      'container ls': ok(''),
      'volume ls': ok('devspaces-vscode\ndevspaces-monitor\n'),
      'image ls': ok(`${HELPER}\n`),
      'info --format': failed('Cannot connect to the Docker daemon\n'),
      run: ok(JSON.stringify({ reader: 1, stopped: false, vscode: { servers: [], extensions: [], packs: [] }, monitor: { files: [] } })),
    });
    const report = await readResourceReport(docker, { object: vscodeVolume, currentHelperTag: HELPER, computer: COMPUTER, clock: CLOCK });
    expect(docker.calls.some((call) => isVolumeReaderCall(call.args))).toBe(true);
    expect(report.sections.length).toBeGreaterThan(0);
  });

  it('ends at an abort, and passes the signal and a time limit to each call', async () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const signal = new AbortController().signal;
    const docker = fakeDocker({
      'container inspect': ok(`${JSON.stringify({ Id: 'm1', Config: { Labels: {} } })}\n`),
      'volume ls': ok('devspaces-monitor\n'),
      'image ls': () => Promise.reject(abort),
    });
    await expect(readResourceReport(docker, { object: monitorContainer, computer: COMPUTER, clock: CLOCK, signal })).rejects.toBe(abort);
    for (const call of docker.calls) {
      expect(call.options?.signal).toBe(signal);
      expect(call.options?.timeoutMs).toBeGreaterThan(0);
    }
  });

  it('makes only calls that the shared shell of a host carries', async () => {
    const docker = fakeDocker({
      'volume inspect': ok(`${JSON.stringify({ Name: 'devspaces-vscode', Labels: {} })}\n`),
      'container ls': ok(''),
      'volume ls': ok('devspaces-vscode\ndevspaces-monitor\n'),
      'image ls': ok(`${HELPER}\n`),
      'info --format': ok('x86_64\n'),
      run: ok(READER_OUTPUT),
    });
    await readResourceReport(docker, { object: vscodeVolume, currentHelperTag: HELPER, computer: COMPUTER, clock: CLOCK });
    expect(docker.calls.length).toBeGreaterThanOrEqual(5);
    for (const call of docker.calls) expect({ args: call.args, shared: isSharedShellCall(call.args, false) }).toEqual({ args: call.args, shared: true });
  });
});
