// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Test double of the part of the `vscode` API that the UI components use. Tests replace the module with
// `vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode)` and script the answers.
import { vi, type Mock } from 'vitest';

export class EventEmitter<T> {
  private readonly listeners = new Set<(event: T) => void>();

  readonly event = (listener: (event: T) => void) => {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  };

  fire(event: T): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class TreeItem {
  id?: string;
  description?: string;
  tooltip?: string;
  contextValue?: string;
  iconPath?: unknown;
  resourceUri?: unknown;
  command?: unknown;
  accessibilityInformation?: unknown;

  constructor(
    readonly label: string,
    readonly collapsibleState?: number,
  ) {}
}

export class FileDecoration {
  constructor(
    readonly badge?: string,
    readonly tooltip?: string,
    readonly color?: ThemeColor,
  ) {}
}

const fileUri = (fsPath: string) => ({ scheme: 'file', fsPath, toString: () => `file://${fsPath}` });

export const Uri = {
  from: (parts: { scheme: string; path?: string; query?: string }) => ({
    scheme: parts.scheme,
    path: parts.path ?? '',
    query: parts.query ?? '',
    toString: () => `${parts.scheme}:${parts.path ?? ''}${parts.query !== undefined && parts.query !== '' ? `?${parts.query}` : ''}`,
  }),
  parse: (value: string) => ({ scheme: value.split(':')[0], toString: () => value }),
  file: fileUri,
  /** A file URI stays a file URI with the joined path; any other URI gets the parts after a `/`. */
  joinPath: (base: { toString(): string; fsPath?: string }, ...parts: string[]) =>
    base.fsPath === undefined ? { toString: () => [base.toString(), ...parts].join('/') } : fileUri([base.fsPath, ...parts].join('/')),
};

export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 } as const;

/** A panel of `window.createWebviewPanel`. It starts visible and active, as a new panel in VS Code does. */
export interface FakeWebviewPanel {
  viewType: string;
  title: string;
  /** The column of `createWebviewPanel`. */
  column: unknown;
  /** The options of `createWebviewPanel`. */
  options: unknown;
  webview: {
    html: string;
    cspSource: string;
    options?: unknown;
    asWebviewUri(uri: { toString(): string }): { toString(): string };
    /** Records each message in `posted` and resolves to true. */
    postMessage: Mock<(message: { type: string; [key: string]: unknown }) => Promise<boolean>>;
    onDidReceiveMessage(listener: (message: unknown) => void): { dispose(): void };
  };
  visible: boolean;
  active: boolean;
  /** Makes the panel visible and active (with `onDidChangeViewState` on a change). */
  reveal: Mock<(column?: unknown, preserveFocus?: boolean) => void>;
  /** Closes the panel once: fires `onDidDispose`; later calls do nothing. */
  dispose(): void;
  onDidDispose(listener: () => void): { dispose(): void };
  onDidChangeViewState(listener: (event: { webviewPanel: FakeWebviewPanel }) => void): { dispose(): void };
  /** Test helper: the page posts `message` (fires `webview.onDidReceiveMessage`). */
  receive(message: unknown): void;
  /**
   * Test helper: the tab is shown or hidden, for example by a click on another tab. Fires `onDidChangeViewState` only on
   * a change, as VS Code does; a hidden panel is not active.
   */
  setVisible(visible: boolean): void;
  /** Test helper: the page becomes active or not while it stays visible (for example a click into another group). */
  setActive(active: boolean): void;
  /** Every message of `webview.postMessage`, in order. */
  posted: Array<{ type: string; [key: string]: unknown }>;
  disposed: boolean;
}

function fakeWebviewPanel(viewType: string, title: string, column: unknown, options: unknown): FakeWebviewPanel {
  const messages = new EventEmitter<unknown>();
  const disposals = new EventEmitter<void>();
  const viewStates = new EventEmitter<{ webviewPanel: FakeWebviewPanel }>();
  const setView = (visible: boolean, active: boolean) => {
    if (panel.disposed || (panel.visible === visible && panel.active === active)) return;
    panel.visible = visible;
    panel.active = active;
    viewStates.fire({ webviewPanel: panel });
  };
  const panel: FakeWebviewPanel = {
    viewType,
    title,
    column,
    options,
    webview: {
      html: '',
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri) => ({ toString: () => `webview:${uri.toString()}` }),
      postMessage: vi.fn(async (message: { type: string; [key: string]: unknown }) => {
        panel.posted.push(message);
        return true;
      }),
      onDidReceiveMessage: messages.event,
    },
    visible: true,
    active: true,
    reveal: vi.fn(() => setView(true, true)),
    dispose: () => {
      if (panel.disposed) return;
      panel.disposed = true;
      disposals.fire();
      for (const emitter of [messages, disposals, viewStates]) emitter.dispose();
    },
    onDidDispose: disposals.event,
    onDidChangeViewState: viewStates.event,
    receive: (message) => messages.fire(message),
    setVisible: (visible) => setView(visible, visible),
    setActive: (active) => setView(panel.visible, active),
    posted: [],
    disposed: false,
  };
  return panel;
}

/** A provider of `window.registerCustomEditorProvider`. */
export interface FakeCustomEditorProvider {
  openCustomDocument(uri: unknown, context: unknown, token: unknown): unknown;
  resolveCustomEditor(document: unknown, panel: FakeWebviewPanel, token: unknown): unknown;
}

/**
 * Test helper: VS Code opens `uri` in a tab of the custom editor `viewType` (a click on a tree item with `vscode.open`,
 * or a tab of the last session): a new panel in `webviewPanels`, titled with the path as VS Code titles it, given to the
 * provider.
 */
export async function openFakeCustomEditor(viewType: string, uri: { path: string }): Promise<FakeWebviewPanel> {
  const entry = fakeVscode.customEditors.get(viewType);
  if (entry === undefined) throw new Error(`No custom editor ${viewType} is registered.`);
  const panel = fakeWebviewPanel(viewType, uri.path, undefined, undefined);
  fakeVscode.webviewPanels.push(panel);
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => undefined }) };
  const document = await entry.provider.openCustomDocument(uri, { backupId: undefined, untitledDocumentData: undefined }, token);
  await entry.provider.resolveCustomEditor(document, panel, token);
  return panel;
}

export interface FakeTerminal {
  name?: string;
  /** The terminal of an extension (vscode.Pseudoterminal), when it has one. */
  pty?: unknown;
  shown: number;
  lines: string[];
  show(): void;
  sendText(text: string): void;
  dispose(): void;
}

export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 } as const;
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export const QuickPickItemKind = { Separator: -1, Default: 0 } as const;
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;

export interface FakeStatusBarItem {
  id: string;
  alignment: number;
  priority: number;
  name?: string;
  text: string;
  tooltip?: string;
  accessibilityInformation?: { label: string; role?: string };
  command?: unknown;
  backgroundColor?: ThemeColor;
  visible: boolean;
  disposed: boolean;
  show(): void;
  dispose(): void;
}

export interface FakeOutputChannel {
  name: string;
  text: string;
  shown: number;
  disposed: boolean;
  append(value: string): void;
  appendLine(value: string): void;
  show(preserveFocus?: boolean): void;
  dispose(): void;
}

const sessionChanges = new EventEmitter<{ provider: { id: string; label: string } }>();
const configurationChanges = new EventEmitter<{ affectsConfiguration(section: string): boolean }>();
const trustGrants = new EventEmitter<void>();
const windowStates = new EventEmitter<{ focused: boolean }>();

export const fakeVscode = {
  EventEmitter,
  ThemeColor,
  ThemeIcon,
  TreeItem,
  FileDecoration,
  Uri,
  ProgressLocation,
  StatusBarAlignment,
  TreeItemCollapsibleState,
  QuickPickItemKind,
  ConfigurationTarget,
  ViewColumn,
  window: {
    createOutputChannel: vi.fn(),
    createStatusBarItem: vi.fn(),
    showInformationMessage: vi.fn(),
    showWarningMessage: vi.fn(),
    showErrorMessage: vi.fn(),
    showQuickPick: vi.fn(),
    showInputBox: vi.fn(),
    createQuickPick: vi.fn(),
    withProgress: vi.fn(),
    createTerminal: vi.fn(),
    registerUriHandler: vi.fn(),
    registerFileDecorationProvider: vi.fn(() => ({ dispose: () => undefined })),
    /** Each panel goes to `webviewPanels`. */
    createWebviewPanel: vi.fn(),
    /** Keeps the provider in `customEditors` until its dispose (openFakeCustomEditor opens a tab of it). */
    registerCustomEditorProvider: vi.fn(),
    /** Resolves to an editor of the document. */
    showTextDocument: vi.fn(),
    /** Fired by `fireWindowState`. */
    onDidChangeWindowState: vi.fn(),
    /** `window.state`: resetFakeVscode gives the window the focus. */
    state: { focused: true },
  },
  env: { openExternal: vi.fn(), remoteName: undefined as string | undefined },
  commands: { executeCommand: vi.fn(), registerCommand: vi.fn() },
  workspace: {
    getConfiguration: vi.fn(),
    /** resetFakeVscode sets it to true. */
    isTrusted: true,
    onDidChangeConfiguration: configurationChanges.event,
    onDidGrantWorkspaceTrust: trustGrants.event,
    /** Each provider goes to `contentProviders` under its scheme. */
    registerTextDocumentContentProvider: vi.fn(),
    /** A document of a URI: its text from the provider of its scheme (`contentProviders`). */
    openTextDocument: vi.fn(),
  },
  languages: {
    /** Resolves to the document with its new language. */
    setTextDocumentLanguage: vi.fn(),
  },
  authentication: {
    getSession: vi.fn(),
    // The GitHub accounts of VS Code (also those of other extensions); none by default.
    getAccounts: vi.fn(),
    onDidChangeSessions: sessionChanges.event,
  },
  /** Test helper: fires `authentication.onDidChangeSessions`. */
  fireSessionChange(providerId: string): void {
    sessionChanges.fire({ provider: { id: providerId, label: providerId } });
  },
  /** Test helper: fires `workspace.onDidChangeConfiguration` for a change of the settings `keys` (full keys). */
  fireConfigurationChange(...keys: string[]): void {
    configurationChanges.fire({ affectsConfiguration: (section) => keys.some((key) => key === section || key.startsWith(`${section}.`)) });
  },
  /** Test helper: the window gets or loses the focus (`window.state.focused`, `window.onDidChangeWindowState`). */
  fireWindowState(focused: boolean): void {
    fakeVscode.window.state.focused = focused;
    windowStates.fire({ focused });
  },
  /** Test helper: VS Code trusts the workspace now (`workspace.isTrusted`, `workspace.onDidGrantWorkspaceTrust`). */
  grantWorkspaceTrust(): void {
    fakeVscode.workspace.isTrusted = true;
    trustGrants.fire();
  },
  statusBarItems: [] as FakeStatusBarItem[],
  terminals: [] as FakeTerminal[],
  outputChannels: [] as FakeOutputChannel[],
  webviewPanels: [] as FakeWebviewPanel[],
  /** The providers of `window.registerCustomEditorProvider` by view type, with their options (removed at their dispose). */
  customEditors: new Map<string, { provider: FakeCustomEditorProvider; options: unknown }>(),
  /** The providers of `workspace.registerTextDocumentContentProvider` by scheme (removed at their dispose). */
  contentProviders: new Map<string, { provideTextDocumentContent(uri: { toString(): string }): string | undefined }>(),
};

/** Restores the default behavior of every fake: messages are dismissed, quick picks cancelled. */
export function resetFakeVscode(): void {
  const { window } = fakeVscode;
  fakeVscode.statusBarItems.length = 0;
  fakeVscode.terminals.length = 0;
  fakeVscode.env.remoteName = undefined;
  fakeVscode.workspace.isTrusted = true;
  window.state.focused = true;
  fakeVscode.outputChannels.length = 0;
  fakeVscode.webviewPanels.length = 0;
  fakeVscode.customEditors.clear();
  fakeVscode.contentProviders.clear();
  // A listener of an earlier test never hears a later window state.
  windowStates.dispose();
  const { state: _state, ...windowMocks } = window;
  for (const mock of [
    ...Object.values(windowMocks),
    fakeVscode.env.openExternal,
    fakeVscode.commands.executeCommand,
    fakeVscode.commands.registerCommand,
    fakeVscode.workspace.getConfiguration,
    fakeVscode.authentication.getSession,
    fakeVscode.authentication.getAccounts,
    fakeVscode.workspace.registerTextDocumentContentProvider,
    fakeVscode.workspace.openTextDocument,
    fakeVscode.languages.setTextDocumentLanguage,
  ]) {
    mock.mockReset();
  }
  fakeVscode.workspace.registerTextDocumentContentProvider.mockImplementation((scheme: string, provider: { provideTextDocumentContent(uri: { toString(): string }): string | undefined }) => {
    fakeVscode.contentProviders.set(scheme, provider);
    return { dispose: () => fakeVscode.contentProviders.delete(scheme) };
  });
  fakeVscode.workspace.openTextDocument.mockImplementation(async (uri: { scheme: string; toString(): string }) => ({
    uri,
    languageId: 'plaintext',
    getText: () => fakeVscode.contentProviders.get(uri.scheme)?.provideTextDocumentContent(uri) ?? '',
  }));
  fakeVscode.languages.setTextDocumentLanguage.mockImplementation(async (document: object, languageId: string) => ({ ...document, languageId }));
  window.showTextDocument.mockImplementation(async (document: unknown) => ({ document }));
  window.showInformationMessage.mockResolvedValue(undefined);
  window.showWarningMessage.mockResolvedValue(undefined);
  window.showErrorMessage.mockResolvedValue(undefined);
  window.showQuickPick.mockResolvedValue(undefined);
  window.showInputBox.mockResolvedValue(undefined);
  window.registerUriHandler.mockReturnValue({ dispose() {} });
  window.registerFileDecorationProvider.mockReturnValue({ dispose: () => undefined });
  window.createWebviewPanel.mockImplementation((viewType: string, title: string, column: unknown, options?: unknown) => {
    const panel = fakeWebviewPanel(viewType, title, column, options);
    fakeVscode.webviewPanels.push(panel);
    return panel;
  });
  window.registerCustomEditorProvider.mockImplementation((viewType: string, provider: FakeCustomEditorProvider, options?: unknown) => {
    fakeVscode.customEditors.set(viewType, { provider, options });
    return { dispose: () => fakeVscode.customEditors.delete(viewType) };
  });
  window.onDidChangeWindowState.mockImplementation(windowStates.event);
  fakeVscode.env.openExternal.mockResolvedValue(true);
  fakeVscode.commands.executeCommand.mockResolvedValue(undefined);
  fakeVscode.commands.registerCommand.mockImplementation(() => ({ dispose() {} }));
  fakeVscode.authentication.getSession.mockResolvedValue(undefined);
  fakeVscode.authentication.getAccounts.mockResolvedValue([]);
  window.createOutputChannel.mockImplementation((name: string) => {
    const channel: FakeOutputChannel = {
      name,
      text: '',
      shown: 0,
      disposed: false,
      append(value) {
        channel.text += value;
      },
      appendLine(value) {
        channel.text += `${value}\n`;
      },
      show() {
        channel.shown++;
      },
      dispose() {
        channel.disposed = true;
      },
    };
    fakeVscode.outputChannels.push(channel);
    return channel;
  });
  window.createTerminal.mockImplementation((options: { name?: string; pty?: unknown }) => {
    const terminal: FakeTerminal = {
      name: options.name,
      ...(options.pty !== undefined ? { pty: options.pty } : {}),
      shown: 0,
      lines: [],
      show() {
        terminal.shown++;
      },
      sendText(text) {
        terminal.lines.push(text);
      },
      dispose() {},
    };
    fakeVscode.terminals.push(terminal);
    return terminal;
  });
  window.createStatusBarItem.mockImplementation((id: string, alignment: number, priority: number) => {
    const item: FakeStatusBarItem = {
      id,
      alignment,
      priority,
      text: '',
      visible: false,
      disposed: false,
      show() {
        item.visible = true;
      },
      dispose() {
        item.disposed = true;
      },
    };
    fakeVscode.statusBarItems.push(item);
    return item;
  });
}

resetFakeVscode();
