// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The rows of the view "Docker Hosts" (docs/requirements.md R-ENG-008, R-VM-010), below the repository view: the VM of
// Devspaces first, then each remote host of the list of Devspaces; under each host all its containers, networks,
// images and volumes (src/core/hosts/hostObjects.ts), those of Devspaces with their purpose, with their sizes, and its
// build cache. The texts, icons, context values and
// commands of each row, without `vscode` (dockerHostsView.ts renders them).
import { describeDockerHost, LIMA_HOST, WSL_HOST } from '../core/docker/dockerHost';
import { formatSize, isEarlierHelperBuild, totalSize, type BuildCacheSummary, type HostObject, type HostObjectKind, type HostObjectPurpose } from '../core/hosts/hostObjects';
import type { VmState } from '../core/vm/vmState';
import { Commands } from './commands';
import type { RowColor } from './rowColors';
import { MonitorIcons } from './treeModel';

export const DOCKER_HOSTS_VIEW_ID = 'devspaces.hosts';

/** A host: the VM of Devspaces (`vm`) or a remote host of the list. `selected`: the Docker host of Devspaces. */
export interface HostRow {
  hostsNode: 'host';
  host: string;
  vm: boolean;
  selected: boolean;
  /** The state of the VM, read without a start (VM row only). */
  vmState?: VmState;
}

/** The containers, the networks, the images or the volumes of a host. */
export interface GroupRow {
  hostsNode: 'group';
  host: string;
  group: HostObjectKind;
  objects: HostObject[];
}

/** The build cache of a host: its records and their sizes, without a row for each record. */
export interface BuildCacheRow {
  hostsNode: 'buildCache';
  host: string;
  cache: BuildCacheSummary;
}

/**
 * A container, an image or a volume. `devspaceId` only for an object of a devspace of this computer: the commands of the
 * devspace (Stop, Delete…) take the row as their argument, as a row of the repository view (parseCommandArgument).
 */
export interface ObjectRow {
  hostsNode: 'object';
  host: string;
  object: HostObject;
  devspaceId?: string;
}

/** A row with a note: a stopped VM, a host that could not be read, a host that was not read yet. */
export interface MessageRow {
  hostsNode: 'message';
  host: string;
  message: 'vmStopped' | 'vmNotRead' | 'readFailed' | 'vmUnknown';
  detail?: string;
}

export type HostsNode = HostRow | GroupRow | BuildCacheRow | ObjectRow | MessageRow;

/** What a row looks like (dockerHostsView.ts makes a TreeItem of it). */
export interface RowLook {
  id: string;
  label: string;
  description?: string;
  tooltip: string;
  contextValue: string;
  /** A codicon or an icon of Devspaces (MonitorIcons). */
  icon: string;
  /** The color of the name and of the icon (rowColors.ts); undefined: the colors of the theme. */
  color?: RowColor;
  collapsible: 'none' | 'collapsed' | 'expanded';
  command?: { command: string; title: string; arguments?: unknown[] };
}

/** User-visible texts of the view (plain language). */
export const DockerHostsTexts = {
  showReport: 'Show Report',
  /** As the title of the repository view names the VM (DockerHostTexts.vmTitle): it runs on this computer. */
  vmName: 'Local VM of Devspaces',
  vmState: (state: VmState | undefined): string => {
    switch (state?.kind) {
      case 'notSetUp':
        return 'Not set up';
      case 'stopped':
        return 'Stopped';
      case 'running':
        return 'Running';
      case 'broken':
        return 'Broken';
      default:
        return 'State unknown';
    }
  },
  remoteHost: 'Remote host',
  selected: 'Docker host of Devspaces: the repository view and Start use it.',
  chooseInRepositoryView: 'The first row of the repository view chooses the Docker host of Devspaces.',
  setUpInMenu: 'The menu of this row sets up the VM of Devspaces with Docker Engine.',
  setUpInRepositoryView: 'Set Up Docker for Devspaces in the repository view sets up the VM of Devspaces with Docker Engine.',
  vmTooltip: (host: string, state: VmState | undefined): string[] => {
    const lines = [`${host}: the VM of Devspaces with Docker Engine on this computer. ${DockerHostsTexts.vmState(state)}.`];
    const facts: string[] = [];
    if (state?.memoryGiB !== undefined) facts.push(`${state.memoryGiB} GiB of memory`);
    if (state?.cpus !== undefined) facts.push(`${state.cpus} CPUs`);
    if (state?.diskBytes !== undefined) facts.push(`its disk takes ${formatSize(state.diskBytes)} on this computer`);
    if (facts.length > 0) lines.push(`${capitalized(facts.join(', '))}.`);
    if (state?.detail !== undefined) lines.push(state.detail);
    if (state?.kind === 'stopped') lines.push('It starts with the next Start of a devspace, or with Start the VM. Devspaces does not start it to read it.');
    if (state?.kind === 'running') lines.push('It powers itself off two minutes after nothing runs there and nothing is connected to its Docker.');
    return lines;
  },
  remoteTooltip: (host: string) => `${host}: Docker on another computer, which Devspaces reaches over SSH. Its objects are read only when you open it here or click Refresh.`,
  groups: { container: 'Containers', network: 'Networks', image: 'Images', volume: 'Volumes' } satisfies Record<HostObjectKind, string> as Record<HostObjectKind, string>,
  buildCache: 'Build cache',
  buildCacheTooltip: (cache: BuildCacheSummary): string =>
    `The cache of the builds of Docker (BuildKit) on this host: ${cache.records} record${cache.records === 1 ? '' : 's'}, ${formatSize(cache.bytes)}. ${formatSize(cache.unusedBytes)} of it can be freed: the records that no build uses now and that share their data with no image. Remove Unused Build Cache… removes the records that no build uses, after one question; the next builds take longer.`,
  none: 'none',
  vmStopped: 'Start the VM to see its containers, images, volumes and networks',
  vmStoppedTooltip: 'The VM of Devspaces is stopped. Devspaces does not start it to read it. Click to start it.',
  vmStoppedReadOnly: 'The VM is stopped: its containers, images, volumes and networks show while it runs',
  vmStoppedReadOnlyTooltip: 'The VM of Devspaces is stopped. Devspaces does not start it to read it. It starts with a devspace there.',
  vmNotRead: 'Click to read the containers, images, volumes and networks',
  vmNotReadTooltip: 'The VM of Devspaces runs now. Click to read what is in it.',
  vmUnknown: 'The state of the VM is not known',
  readFailed: 'Could not be read',
  readFailedTooltip: (detail: string) => `${detail}\n\nClick to open the log of Devspaces. Refresh reads the host again.`,
  purpose: (object: HostObject): string => {
    const role = object.role !== undefined ? ` · ${object.role}` : '';
    switch (object.purpose) {
      case 'notDevspaces':
        return `${PURPOSE_WORDS.notDevspaces}${role}`;
      case 'devspace':
        return `${object.repository ?? 'devspace'}${role}`;
      case 'otherDevspace':
        return `${object.repository ?? 'devspace'} (not of this computer)${role}`;
      case 'sharedVolume':
        return `shared${role}`;
      default:
        return PURPOSE_WORDS[object.purpose];
    }
  },
  purposeTooltip: (purpose: HostObjectPurpose): string => PURPOSE_TOOLTIPS[purpose],
  /** The tooltip line of an earlier build of the helper image (isEarlierHelperBuild). */
  earlierHelperBuild:
    'A helper image without its tag devspaces-worker:<hash>: usually an earlier build, whose tag a newer build took. Docker keeps no record of the tag that an image had. Docker does not remove an image while a container that was created from it exists, also a stopped one. The Monitor removes it in its next background run when no container uses it.',
  /** Why the row has its color: the view shows an inactive object dimmed. */
  activeTooltip: (object: HostObject): string =>
    object.kind === 'container'
      ? object.active === true
        ? 'Active: it runs.'
        : 'Inactive: it does not run.'
      : object.active === true
        ? 'Active: a running container uses it.'
        : 'Inactive: no running container uses it.',
  containerState: (state: string | undefined): string | undefined =>
    state === undefined ? undefined : state === 'running' ? 'Running' : state === 'exited' || state === 'created' ? 'Stopped' : capitalized(state),
} as const;

const PURPOSE_WORDS: Readonly<Record<Exclude<HostObjectPurpose, 'devspace' | 'otherDevspace' | 'sharedVolume'>, string>> = {
  monitor: 'Monitor',
  worker: 'worker',
  batchHelper: 'batch helper',
  buildContainer: 'build of the helper image',
  helperImage: 'helper image',
  buildImage: 'build image',
  helperBaseImage: 'base image of the helper image',
  baseImage: 'base image of a devspace',
  other: 'of Devspaces',
  notDevspaces: 'not of Devspaces',
};

const PURPOSE_TOOLTIPS: Readonly<Record<HostObjectPurpose, string>> = {
  devspace: 'Part of a devspace of this computer. Stop and Delete… act on the whole devspace: Delete… checks the Git changes first.',
  otherDevspace:
    'Part of a devspace that this computer does not know, for example of another computer or of another VS Code profile. Remove… removes only this object; a workspace volume holds the changes that were not pushed.',
  monitor: 'The Monitor of the engine: it stops idle devspaces and updates the images in the background. It starts again when a window needs it.',
  worker: 'A worker of a window: it runs the Docker work of Devspaces on the engine. It starts again when a window needs it.',
  batchHelper: 'A batch helper of a worker or of the Monitor, for one step of its work.',
  buildContainer: 'A build of the helper image in a container of the build image.',
  helperImage: 'The image of the workers and of the Monitor. Devspaces builds it again when it needs it.',
  buildImage: 'The image that builds the helper image (docker/buildx-bin, pinned by Devspaces). Devspaces pulls it again when it needs it.',
  helperBaseImage: 'The image that the Dockerfile of the helper image starts from. Devspaces pulls it again before the next build of the helper image.',
  baseImage: 'An image that the configuration of a devspace of this computer names. The next build of the devspace pulls it again.',
  sharedVolume: 'A volume that the devspaces of the engine share. Devspaces creates it again when it needs it.',
  other: 'An object with a label or a name of Devspaces.',
  notDevspaces:
    'An object that does not belong to Devspaces, for example of a service of this host or of another program. Stop frees the CPU and the memory of a container, and Start starts it again. Remove… asks first and never uses force.',
};

function capitalized(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** True for a running container (also a paused or restarting one): Docker removes it only after a stop. */
export function isRunningContainer(object: HostObject): boolean {
  return object.kind === 'container' && (object.state === 'running' || object.state === 'paused' || object.state === 'restarting');
}

/**
 * The actions of an object row: the devspace actions for an object of a devspace of this computer (Rebuild only on its
 * dev container); else Stop for a
 * running container, Start for a stopped container that is not of Devspaces (Devspaces starts its own helpers itself),
 * and Remove… for every object that does not run, but never for a network of Docker itself.
 */
export function objectActions(row: ObjectRow): { stopDevspace: boolean; rebuildDevspace: boolean; deleteDevspace: boolean; stop: boolean; start: boolean; remove: boolean } {
  const { object } = row;
  if (row.devspaceId !== undefined) {
    // Rebuild only on the dev container of the devspace: the row that the devspace runs in.
    const rebuildDevspace = object.kind === 'container' && object.role === 'dev container';
    return { stopDevspace: object.kind === 'container' && isRunningContainer(object), rebuildDevspace, deleteDevspace: true, stop: false, start: false, remove: false };
  }
  const running = isRunningContainer(object);
  const start = object.kind === 'container' && object.purpose === 'notDevspaces' && (object.state === 'exited' || object.state === 'created');
  return { stopDevspace: false, rebuildDevspace: false, deleteDevspace: false, stop: running, start, remove: !running && object.builtIn !== true };
}

/** The row of a host. `actions`: the setting dockerHostsActions allows the actions of the view (the tooltip of Set Up). */
export function hostRowLook(row: HostRow, actions = true): RowLook {
  const flags = ['hostsHost', row.vm ? 'vm' : 'remote'];
  let description: string;
  let collapsible: RowLook['collapsible'] = 'collapsed';
  const tooltip: string[] = [];
  if (row.vm) {
    const kind = row.vmState?.kind;
    description = `${DockerHostsTexts.vmName} · ${DockerHostsTexts.vmState(row.vmState)}`;
    tooltip.push(...DockerHostsTexts.vmTooltip(row.host, row.vmState));
    if (kind === 'notSetUp') {
      flags.push('vmNotSetUp');
      collapsible = 'none';
    } else {
      flags.push('vmSetUp', 'engine');
      // A VM whose state is not known gets Start too: its test starts it when it can.
      if (kind === 'running') flags.push('vmCanStop');
      else if (kind === 'stopped' || kind === 'unknown') flags.push('vmCanStart');
    }
  } else {
    description = DockerHostsTexts.remoteHost;
    tooltip.push(DockerHostsTexts.remoteTooltip(row.host));
    flags.push('engine');
  }
  if (row.selected) {
    flags.push('selected');
    tooltip.push(DockerHostsTexts.selected);
  } else if (row.vm && row.vmState?.kind === 'notSetUp') {
    tooltip.push(actions ? DockerHostsTexts.setUpInMenu : DockerHostsTexts.setUpInRepositoryView);
  } else {
    tooltip.push(DockerHostsTexts.chooseInRepositoryView);
  }
  return {
    id: `host:${row.host}`,
    label: row.host,
    description,
    tooltip: tooltip.join('\n'),
    contextValue: flags.join(';'),
    // The check mark names the Docker host of Devspaces. A click only opens or closes the row: the Docker host of
    // Devspaces is chosen only in the first row of the repository view.
    icon: row.selected ? 'check' : row.vm ? 'vm' : MonitorIcons.remote,
    collapsible,
  };
}

/** The row of a group: its number of objects and the sum of their sizes. */
export function groupRowLook(row: GroupRow): RowLook {
  const { bytes, complete } = totalSize(row.objects);
  const parts: string[] = [];
  if (row.objects.length === 0) parts.push(DockerHostsTexts.none);
  else {
    parts.push(String(row.objects.length));
    if (bytes > 0 || complete) parts.push(formatSize(bytes));
  }
  const order = `${DockerHostsTexts.groups[row.group]} on ${describeDockerHost(row.host)}: those of Devspaces first, then the others.`;
  const tooltip =
    row.group === 'image' ? `${order} The size of the group counts the bytes that only these images use; an image row shows its whole size, with the layers that it shares with other images.` : order;
  return {
    id: `group:${row.host}:${row.group}`,
    label: DockerHostsTexts.groups[row.group],
    description: parts.join(' · '),
    tooltip,
    contextValue: 'hostsGroup',
    icon: GROUP_ICONS[row.group],
    collapsible: row.objects.length === 0 ? 'none' : 'expanded',
  };
}

const GROUP_ICONS: Readonly<Record<HostObjectKind, string>> = { container: 'package', network: 'type-hierarchy', image: 'layers', volume: 'database' };

/** The row of the build cache: the number of its records, their size, and what no build uses now. */
export function buildCacheRowLook(row: BuildCacheRow): RowLook {
  const { cache } = row;
  const parts = cache.records === 0 ? [DockerHostsTexts.none] : [String(cache.records), formatSize(cache.bytes)];
  if (cache.unusedBytes > 0) parts.push(`${formatSize(cache.unusedBytes)} can be freed`);
  return {
    id: `buildCache:${row.host}`,
    label: DockerHostsTexts.buildCache,
    description: parts.join(' · '),
    tooltip: DockerHostsTexts.buildCacheTooltip(cache),
    contextValue: cache.unusedBytes > 0 ? 'hostsBuildCache;canPrune' : 'hostsBuildCache',
    icon: 'archive',
    collapsible: 'none',
  };
}

/** The row of an object: its name, its purpose, its state and its size; its context value names its actions. */
export function objectRowLook(row: ObjectRow): RowLook {
  const { object } = row;
  const actions = objectActions(row);
  const flags = ['hostsObject', object.kind, object.purpose];
  if (actions.stopDevspace) flags.push('canStopDevspace');
  if (actions.rebuildDevspace) flags.push('canRebuildDevspace');
  if (actions.deleteDevspace) flags.push('canDeleteDevspace');
  if (actions.stop) flags.push('canStop');
  if (actions.start) flags.push('canStart');
  if (actions.remove) flags.push('canRemove');
  const parts = [DockerHostsTexts.purpose(object)];
  const state = DockerHostsTexts.containerState(object.state);
  if (state !== undefined) parts.push(state);
  if (object.sizeBytes !== undefined && object.kind !== 'container') parts.push(formatSize(object.sizeBytes));
  if (object.kind === 'network') {
    if (object.driver !== undefined) parts.push(object.driver);
    if (object.usedBy !== undefined && object.usedBy > 0) parts.push(`${object.usedBy} container${object.usedBy === 1 ? '' : 's'}`);
  }
  const tooltip = [`${capitalized(object.kind)} ${object.name}`, object.builtIn === true ? 'A network that Docker creates itself (bridge, host and none on every engine; ingress and docker_gwbridge on a node of Docker Swarm). Devspaces does not remove it.' : DockerHostsTexts.purposeTooltip(object.purpose)];
  if (isEarlierHelperBuild(object)) tooltip.push(DockerHostsTexts.earlierHelperBuild);
  if (object.status !== undefined) tooltip.push(`Status: ${object.status}`);
  // Every tag when the name is not the only one: several tags, or a name that is not a tag (an earlier build).
  const tags = object.tags ?? [];
  if (object.kind === 'image' && (tags.length > 1 || (tags.length === 1 && tags[0] !== object.name))) tooltip.push(`Tags: ${tags.join(', ')}`);
  if (object.sizeBytes !== undefined) tooltip.push(`Size: ${formatSize(object.sizeBytes)}${object.uniqueBytes !== undefined ? ` (${formatSize(object.uniqueBytes)} only for this image)` : ''}`);
  if (object.usedBy !== undefined && object.kind !== 'container') tooltip.push(`Used by ${object.usedBy} container${object.usedBy === 1 ? '' : 's'}`);
  if (object.kind !== 'volume') tooltip.push(`ID: ${object.id}`);
  tooltip.push(DockerHostsTexts.activeTooltip(object));
  const color = objectColor(object);
  return {
    id: `object:${row.host}:${object.kind}:${object.id}`,
    label: object.name,
    description: parts.join(' · '),
    tooltip: tooltip.join('\n'),
    contextValue: flags.join(';'),
    icon: object.kind === 'container' ? (isRunningContainer(object) ? 'vm-running' : 'vm-outline') : object.kind === 'image' ? 'file-binary' : object.kind === 'network' ? 'plug' : 'database',
    ...(color !== undefined ? { color } : {}),
    // A click opens its report in the editor (R-ENG-010): the view gives the row the command vscode.open with the address
    // of the report (dockerHostsView.ts), so the editor of VS Code opens it as a preview tab, as a file of the Explorer.
    collapsible: 'none',
  };
}

/**
 * The color of an object row: violet for an object that is not of Devspaces, dimmed when it is not active; gray for an
 * object of Devspaces that is not active; the colors of the theme for an active object of Devspaces.
 */
export function objectColor(object: HostObject): RowColor | undefined {
  const active = object.active === true;
  if (object.purpose === 'notDevspaces') return active ? 'notDevspaces' : 'notDevspacesInactive';
  return active ? undefined : 'inactive';
}

/**
 * The row of a note. `actions`: the setting dockerHostsActions allows the actions of the view; without them, the row of
 * the stopped VM only says that it is stopped, and a click on it starts nothing.
 */
export function messageRowLook(row: MessageRow, actions = true): RowLook {
  const id = `message:${row.host}:${row.message}`;
  switch (row.message) {
    case 'vmStopped':
      if (!actions) return { id, label: DockerHostsTexts.vmStoppedReadOnly, tooltip: DockerHostsTexts.vmStoppedReadOnlyTooltip, contextValue: 'hostsMessage', icon: 'debug-pause', collapsible: 'none' };
      return { id, label: DockerHostsTexts.vmStopped, tooltip: DockerHostsTexts.vmStoppedTooltip, contextValue: 'hostsMessage', icon: 'play', collapsible: 'none', command: { command: Commands.startVm, title: 'Start the VM', arguments: [row] } };
    case 'vmNotRead':
      return { id, label: DockerHostsTexts.vmNotRead, tooltip: DockerHostsTexts.vmNotReadTooltip, contextValue: 'hostsMessage', icon: 'refresh', collapsible: 'none', command: { command: Commands.refreshDockerHosts, title: 'Refresh', arguments: [{ hostsNode: 'host', host: row.host }] } };
    case 'vmUnknown':
      return { id, label: DockerHostsTexts.vmUnknown, description: row.detail, tooltip: row.detail ?? DockerHostsTexts.vmUnknown, contextValue: 'hostsMessage', icon: 'question', collapsible: 'none' };
    case 'readFailed':
      return {
        id,
        label: DockerHostsTexts.readFailed,
        description: row.detail,
        tooltip: DockerHostsTexts.readFailedTooltip(row.detail ?? ''),
        contextValue: 'hostsMessage',
        icon: 'error',
        collapsible: 'none',
        command: { command: Commands.showLog, title: 'Show Log' },
      };
  }
}

/** The look of any row. `actions`: the setting dockerHostsActions allows the actions of the view (messageRowLook). */
export function rowLook(node: HostsNode, actions = true): RowLook {
  switch (node.hostsNode) {
    case 'host':
      return hostRowLook(node, actions);
    case 'group':
      return groupRowLook(node);
    case 'buildCache':
      return buildCacheRowLook(node);
    case 'object':
      return objectRowLook(node);
    case 'message':
      return messageRowLook(node, actions);
  }
}

/**
 * The host rows: the VM of Devspaces first (also when it is not set up), then the other hosts of the list, in its
 * order. `vmHost`: the VM of Devspaces on this platform, undefined where there is none.
 */
export function hostRows(input: { vmHost: string | undefined; vmState: VmState | undefined; hosts: readonly string[]; selected: string | undefined }): HostRow[] {
  const rows: HostRow[] = [];
  if (input.vmHost !== undefined) {
    rows.push({ hostsNode: 'host', host: input.vmHost, vm: true, selected: input.selected === input.vmHost, ...(input.vmState !== undefined ? { vmState: input.vmState } : {}) });
  }
  for (const host of input.hosts) {
    if (host === input.vmHost || host === LIMA_HOST || host === WSL_HOST) continue;
    rows.push({ hostsNode: 'host', host, vm: false, selected: input.selected === host });
  }
  return rows;
}

/** The rows of the objects of a group, each with the ID of its devspace when it is a devspace of this computer. */
export function objectRows(host: string, objects: readonly HostObject[]): ObjectRow[] {
  return objects.map((object) => ({ hostsNode: 'object', host, object, ...(object.purpose === 'devspace' && object.devspaceId !== undefined ? { devspaceId: object.devspaceId } : {}) }));
}

/** The host of a command argument that is a host row of the view (`{ hostsNode: 'host', host }`), else undefined. */
export function hostOfArgument(argument: unknown): string | undefined {
  if (typeof argument !== 'object' || argument === null) return undefined;
  const value = argument as { hostsNode?: unknown; host?: unknown };
  return value.hostsNode === 'host' && typeof value.host === 'string' && value.host !== '' ? value.host : undefined;
}

/** The host of any row of the view, else undefined. */
export function hostOfNode(argument: unknown): string | undefined {
  if (typeof argument !== 'object' || argument === null) return undefined;
  const value = argument as { hostsNode?: unknown; host?: unknown };
  return typeof value.hostsNode === 'string' && typeof value.host === 'string' && value.host !== '' ? value.host : undefined;
}
