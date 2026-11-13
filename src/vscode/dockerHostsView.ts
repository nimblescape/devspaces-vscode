// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The view "Docker Hosts" (`devspaces.hosts`, docs/requirements.md R-ENG-008) below the repository view: the VM of
// Devspaces first, then each remote host of the list, with all containers, networks, images and volumes there (those of
// Devspaces with their purpose) and their management. A host is read when the user opens it in the view, and again at
// Refresh (R-SEC-004): the rows of a host keep what its last read found. Every UPDATE_INTERVAL_MS, while the view is
// visible and the window has the focus (or lost it less than FOCUS_PAUSE_MS ago), the view checks each open host with
// four short lists without sizes (readHostCheck) and reads it again only when they changed; it also shows the hosts
// again when the list, the Docker host of Devspaces or the state of the VM changed. A read never starts the VM: a
// stopped VM shows a row that starts it, and the update reads the state of the VM first and leaves a VM alone that does
// not run or that stops now (Windows, vmStopping). Opening a remote host and each action (with its progress
// notification) are flows of the user, so a password login may ask there (R-ENG-003); the update asks nothing, and
// after an update that failed on a remote host it uses only a login that is open, until a read of the user works. All
// Docker calls of the view run on the one shared shell of the host (extension.ts, `onShell`): one login per host for
// the reads, the checks and the actions, not one connection per call. A check mark shows the Docker host of Devspaces;
// a click on a host row only opens or closes it, because the Docker host of Devspaces is chosen only in the first row
// of the repository view. The objects of a devspace of this computer get the
// commands of the devspace (Stop, Delete…); every other object gets Stop (a running container), Start (a stopped
// container that is not of Devspaces) or Remove… (never with force), after one question, also for several selected
// rows. The rows come from dockerHostsModel.ts.
import * as vscode from 'vscode';
import { formatSize, type HostInventory, type HostObject, type HostObjectKind, type ObjectResult } from '../core/hosts/hostObjects';
import { errorMessage } from '../core/errors';
import { Actions } from '../core/messages';
import { isAbortError, type Logger } from '../core/ports';
import { withSshPrompts } from '../core/sshAskpass';
import type { VmState } from '../core/vm/vmState';
import {
  DOCKER_HOSTS_VIEW_ID,
  type BuildCacheRow,
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
  DockerHostsTexts,
} from './dockerHostsModel';
import { showInformationMessage, showWarningMessage } from './notifications';
import { withNotificationProgress } from './progress';
import { reportUri } from './reportPage';
import { colorTreeItem } from './rowColors';
import { FOCUS_PAUSE_MS } from './usagePage';

/** How often the view checks its open hosts (R-ENG-008). */
export const UPDATE_INTERVAL_MS = 30_000;

/** User-visible texts of the commands of the view (plain language). */
export const DockerHostsCommandTexts = {
  stopping: (name: string, host: string) => `Stopping the container ${name} on ${host}…`,
  stopped: (name: string) => `The container ${name} was stopped.`,
  stopFailed: (name: string, detail: string) => `The container ${name} could not be stopped: ${detail}`,
  starting: (name: string, host: string) => `Starting the container ${name} on ${host}…`,
  started: (name: string) => `The container ${name} was started.`,
  startFailed: (name: string, detail: string) => `The container ${name} could not be started: ${detail}`,
  pruneQuestion: (host: string) => `Remove the unused build cache on ${host}?`,
  pruneDetail: (unused: string) =>
    `Docker removes the records of its build cache that no build uses now. This frees about ${unused} on the disk of the host. The next builds there take longer, because they build those steps again. Devspaces builds its images again when it needs them.`,
  prune: 'Remove Unused Build Cache',
  pruning: (host: string) => `Removing the unused build cache on ${host}…`,
  pruned: (host: string) => `Removed the unused build cache on ${host}.`,
  pruneFailed: (host: string, detail: string) => `The build cache on ${host} could not be removed: ${detail}`,
  removeQuestion: (count: number, host: string) => (count === 1 ? `Remove 1 object from ${host}?` : `Remove ${count} objects from ${host}?`),
  removeDetail: (names: readonly string[], otherDevspace: boolean, notDevspaces = false) =>
    [
      listed(names),
      'Devspaces never removes with force: it keeps a running container, and every image, volume and network that a container uses. This cannot be undone.',
      ...(otherDevspace
        ? ['Some of them belong to a devspace that this computer does not know (for example of another computer). A workspace volume holds the changes of that devspace that were not pushed: they are lost with it.']
        : []),
      ...(notDevspaces ? ['Some of them do not belong to Devspaces: another program or a service of this host may need them, and a volume may hold its data.'] : []),
    ].join('\n\n'),
  remove: 'Remove',
  removing: (host: string) => `Removing objects from ${host}…`,
  nothingToRemove:
    'Remove… removes no object of a devspace of this computer, no running container, and no network of Docker itself. Delete the devspace with Delete…, which checks its Git changes first, and stop a running container first.',
  skipped: (count: number) =>
    count === 1
      ? ' 1 selected object was skipped: an object of a devspace of this computer, a running container, or a network of Docker itself.'
      : ` ${count} selected objects were skipped: objects of a devspace of this computer, running containers, or networks of Docker itself.`,
  removed: (removed: number, total: number, host: string) => (removed === total ? `Removed ${total === 1 ? '1 object' : `${total} objects`} from ${host}.` : `Removed ${removed} of ${total} objects from ${host}.`),
  left: (names: readonly string[]) => ` Left: ${listed(names)}. The log says why.`,
  readFailed: (host: string) => `The objects on ${host} could not be read.`,
  vmNotRunning: (state: VmState): string =>
    state.kind === 'stopped'
      ? 'The VM of Devspaces does not run now, so Devspaces did not change its objects. Start the VM to see them again.'
      : state.kind === 'notSetUp'
        ? 'The VM of Devspaces is not set up anymore, so Devspaces did not change its objects.'
        : `Devspaces cannot use the VM of Devspaces now (${state.kind === 'broken' ? 'it is broken' : 'its state is not known'}), so it did not change its objects.${state.detail !== undefined ? ` ${state.detail}` : ''}`,
};

/** The name of an object in the question of Remove…: an image with every tag that its removal removes. */
function removalName(object: HostObject): string {
  const others = object.kind === 'image' ? (object.tags ?? []).filter((tag) => tag !== object.name) : [];
  return others.length > 0 ? `${object.kind} ${object.name} (also ${others.join(', ')})` : `${object.kind} ${object.name}`;
}

/** At most five names, then the number of the others. */
function listed(names: readonly string[]): string {
  if (names.length <= 5) return names.join(', ');
  return `${names.slice(0, 5).join(', ')} and ${names.length - 5} more`;
}

export interface DockerHostsDeps {
  logger: Logger;
  showLog: () => void;
  /**
   * Whether the setting dockerHostsActions allows the actions of the view now (dockerHostsActionsAllowed). Without it,
   * the row of the stopped VM does not start the VM on a click. Missing: allowed (the tests).
   */
  actionsAllowed?: () => boolean;
  /** The VM of Devspaces on this platform (LIMA_HOST or WSL_HOST), undefined where there is none. */
  vmHost: string | undefined;
  /** The hosts of the list of Devspaces in its order, and the Docker host of Devspaces. */
  hostList: () => Promise<{ hosts: string[]; selected: string | undefined }>;
  /** The state of the VM, read without a start (vmState.ts). */
  vmState: () => Promise<VmState>;
  /**
   * Reads the objects of Devspaces on `host` (readHostInventory within an operation on it). `openLoginOnly`: only on a
   * login of the host that is open, else an AbortError (the update after a failed update).
   */
  read: (host: string, signal: AbortSignal, options?: { openLoginOnly?: boolean }) => Promise<HostInventory>;
  /**
   * The check of `host` (readHostCheck within an operation on it), with the same `openLoginOnly`. Without it, the view
   * reads a host only at an open and at Refresh.
   */
  check?: (host: string, signal: AbortSignal, options?: { openLoginOnly?: boolean }) => Promise<string>;
  /** Windows: the VM stops now for this window (WslKeeper.stopping), so the update makes no Docker call to it. */
  vmStopping?: () => boolean;
  /** Only for the tests: UPDATE_INTERVAL_MS, FOCUS_PAUSE_MS and the clock. */
  updateIntervalMs?: number;
  focusPauseMs?: number;
  now?: () => number;
  /** `docker container stop` of `object` on `host`. */
  stopContainer: (host: string, object: HostObject, signal: AbortSignal) => Promise<ObjectResult>;
  /** `docker container start` of `object` on `host`. */
  startContainer: (host: string, object: HostObject, signal: AbortSignal) => Promise<ObjectResult>;
  /** Removes the build cache that no build uses now on `host`. */
  pruneBuildCache: (host: string, signal: AbortSignal) => Promise<void>;
  /** Removes `objects` on `host`, never with force. */
  removeObjects: (host: string, objects: readonly HostObject[], signal: AbortSignal, onItem: (text: string) => void) => Promise<ObjectResult[]>;
  /** `host` leaves the list of Devspaces (RemoteDockerCommands.removeFromList). */
  removeFromList: (host: string) => Promise<void>;
}

/**
 * What the last read of a host found, with the check (readHostCheck) from right before it. `notRead`: the VM runs now,
 * but was stopped at the last read.
 */
type HostEntry = { kind: 'inventory'; inventory: HostInventory; check?: string } | { kind: 'stopped' } | { kind: 'notRead' } | { kind: 'failed'; detail: string };

/** The parts of the tree view of the provider that its update follows (DockerHostsView.watch). */
export type HostsTree = Pick<vscode.TreeView<HostsNode>, 'visible' | 'onDidExpandElement' | 'onDidCollapseElement' | 'onDidChangeVisibility'>;

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
  /** The host rows that are open in the tree view (watch): only they are updated. */
  private readonly expanded = new Set<string>();
  /**
   * The remote hosts whose update failed: their update uses only a login that is open, until a read of the user works,
   * so that a host that needs a password gets no login without questions every UPDATE_INTERVAL_MS.
   */
  private readonly openLoginOnly = new Set<string>();
  /** The hosts whose failed update is logged: once, until an update or a read of the user works. */
  private readonly updateFailed = new Set<string>();
  /** Ends the calls of the update when the view ends (an abort also ends the shared shell of the host). */
  private readonly updateAbort = new AbortController();
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private updating = false;
  private lastUpdate = Number.NEGATIVE_INFINITY;
  private treeVisible: () => boolean = () => false;
  /** When the window lost the focus; undefined while it has it. */
  private focusLostAt: number | undefined;

  constructor(private readonly deps: DockerHostsDeps) {}

  dispose(): void {
    this.disposed = true;
    if (this.updateTimer !== undefined) clearTimeout(this.updateTimer);
    this.updateTimer = undefined;
    this.updateAbort.abort();
    this.changeEmitter.dispose();
  }

  /**
   * Starts the update of the open hosts every UPDATE_INTERVAL_MS (R-ENG-008) for `tree`, the tree view of this provider:
   * it follows the host rows that the tree opens and closes, its visibility, and the focus of the window. A show of the
   * view, and the focus after a pause, update at once when the last update is older than UPDATE_INTERVAL_MS.
   */
  watch(tree: HostsTree): vscode.Disposable {
    this.treeVisible = () => tree.visible;
    this.focusLostAt = vscode.window.state.focused ? undefined : this.now();
    const subscriptions = [
      tree.onDidExpandElement(({ element }) => {
        if (element.hostsNode === 'host') this.expanded.add(element.host);
      }),
      tree.onDidCollapseElement(({ element }) => {
        if (element.hostsNode === 'host') this.expanded.delete(element.host);
      }),
      tree.onDidChangeVisibility(({ visible }) => {
        if (visible) this.updateSoon();
      }),
      vscode.window.onDidChangeWindowState(({ focused }) => {
        if (!focused) {
          this.focusLostAt ??= this.now();
          return;
        }
        this.focusLostAt = undefined;
        this.updateSoon();
      }),
    ];
    this.scheduleUpdate(this.interval());
    return {
      dispose: () => {
        for (const subscription of subscriptions) subscription.dispose();
        if (this.updateTimer !== undefined) clearTimeout(this.updateTimer);
        this.updateTimer = undefined;
      },
    };
  }

  getTreeItem(node: HostsNode): vscode.TreeItem {
    const look = rowLook(node, this.deps.actionsAllowed?.() ?? true);
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
    colorTreeItem(item, look.icon, look.color);
    if (look.command !== undefined) item.command = look.command;
    // A click on an object row opens its report with vscode.open, as the Explorer opens a file: VS Code passes the kind of
    // the click to the editor, so a click opens a preview tab (italic title) and a double click keeps it (R-ENG-010).
    if (node.hostsNode === 'object') item.command = { command: 'vscode.open', title: DockerHostsTexts.showReport, arguments: [reportUri(node)] };
    return item;
  }

  /** The object `kind` `id` of `host` as the last read of the host found it (for the report page), else undefined. */
  objectOf(host: string, kind: HostObjectKind, id: string): HostObject | undefined {
    const entry = this.entries.get(host);
    if (entry?.kind !== 'inventory') return undefined;
    const { inventory } = entry;
    const objects = kind === 'container' ? inventory.containers : kind === 'image' ? inventory.images : kind === 'volume' ? inventory.volumes : inventory.networks;
    return objects.find((object) => object.id === id);
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
    if (!(await this.vmRunsFor(host))) return;
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

  /** "Start" of a stopped container that is not of Devspaces (a service of the host that the user stopped before). */
  async startObject(argument: unknown): Promise<void> {
    const row = objectRowOf(argument);
    if (row === undefined || !objectActions(row).start) return;
    const { host, object } = row;
    if (!(await this.vmRunsFor(host))) return;
    try {
      const result = await withNotificationProgress({ title: DockerHostsCommandTexts.starting(object.name, host), cancellable: true }, (_progress, token) =>
        withAbort(token, (signal) => this.deps.startContainer(host, object, signal)),
      );
      if (result.outcome === 'started') this.inform(DockerHostsCommandTexts.started(object.name));
      else this.warnWithLog(DockerHostsCommandTexts.startFailed(object.name, result.detail ?? ''));
    } catch (error) {
      if (!isAbortError(error)) this.warnWithLog(DockerHostsCommandTexts.startFailed(object.name, errorMessage(error)));
    } finally {
      this.invalidate(host);
    }
  }

  /** "Remove Unused Build Cache…" of the build cache row of a host: after one question, `docker builder prune --all`. */
  async pruneBuildCache(argument: unknown): Promise<void> {
    const row = buildCacheRowOf(argument);
    if (row === undefined || row.cache.unusedBytes <= 0) return;
    const { host } = row;
    const answer = await showWarningMessage(DockerHostsCommandTexts.pruneQuestion(host), { modal: true, detail: DockerHostsCommandTexts.pruneDetail(formatSize(row.cache.unusedBytes)) }, DockerHostsCommandTexts.prune);
    if (answer !== DockerHostsCommandTexts.prune || !(await this.vmRunsFor(host))) return;
    this.deps.logger.info(`Remove Unused Build Cache… on ${host}.`);
    try {
      await withNotificationProgress({ title: DockerHostsCommandTexts.pruning(host), cancellable: true }, (_progress, token) => withAbort(token, (signal) => this.deps.pruneBuildCache(host, signal)));
      this.inform(DockerHostsCommandTexts.pruned(host));
    } catch (error) {
      if (isAbortError(error)) this.deps.logger.info(`Remove Unused Build Cache… on ${host} was cancelled.`);
      else this.warnWithLog(DockerHostsCommandTexts.pruneFailed(host, errorMessage(error)));
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
      objects.map(removalName),
      objects.some((object) => object.purpose === 'otherDevspace'),
      objects.some((object) => object.purpose === 'notDevspaces'),
    );
    const answer = await showWarningMessage(DockerHostsCommandTexts.removeQuestion(objects.length, host), { modal: true, detail }, DockerHostsCommandTexts.remove);
    if (answer !== DockerHostsCommandTexts.remove || !(await this.vmRunsFor(host))) return;
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

  /**
   * Whether an action on the objects of `host` may run: on the VM of Devspaces only while it runs now. Its rows may come
   * from a read before the VM stopped (for example by Stop the VM… in another window), and each Docker call to the VM
   * would start it. A VM that does not run shows its row of now again, and the action does not run.
   */
  private async vmRunsFor(host: string): Promise<boolean> {
    if (host !== this.deps.vmHost) return true;
    const state = await this.deps.vmState();
    if (state.kind === 'running') return true;
    this.deps.logger.info(`The VM of Devspaces does not run now (${state.kind}); the action on its objects did not run.`);
    this.inform(DockerHostsCommandTexts.vmNotRunning(state));
    this.entries.delete(host);
    this.changed();
    return false;
  }

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
        const groups: Array<GroupRow | BuildCacheRow> = [
          { hostsNode: 'group', host: row.host, group: 'container', objects: inventory.containers },
          { hostsNode: 'group', host: row.host, group: 'image', objects: inventory.images },
          { hostsNode: 'group', host: row.host, group: 'volume', objects: inventory.volumes },
          { hostsNode: 'group', host: row.host, group: 'network', objects: inventory.networks },
          { hostsNode: 'buildCache', host: row.host, cache: inventory.buildCache },
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
      // A flow of the user: a password login to a remote host may ask in VS Code. The check comes first, so that a change
      // during the read shows at the next update.
      entry = await vscode.window.withProgress({ location: { viewId: DOCKER_HOSTS_VIEW_ID } }, () =>
        withSshPrompts(async (): Promise<HostEntry> => {
          const check = await this.userCheck(row.host, abort.signal);
          const inventory = await this.deps.read(row.host, abort.signal);
          return { kind: 'inventory', inventory, ...(check !== undefined ? { check } : {}) };
        }, abort.signal),
      );
      this.openLoginOnly.delete(row.host);
      this.updateFailed.delete(row.host);
    } catch (error) {
      const detail = errorMessage(error);
      this.deps.logger.warn(`${DockerHostsCommandTexts.readFailed(row.host)} ${detail}`);
      entry = { kind: 'failed', detail: detail.split('\n')[0].slice(0, 300) };
    }
    this.entries.set(row.host, entry);
    return entry;
  }

  /**
   * The check before a read of the user (undefined without a check). It fails as the read would, on the same login, so a
   * failed check is the failed read: a login that the user cancelled does not ask a second time for the read.
   */
  private userCheck(host: string, signal: AbortSignal): Promise<string | undefined> {
    return this.deps.check === undefined ? Promise.resolve(undefined) : this.deps.check(host, signal);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The update every UPDATE_INTERVAL_MS (watch).

  private interval(): number {
    return this.deps.updateIntervalMs ?? UPDATE_INTERVAL_MS;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The window lost the focus FOCUS_PAUSE_MS ago or longer. */
  private paused(): boolean {
    return this.focusLostAt !== undefined && this.now() - this.focusLostAt >= (this.deps.focusPauseMs ?? FOCUS_PAUSE_MS);
  }

  private scheduleUpdate(delay: number): void {
    if (this.disposed) return;
    if (this.updateTimer !== undefined) clearTimeout(this.updateTimer);
    this.updateTimer = setTimeout(() => {
      this.updateTimer = undefined;
      void this.update();
    }, delay);
  }

  /** An update now, when the last one is older than UPDATE_INTERVAL_MS (the view shows again, the window got the focus). */
  private updateSoon(): void {
    if (this.updateTimer !== undefined && this.now() - this.lastUpdate >= this.interval()) this.scheduleUpdate(0);
  }

  /**
   * One update: the rows of the hosts, then each open host that the view has read (in parallel, each on its own shared
   * shell). Nothing while the view is hidden or the window pauses. The next update comes UPDATE_INTERVAL_MS after its end.
   */
  private async update(): Promise<void> {
    if (this.disposed || this.updating) return;
    if (!this.treeVisible() || this.paused() || this.deps.check === undefined) {
      this.scheduleUpdate(this.interval());
      return;
    }
    this.updating = true;
    this.lastUpdate = this.now();
    try {
      const vmState = await this.updateHostRows();
      await Promise.all([...this.expanded].map((host) => this.updateHost(host, vmState)));
    } catch (error) {
      this.deps.logger.warn(`The update of the view Docker Hosts failed: ${errorMessage(error)}`);
    } finally {
      this.updating = false;
      this.scheduleUpdate(this.interval());
    }
  }

  /**
   * The rows of the hosts: another list, Docker host of Devspaces, or state of the VM (its kind, memory and CPUs, not the
   * size of its disk, which grows while it runs) shows the hosts again. Returns the state of the VM of now.
   */
  private async updateHostRows(): Promise<VmState | undefined> {
    const vmState = this.deps.vmHost === undefined ? undefined : await this.deps.vmState();
    let list: { hosts: string[]; selected: string | undefined };
    try {
      list = await this.deps.hostList();
    } catch {
      // hostRows logs it at the next show.
      return vmState;
    }
    const key = (rows: readonly HostRow[]): string => JSON.stringify(rows.map((row) => [row.host, row.selected, row.vmState?.kind, row.vmState?.memoryGiB, row.vmState?.cpus]));
    if (key(hostRows({ vmHost: this.deps.vmHost, vmState, hosts: list.hosts, selected: list.selected })) !== key([...this.rows.values()])) this.changed();
    return vmState;
  }

  /**
   * The update of the open host `host`: its check, and its read when the check differs from the one of its last read (or
   * when the last read failed, or found the VM stopped). Never a Docker call to a VM that does not run or that stops now.
   * A read of the user, a Refresh or an action in the meantime wins: the result of the update is then dropped.
   */
  private async updateHost(host: string, vmState: VmState | undefined): Promise<void> {
    const row = this.rows.get(host);
    let before = this.entries.get(host);
    const check = this.deps.check;
    if (row === undefined || before === undefined || check === undefined || this.reads.has(host) || this.disposed) return;
    if (row.vm && (vmState?.kind !== 'running' || this.deps.vmStopping?.() === true)) return;
    if (before.kind === 'stopped') {
      // The VM runs again: what followVm would set at the next show, so that this show does not drop the read below.
      before = { kind: 'notRead' };
      this.entries.set(host, before);
    }
    const options = this.openLoginOnly.has(host) ? { openLoginOnly: true } : {};
    try {
      const now = await check(host, this.updateAbort.signal, options);
      if (this.entries.get(host) !== before || this.reads.has(host) || this.disposed) return;
      if (before.kind === 'inventory' && before.check === now) {
        this.updateFailed.delete(host);
        return;
      }
      const why = before.kind === 'inventory' ? 'its objects changed' : before.kind === 'failed' ? 'its last read failed' : 'the VM runs again';
      this.deps.logger.info(`The view Docker Hosts reads ${host} again: ${why}.`);
      const inventory = await this.deps.read(host, this.updateAbort.signal, options);
      if (this.entries.get(host) !== before || this.disposed) return;
      this.entries.set(host, { kind: 'inventory', inventory, check: now });
      this.updateFailed.delete(host);
      this.changeEmitter.fire(this.rows.get(host));
    } catch (error) {
      if (this.disposed) return;
      // A remote host may need a password: no new login without questions every UPDATE_INTERVAL_MS. A login to the VM
      // never asks.
      if (!row.vm) this.openLoginOnly.add(host);
      if (this.updateFailed.has(host)) return;
      this.updateFailed.add(host);
      this.deps.logger.info(
        `The update of the view Docker Hosts could not read ${host}${row.vm ? '' : '; it uses only a login of the host that is open until the next read by an open or Refresh'}: ${errorMessage(error)}`,
      );
    }
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

/** The build cache row of a command argument, else undefined. */
function buildCacheRowOf(argument: unknown): BuildCacheRow | undefined {
  if (typeof argument !== 'object' || argument === null) return undefined;
  const row = argument as Partial<BuildCacheRow>;
  return row.hostsNode === 'buildCache' && typeof row.host === 'string' && typeof row.cache === 'object' && row.cache !== null && typeof row.cache.unusedBytes === 'number' ? (row as BuildCacheRow) : undefined;
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

