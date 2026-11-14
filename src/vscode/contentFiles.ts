// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Show Files of a volume or an image of the view Docker Hosts (docs/requirements.md R-ENG-008, R-ENG-010): the tree of
// its folders and files (core/hosts/contentReader.ts: names, sizes and times, never the content of a file) as a
// read-only document of VS Code, from the menu of a volume or image row and from its report. Only while the setting
// devspaces.allowContentReads is on, for every volume and image, and never on a VM that does not run, because a read
// would start it. The document has the address of its host and its name, so a second Show Files shows the newer tree in
// its tab.
import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import type { ContentReadOutcome } from '../core/hosts/contentRead';
import { contentTargetOf, contentTreeText, type ContentTarget } from '../core/hosts/contentReader';
import { isAbortError, type Logger } from '../core/ports';
import { withSshPrompts } from '../core/sshAskpass';
import type { VmState } from '../core/vm/vmState';
import { showInformationMessage, showWarningMessage } from './notifications';
import { reportTargetOfArgument } from './reportPageModel';

/** The scheme of the read-only documents of Show Files. */
export const CONTENT_FILES_SCHEME = 'devspaces-files';

/** What Show Files reads: its host, the volume or the image, and the name that the view shows. */
export interface ContentFilesTarget {
  host: string;
  target: ContentTarget;
  name: string;
}

export const ContentFilesTexts = {
  off: 'Show Files is off: turn on the setting devspaces.allowContentReads to read the folders and files of a volume or an image.',
  vmNotRunning: 'The VM of Devspaces does not run. Show Files reads nothing while it is stopped, because a read would start it.',
  subject: (files: ContentFilesTarget) => `${files.target.kind} ${files.name}`,
  noImage: (files: ContentFilesTarget) =>
    `The files of the ${ContentFilesTexts.subject(files)} could not be read: the host has no helper image of Devspaces, which the reader needs (it never downloads one). The next start of a devspace on this host builds it.`,
  unsupported: (files: ContentFilesTarget, detail: string) =>
    `The files of the ${ContentFilesTexts.subject(files)} could not be read: the Docker Engine or the Docker CLI of ${files.host} cannot mount an image (Docker 28 or newer can). The section Layers of its report shows its steps. Docker said: ${detail}`,
  failed: (files: ContentFilesTarget, detail: string) => `The files of the ${ContentFilesTexts.subject(files)} could not be read: ${detail}`,
};

export interface ContentFilesDeps {
  logger: Logger;
  /** The setting devspaces.allowContentReads. */
  allowed(): boolean;
  /** The host of the VM of Devspaces on this computer, when it has one. */
  vmHost: string | undefined;
  vmState(): Promise<VmState>;
  /** The tree of `target` on `host` (readContents on the shared shell of the host). */
  read(host: string, target: ContentTarget): Promise<ContentReadOutcome>;
  /** The time zone of this computer, in which the document gives times. */
  timeZone(): string;
  now?(): number;
}

/**
 * The path of the document of `files`: one segment for the host and one for the object. A name of an image can hold
 * `/` and `:`, which become `_`, so the segment of an image also has the short ID of the image: two images whose names
 * differ only there get two documents. A volume name has none of them.
 */
export function contentFilesPath(files: ContentFilesTarget): string {
  const name = files.name.replace(/[/\\:]/g, '_');
  const id = files.target.kind === 'image' ? `-${files.target.id.slice('sha256:'.length, 'sha256:'.length + 12)}` : '';
  return `/${files.host}/${files.target.kind}-${name}${id}.files`;
}

/** The target of Show Files of a row or a report: a volume by its name, an image by its full ID. */
export function contentFilesTarget(host: string, object: { kind: string; id: string; name: string }): ContentFilesTarget | undefined {
  const target = contentTargetOf(object);
  return target !== undefined ? { host, target, name: object.name } : undefined;
}

/** Show Files of this window: the provider of its documents, registered at the first Show Files. */
export class ContentFiles implements vscode.Disposable {
  private readonly texts = new Map<string, string>();
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  private provider: vscode.Disposable | undefined;
  private disposed = false;

  constructor(private readonly deps: ContentFilesDeps) {}

  /** Show Files of the menu of a volume or image row of the view. */
  async showRow(argument: unknown): Promise<void> {
    const row = reportTargetOfArgument(argument);
    if (row === undefined) return;
    const files = contentFilesTarget(row.host, row.object);
    if (files === undefined) {
      this.deps.logger.warn(`Show Files of ${row.object.name} on ${row.host} is not run: the row is no volume and no image with a full ID.`);
      return;
    }
    await this.show(files);
  }

  /** Show Files of `files`: the tree of its folders and files, as a read-only document in a tab of its own. */
  async show(files: ContentFilesTarget): Promise<void> {
    if (this.disposed) return;
    const subject = ContentFilesTexts.subject(files);
    // Off: Devspaces runs no reader of the content, on any host.
    if (!this.deps.allowed()) {
      this.deps.logger.info(`Show Files of the ${subject} on ${files.host} is not run: the setting devspaces.allowContentReads is off.`);
      this.inform(ContentFilesTexts.off);
      return;
    }
    if (files.host === this.deps.vmHost && (await this.deps.vmState()).kind !== 'running') {
      this.deps.logger.info(`Show Files of the ${subject} on the VM of Devspaces is not run: the VM does not run.`);
      this.inform(ContentFilesTexts.vmNotRunning);
      return;
    }
    let outcome: ContentReadOutcome;
    try {
      outcome = await withSshPrompts(() => this.deps.read(files.host, files.target));
    } catch (error) {
      if (isAbortError(error)) return;
      outcome = { kind: 'failed', detail: errorMessage(error) };
    }
    if (outcome.kind !== 'read') {
      const message =
        outcome.kind === 'noImage'
          ? ContentFilesTexts.noImage(files)
          : outcome.kind === 'unsupported'
            ? ContentFilesTexts.unsupported(files, outcome.detail.split('\n')[0].slice(0, 300))
            : ContentFilesTexts.failed(files, outcome.detail.split('\n')[0].slice(0, 300));
      this.deps.logger.warn(`Show Files of the ${subject} on ${files.host}: ${outcome.kind === 'noImage' ? 'no helper image' : outcome.detail}`);
      showWarningMessage(message).then(undefined, (shown: unknown) => this.deps.logger.error('Could not show the message.', shown));
      return;
    }
    if (this.disposed) return;
    this.provider ??= vscode.workspace.registerTextDocumentContentProvider(CONTENT_FILES_SCHEME, {
      onDidChange: this.changed.event,
      provideTextDocumentContent: (uri) => this.texts.get(uri.toString()) ?? '',
    });
    const uri = vscode.Uri.from({ scheme: CONTENT_FILES_SCHEME, path: contentFilesPath(files) });
    this.texts.set(uri.toString(), contentTreeText(outcome.tree, { subject, host: files.host, at: (this.deps.now ?? Date.now)(), timeZone: this.deps.timeZone() }));
    this.changed.fire(uri);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      this.deps.logger.warn(`The files of the ${subject} on ${files.host} could not be opened: ${errorMessage(error)}`);
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
