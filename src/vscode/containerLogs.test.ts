// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Show Log of a container row of the view Docker Hosts (R-ENG-008): the log of the container of the row by its full ID,
// as a read-only document, read as a flow of the user; nothing while the setting devspaces.allowContainerLogs is off or
// while the VM of Devspaces does not run; a log driver that gives no log, and any other failure, said in words.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { LIMA_HOST } from '../core/docker/dockerHost';
import { CommandError } from '../core/errors';
import type { HostObject } from '../core/hosts/hostObjects';
import { sshPromptsAllowed } from '../core/sshAskpass';
import type { VmState } from '../core/vm/vmState';
import { CONTAINER_LOG_SCHEME, ContainerLogTexts, ContainerLogs, type ContainerLogsDeps } from './containerLogs';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };
const ID = '0123456789abcdef'.repeat(4);
const web: HostObject = { kind: 'container', id: ID, name: 'shop-web-1', purpose: 'notDevspaces', state: 'exited' };
const row = (host: string, object: HostObject) => ({ hostsNode: 'object', host, object });

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

function harness(overrides: Partial<ContainerLogsDeps> = {}) {
  const state = { allowed: true, vm: { kind: 'running' } as VmState, flow: false };
  const read = vi.fn(async () => {
    state.flow = sshPromptsAllowed();
    return '2026-11-13 22:00:00.000 listening on :80';
  });
  const logs = new ContainerLogs({ logger, allowed: () => state.allowed, vmHost: LIMA_HOST, vmState: async () => state.vm, read, timeZone: () => 'Europe/Vienna', ...overrides });
  return { state, read, logs };
}

beforeEach(() => {
  resetFakeVscode();
  vi.clearAllMocks();
});

describe('Show Log of a container row', () => {
  it('opens the log of the container of the row by its full ID, also of a stopped one, read as a flow of the user', async () => {
    const h = harness();
    await h.logs.showRow(row('lab', web));
    expect(h.read).toHaveBeenCalledWith('lab', ID, 'Europe/Vienna');
    expect(h.state.flow).toBe(true);
    const [document] = fakeVscode.window.showTextDocument.mock.calls[0] as [{ uri: { scheme: string; path: string }; languageId: string; getText(): string }, unknown];
    expect(document.uri).toMatchObject({ scheme: CONTAINER_LOG_SCHEME, path: '/lab/shop-web-1.log' });
    expect(document.languageId).toBe('log');
    expect(document.getText()).toBe('2026-11-13 22:00:00.000 listening on :80\n');
    // A second Show Log shows the newer log in the same document.
    h.read.mockResolvedValue('');
    await h.logs.showRow(row('lab', web));
    const [again] = fakeVscode.window.showTextDocument.mock.calls[1] as [{ uri: { path: string }; getText(): string }];
    expect(again.uri.path).toBe('/lab/shop-web-1.log');
    expect(again.getText()).toBe('The container shop-web-1 wrote nothing to its log yet.');
    h.logs.dispose();
    expect(fakeVscode.contentProviders.size).toBe(0);
  });

  it('shows the log without the colors and the other control sequences of a terminal', async () => {
    const h = harness();
    h.read.mockResolvedValue('2026-11-13 22:00:00.000 \u001b[32minfo\u001b[0m ready\n2026-11-13 22:00:01.000 \u001b]0;title\u0007done');
    await h.logs.showRow(row('lab', web));
    const [document] = fakeVscode.window.showTextDocument.mock.calls[0] as [{ getText(): string }];
    expect(document.getText()).toBe('2026-11-13 22:00:00.000 info ready\n2026-11-13 22:00:01.000 done\n');
    // A log of control sequences only is an empty log.
    h.read.mockResolvedValue('\u001b[0m\u001b[2J');
    await h.logs.showRow(row('lab', web));
    const [again] = fakeVscode.window.showTextDocument.mock.calls[1] as [{ getText(): string }];
    expect(again.getText()).toBe('The container shop-web-1 wrote nothing to its log yet.');
  });

  it('names the Monitor in its texts, and reads nothing for a row that is no container or has no full ID', async () => {
    const h = harness();
    h.read.mockRejectedValue(new CommandError('docker logs x', 1, '', 'Error response from daemon: No such container: x'));
    await h.logs.showRow(row('lab', { kind: 'container', id: ID, name: 'devspaces-monitor', purpose: 'monitor' }));
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(expect.stringMatching(/^The log of the Monitor could not be read: /));
    h.read.mockClear();
    await h.logs.showRow(row('lab', { kind: 'image', id: `sha256:${ID}`, name: 'nginx:1.27', purpose: 'notDevspaces' }));
    await h.logs.showRow(row('lab', { ...web, id: ID.slice(0, 12) }));
    await h.logs.showRow({ hostsNode: 'host', host: 'lab' });
    await h.logs.showRow(undefined);
    expect(h.read).not.toHaveBeenCalled();
  });

  it('reads nothing while the setting devspaces.allowContainerLogs is off, and says how to turn it on', async () => {
    const h = harness();
    h.state.allowed = false;
    await h.logs.showRow(row('lab', web));
    expect(h.read).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ContainerLogTexts.off);
  });

  it('never starts the VM: on a VM that does not run, it reads nothing and says why', async () => {
    const h = harness();
    for (const vm of [{ kind: 'stopped' }, { kind: 'notSetUp' }, { kind: 'unknown' }] as VmState[]) {
      h.state.vm = vm;
      await h.logs.showRow(row(LIMA_HOST, web));
    }
    expect(h.read).not.toHaveBeenCalled();
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(ContainerLogTexts.vmNotRunning);
    h.state.vm = { kind: 'running' };
    await h.logs.showRow(row(LIMA_HOST, web));
    expect(h.read).toHaveBeenCalledWith(LIMA_HOST, ID, 'Europe/Vienna');
  });

  it('says that the log driver of the container gives no log, and opens no document', async () => {
    const h = harness();
    h.read.mockRejectedValue(new CommandError(`docker logs ${ID}`, 1, '', 'Error response from daemon: configured logging driver does not support reading'));
    await h.logs.showRow(row('lab', web));
    await flush();
    expect(fakeVscode.window.showWarningMessage).toHaveBeenCalledWith(ContainerLogTexts.noLog({ host: 'lab', container: ID, name: 'shop-web-1', monitor: false }));
    expect(fakeVscode.window.showTextDocument).not.toHaveBeenCalled();
  });
});
