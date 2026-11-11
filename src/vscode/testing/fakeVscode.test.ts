// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeVscode, resetFakeVscode } from './fakeVscode';

beforeEach(() => resetFakeVscode());

function openPanel() {
  fakeVscode.window.createWebviewPanel('test.view', 'Title', fakeVscode.ViewColumn.Active, { enableScripts: true });
  const panel = fakeVscode.webviewPanels[fakeVscode.webviewPanels.length - 1];
  if (!panel) throw new Error('no panel');
  return panel;
}

describe('fake webview panel', () => {
  it('records the panel with its arguments; a new panel is visible and active', () => {
    const panel = openPanel();
    expect(fakeVscode.webviewPanels).toHaveLength(1);
    expect(panel).toMatchObject({ viewType: 'test.view', title: 'Title', column: -1, options: { enableScripts: true }, visible: true, active: true });
    expect(panel.webview.asWebviewUri(fakeVscode.Uri.file('/ext/a.js')).toString()).toBe('webview:file:///ext/a.js');
  });

  it('fires the view state only on a change of visible or active, and reveal shows a hidden panel', () => {
    const panel = openPanel();
    const states: Array<{ visible: boolean; active: boolean }> = [];
    panel.onDidChangeViewState(({ webviewPanel }) => states.push({ visible: webviewPanel.visible, active: webviewPanel.active }));
    panel.setVisible(true);
    expect(states).toEqual([]);
    panel.setVisible(false);
    panel.setVisible(false);
    expect(states).toEqual([{ visible: false, active: false }]);
    panel.reveal();
    expect(states).toEqual([
      { visible: false, active: false },
      { visible: true, active: true },
    ]);
    expect(panel.reveal).toHaveBeenCalledTimes(1);
  });

  it('passes page messages to the listeners until a listener is disposed, and records posted messages', async () => {
    const panel = openPanel();
    const heard: unknown[] = [];
    const listener = panel.webview.onDidReceiveMessage((message) => heard.push(message));
    panel.receive({ type: 'ready' });
    listener.dispose();
    panel.receive({ type: 'later' });
    expect(heard).toEqual([{ type: 'ready' }]);
    await expect(panel.webview.postMessage({ type: 'load', value: 1 })).resolves.toBe(true);
    expect(panel.posted).toEqual([{ type: 'load', value: 1 }]);
  });

  it('disposes once; after that no event reaches a listener', () => {
    const panel = openPanel();
    const disposed = vi.fn();
    const states = vi.fn();
    const messages = vi.fn();
    panel.onDidDispose(disposed);
    panel.onDidChangeViewState(states);
    panel.webview.onDidReceiveMessage(messages);
    panel.dispose();
    panel.dispose();
    panel.setVisible(false);
    panel.receive({ type: 'ready' });
    expect(disposed).toHaveBeenCalledTimes(1);
    expect(states).not.toHaveBeenCalled();
    expect(messages).not.toHaveBeenCalled();
    expect(panel.disposed).toBe(true);
  });

  it('resetFakeVscode forgets the panels and keeps createWebviewPanel working', () => {
    openPanel();
    resetFakeVscode();
    expect(fakeVscode.webviewPanels).toEqual([]);
    openPanel();
    expect(fakeVscode.webviewPanels).toHaveLength(1);
  });
});

describe('fake window state', () => {
  it('fireWindowState sets window.state and calls the listeners; a reset drops them', () => {
    const states: boolean[] = [];
    fakeVscode.window.onDidChangeWindowState((state: { focused: boolean }) => states.push(state.focused));
    fakeVscode.fireWindowState(false);
    expect(fakeVscode.window.state.focused).toBe(false);
    expect(states).toEqual([false]);
    resetFakeVscode();
    expect(fakeVscode.window.state.focused).toBe(true);
    fakeVscode.fireWindowState(false);
    expect(states).toEqual([false]);
  });
});

describe('fake Uri.joinPath', () => {
  it('joins the parts of a file URI into a file URI, and of any other URI with a slash', () => {
    const joined = fakeVscode.Uri.joinPath(fakeVscode.Uri.file('/ext'), 'resources', 'page.js');
    expect(joined).toMatchObject({ scheme: 'file', fsPath: '/ext/resources/page.js' });
    expect(joined.toString()).toBe('file:///ext/resources/page.js');
    expect(fakeVscode.Uri.joinPath(fakeVscode.Uri.parse('vscode-test:/a'), 'b').toString()).toBe('vscode-test:/a/b');
  });
});
