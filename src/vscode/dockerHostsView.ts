// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The view "Docker Hosts" (`devspaces.hosts`, docs/requirements.md R-ENG-008) above the repository view: the VM of
// Devspaces first, then each remote host of the list, with the containers, images and volumes of Devspaces there and
// their removal. A host is read only when the user opens it in the view, and again at Refresh, never in the background
// (R-SEC-004): the rows of a host keep what its last read found, and a change of the view (another Docker host, a host
// that leaves the list, the state of the VM) reads no host again. A read never starts the VM: a stopped VM shows a row
// that starts it. Opening a remote host is a flow of the user, so a password login may ask there (R-ENG-003). A click
// on a host row makes it the Docker host of Devspaces, after its test (RemoteDockerCommands.selectHost); a check mark
// shows it. The objects of a devspace of this computer get the commands of the devspace (Stop, Delete…); every other
// object gets Stop (a running container) or Remove… (never with force), after one question, also for several selected
// rows. The rows come from dockerHostsModel.ts.
import * as vscode from 'vscode';
import type { HostInventory, HostObject, ObjectResult } from '../core/hosts/hostObjects';
import { errorMessage } from '../core/errors';
import { Actions } from '../core/messages';
import { isAbortError, type Logger } from '../core/ports';
import { withSshPrompts } from '../core/sshAskpass';
import type { VmState } from '../core/vm/vmState';
import {
  DOCKER_HOSTS_VIEW_ID,
  hostOfArgument,
  hostRows,
  objectActions,
  objectRows,
  rowLook,
  type GroupRow,
  type HostRow,
  type HostsNode,
  type MessageRow,
  type ObjectRow,
} from './dockerHostsModel';
import { showInformationMessage, showWarningMessage } from './notifications';
import { withNotificationProgress } from './progress';

/** User-visible texts of the commands of the view (plain language). */
export const DockerHostsCommandTexts = {
  stopping: (name: string, host: string) => `Stopping the container ${name} on ${host}…`,
  stopped: (name: string) => `The container ${name} was stopped.`,
  stopFailed: (name: string, detail: string) => `The container ${name} could not be stopped: ${detail}`,
  removeQuestion: (count: number, host: string) => (count === 1 ? `Remove 1 object from ${host}?` : `Remove ${count} objects from ${host}?`),
  removeDetail: (names: readonly string[], otherDevspace: boolean) =>
    [
      listed(names),
      'Docker removes no object that a container uses, and no running container: Devspaces never removes with force. This cannot be undone.',
      ...(otherDevspace
        ? ['Some of them belong to a devspace that this computer does not know (for example of another computer). A workspace volume holds the changes of that devspace that were not pushed: they are lost with it.']
        : []),
    ].join('\n\n'),
  remove: 'Remove',
  removing: (host: string) => `Removing objects from ${host}…`,
  nothingToRemove:
    'Remove… removes no object of a devspace of this computer and no running container. Delete the devspace with Delete…, which checks its Git changes first, and stop a running container first.',
  skipped: (count: number) => (count === 1 ? ' 1 selected object was skipped: an object of a devspace of this computer, or a running container.' : ` ${count} selected objects were skipped: objects of a devspace of this computer, or running containers.`),
  removed: (removed: number, total: number, host: string) => (removed === total ? `Removed ${total === 1 ? '1 object' : `${total} objects`} from ${host}.` : `Removed ${removed} of ${total} objects from ${host}.`),
  left: (names: readonly string[]) => ` Left: ${listed(names)}. The log says why.`,
  readFailed: (host: string) => `The objects on ${host} could not be read.`,
};

/** At most five names, then the number of the others. */
function listed(names: readonly string[]): string {
  if (names.length <= 5) return names.join(', ');
  return `${names.slice(0, 5).join(', ')} and ${names.length - 5} more`;
}

export interface DockerHostsDeps {
  logger: Logger;
  showLog: () => void;
  /** The VM of Devspaces on this platform (LIMA_HOST or WSL_HOST), undefined where there is none. */
  vmHost: string | undefined;
  /** The hosts of the list of Devspaces in its order, and the Docker host of Devspaces. */
  hostList: () => Promise<{ hosts: string[]; selected: string | undefined }>;
  /** The state of the VM, read without a start (vmState.ts). */
  vmState: () => Promise<VmState>;
  /** Reads the objects of Devspaces on `host` (readHostInventory within an operation on it). */
  read: (host: string, signal: AbortSignal) => Promise<HostInventory>;
  /** `docker container stop` of `object` on `host`. */
  stopContainer: (host: string, object: HostObject, signal: AbortSignal) => Promise<ObjectResult>;
  /** Removes `objects` on `host`, never with force. */
  removeObjects: (host: string, objects: readonly HostObject[], signal: AbortSignal, onItem: (text: string) => void) => Promise<ObjectResult[]>;
  /** Devspaces uses `host` after its test (RemoteDockerCommands.selectHost). */
  select: (host: string) => Promise<void>;
  /** The setup of the VM of Devspaces (a click on the VM row while it is not set up). */
  setUpVm: () => Promise<void>;
  /** `host` leaves the list of Devspaces (RemoteDockerCommands.removeFromList). */
  removeFromList: (host: string) => Promise<void>;
}

/** What the last read of a host found. `notRead`: the VM runs now, but was stopped at the last read. */
type HostEntry = { kind: 'inventory'; inventory: HostInventory } | { kind: 'stopped' } | { kind: 'notRead' } | { kind: 'failed'; detail: string };

export class DockerHostsView implements vscode.TreeDataProvider<HostsNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<HostsNode | undefined>();
  readonly onDidChangeTreeData: vscode.Event<HostsNode | undefined> = this.changeEmitter.event;
  /** The host rows as the view shows them now, by host (a change of one row needs its object). */
  private rows = new Map<string, HostRow>();
  /** What the last read of each host found. */
  private readonly entries = new Map<string, HostEntry>();
  /** The reads that run now, by host. */
  private readonly reads = new Map<string, Promise<HostEntry>>();
  /**
   * A part of the IDs of the rows that is new in each window: VS Code keeps the open rows of a view by their IDs, also
   * after a reload, and would read the hosts that were open then at the start of the window, which no user asked for.
   */
  private readonly session = Math.random().toString(36).slice(2, 10);
  private disposed = false;

  constructor(private readonly deps: DockerHostsDeps) {}

  dispose(): void {
    this.disposed = true;
    this.changeEmitter.dispose();
  }

  getTreeItem(node: HostsNode): vscode.TreeItem {
    const look = rowLook(node);
    const state =
      look.collapsible === 'expanded'
        ? vscode.TreeItemCollapsibleState.Expanded
        : look.collapsible === 'collapsed'
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(look.label, state);
    item.id = `${this.session}:${look.id}`;
    if (look.description !== undefined) item.description = look.description;
    item.tooltip = look.tooltip;
    item.contextValue = look.contextValue;
    item.iconPath = new vscode.ThemeIcon(look.icon);
    if (look.command !== undefined) item.command = look.command;
    return item;
  }

  async getChildren(node?: HostsNode): Promise<HostsNode[]> {
    if (node === undefined) return this.hostRows();
    switch (node.hostsNode) {
      case 'host':
        return this.hostChildren(node);
      case 'group':
        return objectRows(node.host, node.objects);
      default:
        return [];
    }
  }

  /**
   * The view shows the hosts again (the list, the Docker host of Devspaces, the state of the VM), without a new read of
   * a host: an open host keeps the rows of its last read.
   */
  changed(): void {
    if (!this.disposed) this.changeEmitter.fire(undefined);
  }

  /**
   * Refresh of the view title (`argument` undefined: every host) or of a host row: the next time that the view shows a
   * host, it reads it again; an open host is read now.
   */
  refresh(argument?: unknown): void {
    const host = hostOfArgument(argument);
    if (host === undefined) {
      this.entries.clear();
      this.changed();
      return;
    }
    this.invalidate(host);
  }

  /** `host` changed by a command of the user (a removal, a Stop, the start of the VM): an open host is read again. */
  invalidate(host: string): void {
    this.entries.delete(host);
    const row = this.rows.get(host);
    if (this.disposed) return;
    // A row that the view does not show (anymore): the whole view.
    this.changeEmitter.fire(row);
  }

  /** The click on a host row: the setup of the VM while it is not set up, else the host becomes the Docker host of Devspaces. */
  async select(argument: unknown): Promise<void> {
    const host = hostOfArgument(argument);
    if (host === undefined) return;
    const row = this.rows.get(host);
    if (row?.vm === true && row.vmState?.kind === 'notSetUp') {
      await this.deps.setUpVm();
      return;
    }
    await this.deps.select(host);
  }

  /** "Remove from the List" of a remote host row. */
  async removeFromList(argument: unknown): Promise<void> {
    const host = hostOfArgument(argument);
    if (host === undefined || host === this.deps.vmHost) return;
    await this.deps.removeFromList(host);
  }

  /** "Stop" of a running container that is no object of a devspace of this computer (H2: the Monitor, a worker…). */
  async stopObject(argument: unknown): Promise<void> {
    const row = objectRowOf(argument);
    if (row === undefined || !objectActions(row).stop) return;
    const { host, object } = row;
    try {
      const result = await withNotificationProgress({ title: DockerHostsCommandTexts.stopping(object.name, host), cancellable: true }, (_progress, token) =>
        withAbort(token, (signal) => this.deps.stopContainer(host, object, signal)),
      );
      if (result.outcome === 'stopped' || result.outcome === 'missing') this.inform(DockerHostsCommandTexts.stopped(object.name));
      else this.warnWithLog(DockerHostsCommandTexts.stopFailed(object.name, result.detail ?? ''));
    } catch (error) {
      if (!isAbortError(error)) this.warnWithLog(DockerHostsCommandTexts.stopFailed(object.name, errorMessage(error)));
    } finally {
      this.invalidate(host);
    }
  }

  /**
   * "Remove…" of the clicked row, or of the selected rows (`selection`, VS Code passes them with canSelectMany): after
   * one question that names them, the objects that are no objects of a devspace of this computer and no running
   * containers, never with force. The rows of another host than the clicked one are skipped.
   */
  async removeObjects(argument: unknown, selection?: unknown): Promise<void> {
    const clicked = objectRowOf(argument);
    if (clicked === undefined) return;
    const selected = Array.isArray(selection) && selection.length > 0 ? selection.flatMap((entry) => objectRowOf(entry) ?? []) : [clicked];
    const rows = selected.filter((row) => row.host === clicked.host);
    const removable = rows.filter((row) => objectActions(row).remove);
    const skipped = rows.length - removable.length;
    const { host } = clicked;
    if (removable.length === 0) {
      this.inform(DockerHostsCommandTexts.nothingToRemove);
      return;
    }
    const objects = removable.map((row) => row.object);
    const detail = DockerHostsCommandTexts.removeDetail(
      objects.map((object) => `${object.kind} ${object.name}`),
      objects.some((object) => object.purpose === 'otherDevspace'),
    );
    const answer = await showWarningMessage(DockerHostsCommandTexts.removeQuestion(objects.length, host), { modal: true, detail }, DockerHostsCommandTexts.remove);
    if (answer !== DockerHostsCommandTexts.remove) return;
    this.deps.logger.info(`Remove… on ${host}: ${objects.map((object) => `${object.kind} ${object.name}`).join(', ')}.`);
    try {
      const results = await withNotificationProgress({ title: DockerHostsCommandTexts.removing(host), cancellable: true }, (progress, token) =>
        withAbort(token, (signal) => this.deps.removeObjects(host, objects, signal, (text) => progress.report({ message: `Removing ${text}.` }))),
      );
      const done = results.filter((result) => result.outcome === 'removed' || result.outcome === 'missing').length;
      const left = results.filter((result) => result.outcome !== 'removed' && result.outcome !== 'missing').map((result) => result.object.name);
      const message = `${DockerHostsCommandTexts.removed(done, objects.length, host)}${left.length > 0 ? DockerHostsCommandTexts.left(left) : ''}${skipped > 0 ? DockerHostsCommandTexts.skipped(skipped) : ''}`;
      if (left.length > 0) this.warnWithLog(message);
      else this.inform(message);
    } catch (error) {
      if (isAbortError(error)) this.deps.logger.info(`Remove… on ${host} was cancelled.`);
      else this.warnWithLog(`${DockerHostsCommandTexts.removed(0, objects.length, host)} ${errorMessage(error)}`);
    } finally {
      this.invalidate(host);
    }
  }

  // -------------------------------------------------------------------------------------------------------------------

  private async hostRows(): Promise<HostRow[]> {
    let hosts: string[] = [];
    let selected: string | undefined;
    try {
      ({ hosts, selected } = await this.deps.hostList());
    } catch (error) {
      this.deps.logger.warn(`The list of Docker hosts of Devspaces could not be read: ${errorMessage(error)}`);
    }
    const vmState = this.deps.vmHost === undefined ? undefined : await this.deps.vmState();
    const rows = hostRows({ vmHost: this.deps.vmHost, vmState, hosts, selected });
    // The last read of a host that left the list is forgotten.
    for (const host of [...this.entries.keys()]) if (!rows.some((row) => row.host === host)) this.entries.delete(host);
    const vm = rows.find((row) => row.vm);
    if (vm !== undefined) this.followVm(vm);
    this.rows = new Map(rows.map((row) => [row.host, row]));
    return rows;
  }

  /**
   * The rows of the VM follow its state without a read: a VM that stopped shows its stopped row (its objects are not
   * known while it does not run, and an action on them would start it); a VM that runs again after a read found it
   * stopped shows a row that reads it.
   */
  private followVm(vm: HostRow): void {
    const entry = this.entries.get(vm.host);
    const kind = vm.vmState?.kind;
    if (kind === 'notSetUp') this.entries.delete(vm.host);
    else if (kind === 'stopped' && entry !== undefined) this.entries.set(vm.host, { kind: 'stopped' });
    else if (kind === 'running' && entry?.kind === 'stopped') this.entries.set(vm.host, { kind: 'notRead' });
  }

  private async hostChildren(row: HostRow): Promise<HostsNode[]> {
    const entry = this.entries.get(row.host) ?? (await this.readHost(row));
    switch (entry.kind) {
      case 'stopped':
        return [message(row.host, 'vmStopped')];
      case 'notRead':
        return [message(row.host, 'vmNotRead')];
      case 'failed':
        return [message(row.host, 'readFailed', entry.detail)];
      case 'inventory': {
        const { inventory } = entry;
        const groups: GroupRow[] = [
          { hostsNode: 'group', host: row.host, group: 'container', objects: inventory.containers },
          { hostsNode: 'group', host: row.host, group: 'image', objects: inventory.images },
          { hostsNode: 'group', host: row.host, group: 'volume', objects: inventory.volumes },
        ];
        return groups;
      }
    }
  }

  /** Reads `row` once at a time (the user opened it, or clicked Refresh): never a VM that does not run. */
  private readHost(row: HostRow): Promise<HostEntry> {
    const running = this.reads.get(row.host);
    if (running !== undefined) return running;
    const read = this.readNow(row).finally(() => {
      if (this.reads.get(row.host) === read) this.reads.delete(row.host);
    });
    this.reads.set(row.host, read);
    return read;
  }

  private async readNow(row: HostRow): Promise<HostEntry> {
    let entry: HostEntry;
    if (row.vm) {
      // The state of now, not of the row: the VM may have stopped since the view showed it.
      const state = await this.deps.vmState();
      if (state.kind !== 'running') {
        entry =
          state.kind === 'unknown' || state.kind === 'broken'
            ? { kind: 'failed', detail: state.detail ?? (state.kind === 'broken' ? 'Lima says that the VM is broken.' : 'The state of the VM is not known.') }
            : { kind: 'stopped' };
        this.entries.set(row.host, entry);
        return entry;
      }
    }
    const abort = new AbortController();
    try {
      this.deps.logger.info(`The view Docker Hosts reads ${row.host}.`);
      // A flow of the user: a password login to a remote host may ask in VS Code.
      const inventory = await vscode.window.withProgress({ location: { viewId: DOCKER_HOSTS_VIEW_ID } }, () => withSshPrompts(() => this.deps.read(row.host, abort.signal), abort.signal));
      entry = { kind: 'inventory', inventory };
    } catch (error) {
      const detail = errorMessage(error);
      this.deps.logger.warn(`${DockerHostsCommandTexts.readFailed(row.host)} ${detail}`);
      entry = { kind: 'failed', detail: detail.split('\n')[0].slice(0, 300) };
    }
    this.entries.set(row.host, entry);
    return entry;
  }

  private inform(text: string): void {
    showInformationMessage(text).then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
  }

  private warnWithLog(text: string): void {
    showWarningMessage(text, Actions.showDetails).then(
      (choice) => {
        if (choice === Actions.showDetails) this.deps.showLog();
      },
      (error: unknown) => this.deps.logger.error('Could not show the message.', error),
    );
  }
}

function message(host: string, kind: MessageRow['message'], detail?: string): MessageRow {
  return { hostsNode: 'message', host, message: kind, ...(detail !== undefined ? { detail } : {}) };
}

/** The object row of a command argument, else undefined. */
function objectRowOf(argument: unknown): ObjectRow | undefined {
  if (typeof argument !== 'object' || argument === null) return undefined;
  const row = argument as Partial<ObjectRow>;
  return row.hostsNode === 'object' && typeof row.host === 'string' && typeof row.object === 'object' && row.object !== null ? (row as ObjectRow) : undefined;
}

/** Runs `task` with a signal that the Cancel of `token` aborts. */
async function withAbort<T>(token: vscode.CancellationToken, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  const subscription = token.onCancellationRequested(() => abort.abort());
  try {
    return await task(abort.signal);
  } finally {
    subscription.dispose();
  }
}

