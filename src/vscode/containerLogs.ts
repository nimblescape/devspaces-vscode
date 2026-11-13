// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Show Log of a container of the view Docker Hosts (docs/requirements.md R-ENG-008, R-ENG-010): the last lines of its
// log (core/hosts/monitorLog.ts) as a read-only document of VS Code, from the menu of a container row, from the report
// of a container, and from the report of the volume of the Monitor (Show Log of the Monitor). Only while the setting
// devspaces.allowContainerLogs is on, and never on a VM that does not run, because a read would start it. The document
// of a container has the address of its host and its name, so a second Show Log of it shows the newer log in its tab.
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import { isLogContainer, isNoLogDriverError } from '../core/hosts/monitorLog';
import { isAbortError, type Logger } from '../core/ports';
import { REMOTE_MONITOR_CONTAINER } from '../core/remoteMonitor/protocol';
import { withSshPrompts } from '../core/sshAskpass';
import type { VmState } from '../core/vm/vmState';
import { showInformationMessage, showWarningMessage } from './notifications';
import { reportTargetOfArgument } from './reportPageModel';

/** The scheme of the read-only documents of Show Log. */
export const CONTAINER_LOG_SCHEME = 'devspaces-container-log';

/** The log of one container: its host, the container for `docker logs` (isLogContainer), and its name. */
export interface ContainerLog {
  host: string;
  /** The full ID of the container, or the name of the Monitor. */
  container: string;
  /** The name of the container, for the title of the document and the messages. */
  name: string;
  /** The container of the Monitor: the messages name the Monitor. */
  monitor: boolean;
}

/** The log of the Monitor of `host` (Show Log of the Monitor), by the name of its container. */
export function monitorLogOf(host: string): ContainerLog {
  return { host, container: REMOTE_MONITOR_CONTAINER, name: REMOTE_MONITOR_CONTAINER, monitor: true };
}

/** User-visible texts of Show Log (plain language). */
export const ContainerLogTexts = {
  off: 'Show Log is off: turn on the setting devspaces.allowContainerLogs to read the log of a container.',
  vmNotRunning: 'The VM of Devspaces does not run. Show Log reads nothing while it is stopped, because a read would start it.',
  subject: (log: ContainerLog) => (log.monitor ? 'the Monitor' : `the container ${log.name}`),
  empty: (log: ContainerLog) => (log.monitor ? 'The Monitor wrote nothing to its log yet.' : `The container ${log.name} wrote nothing to its log yet.`),
  failed: (log: ContainerLog, detail: string) => `The log of ${ContainerLogTexts.subject(log)} could not be read: ${detail}`,
  noLog: (log: ContainerLog) => `Docker keeps no log of ${ContainerLogTexts.subject(log)} that it can give: its log driver does not support reading (for example the driver none).`,
};

export interface ContainerLogsDeps {
  logger: Logger;
  /** Whether the setting devspaces.allowContainerLogs is on. */
  allowed(): boolean;
  /** The VM of Devspaces on this platform (LIMA_HOST or WSL_HOST), undefined where there is none. */
  vmHost: string | undefined;
  /** The state of the VM, read without a start (vmState.ts). */
  vmState(): Promise<VmState>;
  /** The last lines of the log of `container` on `host`, with times in `timeZone` (readContainerLog on the shared shell of the host). */
  read(host: string, container: string, timeZone: string): Promise<string>;
  /** The time zone of this computer, in which the log gives times. */
  timeZone(): string;
}

/** Show Log of this window: the provider of its documents, registered at the first Show Log. */
export class ContainerLogs implements vscode.Disposable {
  private readonly texts = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private provider: vscode.Disposable | undefined;
  private disposed = false;

  constructor(private readonly deps: ContainerLogsDeps) {}

  /** Show Log of the menu of a container row of the view. */
  async showRow(argument: unknown): Promise<void> {
    const target = reportTargetOfArgument(argument);
    if (target === undefined || target.object.kind !== 'container') return;
    const { host, object } = target;
    if (!isLogContainer(object.id)) {
      this.deps.logger.warn(`Show Log of ${object.name} on ${host} is not run: the row has no full ID of a container.`);
      return;
    }
    await this.show({ host, container: object.id, name: object.name, monitor: object.purpose === 'monitor' });
  }

  /** Show Log of `log`: the last lines of the log, as a read-only document in a tab of its own. */
  async show(log: ContainerLog): Promise<void> {
    if (this.disposed) return;
    // Off: Devspaces runs no `docker logs`, on any host (also not on the shared shell of a host, which no pipe filters).
    if (!this.deps.allowed()) {
      this.deps.logger.info(`Show Log of ${log.name} on ${log.host} is not run: the setting devspaces.allowContainerLogs is off.`);
      this.inform(ContainerLogTexts.off);
      return;
    }
    if (log.host === this.deps.vmHost && (await this.deps.vmState()).kind !== 'running') {
      this.deps.logger.info(`Show Log of ${log.name} on the VM of Devspaces is not run: the VM does not run.`);
      this.inform(ContainerLogTexts.vmNotRunning);
      return;
    }
    let text: string;
    try {
      text = await withSshPrompts(() => this.deps.read(log.host, log.container, this.deps.timeZone()));
    } catch (error) {
      if (isAbortError(error)) return;
      const detail = errorMessage(error);
      this.deps.logger.warn(`The log of ${ContainerLogTexts.subject(log)} on ${log.host} could not be read: ${detail}`);
      const message = isNoLogDriverError(detail) ? ContainerLogTexts.noLog(log) : ContainerLogTexts.failed(log, detail.split('\n')[0].slice(0, 300));
      showWarningMessage(message).then(undefined, (shown: unknown) => this.deps.logger.error('Could not show the message.', shown));
      return;
    }
    if (this.disposed) return;
    this.provider ??= vscode.workspace.registerTextDocumentContentProvider(CONTAINER_LOG_SCHEME, {
      onDidChange: this.changed.event,
      provideTextDocumentContent: (uri) => this.texts.get(uri.toString()) ?? '',
    });
    const uri = vscode.Uri.from({ scheme: CONTAINER_LOG_SCHEME, path: `/${log.host}/${log.name}.log` });
    this.texts.set(uri.toString(), text.trim() === '' ? ContainerLogTexts.empty(log) : `${text}\n`);
    this.changed.fire(uri);
    try {
      const opened = await vscode.workspace.openTextDocument(uri);
      // The colors of a log, where VS Code has the language `log`; without it the plain text.
      const document = await vscode.languages.setTextDocumentLanguage(opened, 'log').then(undefined, () => opened);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      this.deps.logger.warn(`The log of ${ContainerLogTexts.subject(log)} on ${log.host} could not be opened: ${errorMessage(error)}`);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.provider?.dispose();
    this.provider = undefined;
    this.changed.dispose();
    this.texts.clear();
  }

  private inform(message: string): void {
    showInformationMessage(message).then(undefined, (error: unknown) => this.deps.logger.error('Could not show the message.', error));
  }
}
