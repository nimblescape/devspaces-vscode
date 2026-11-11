// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The colors of the rows: the URI that carries the color of a row, its file decoration, and its icon.
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { FileDecoration, ThemeIcon, TreeItem } from './testing/fakeVscode';
import { colorLabel, colorTreeItem, ROW_COLOR_SCHEME, RowColorDecorations, RowColorIds, rowColorOf, rowColorUri } from './rowColors';
import type * as vscode from 'vscode';

describe('rowColors', () => {
  it('names the color of a row in a URI of its own scheme, and reads it back', () => {
    const uri = rowColorUri('notDevspacesInactive');
    expect(uri).toMatchObject({ scheme: ROW_COLOR_SCHEME, path: '/notDevspacesInactive' });
    expect(rowColorOf(uri)).toBe('notDevspacesInactive');
    expect(rowColorOf({ scheme: ROW_COLOR_SCHEME, path: '/toString' } as vscode.Uri)).toBeUndefined();
    expect(rowColorOf({ scheme: 'file', path: '/inactive' } as vscode.Uri)).toBeUndefined();
  });

  it('decorates only the URIs of the rows, with the theme color of the row and without a badge or a tooltip', () => {
    const decorations = new RowColorDecorations();
    const decoration = decorations.provideFileDecoration(rowColorUri('inactive')) as unknown as FileDecoration;
    expect(decoration).toBeInstanceOf(FileDecoration);
    expect(decoration.color?.id).toBe(RowColorIds.inactive);
    expect(decoration.badge).toBeUndefined();
    expect(decoration.tooltip).toBeUndefined();
    expect(decorations.provideFileDecoration({ scheme: 'file', path: '/home/me/a.ts' } as vscode.Uri)).toBeUndefined();
  });

  it('colors the icon and the label of a tree item, and gives a row with a color its label as hover', () => {
    const item = new TreeItem('shop-web-1');
    colorTreeItem(item as unknown as vscode.TreeItem, 'vm-outline', 'notDevspacesInactive');
    expect((item.iconPath as ThemeIcon).id).toBe('vm-outline');
    expect((item.iconPath as ThemeIcon).color?.id).toBe('devspaces.hosts.notDevspacesInactiveForeground');
    expect(item.resourceUri).toMatchObject({ path: '/notDevspacesInactive' });
    expect(item.tooltip).toBe('shop-web-1');

    const plain = new TreeItem('devspaces-monitor');
    plain.tooltip = 'Container devspaces-monitor';
    colorTreeItem(plain as unknown as vscode.TreeItem, 'vm-running', undefined);
    expect((plain.iconPath as ThemeIcon).color).toBeUndefined();
    expect(plain.resourceUri).toBeUndefined();
    colorLabel(plain as unknown as vscode.TreeItem, 'inactive');
    expect(plain.tooltip).toBe('Container devspaces-monitor');
  });
});
