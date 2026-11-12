// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The colors of the rows: the URI that carries the color of a row, its file decoration, and its icon.
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import { FileDecoration, ThemeIcon, TreeItem } from './testing/fakeVscode';
import { colorLabel, colorTreeItem, LOCAL_WORK_BADGE, ROW_COLOR_SCHEME, RowColorDecorations, RowColorIds, rowColorOf, rowColorUri, rowLookOf } from './rowColors';
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

  // R-DS-001: the badge of a row whose devspace holds work that is not on GitHub yet.
  it('names the badge of a row in its URI, with or without a color, and reads both back', () => {
    expect(rowColorUri('inactive', true)).toMatchObject({ scheme: ROW_COLOR_SCHEME, path: '/inactive/localWork' });
    expect(rowColorUri(undefined, true)).toMatchObject({ scheme: ROW_COLOR_SCHEME, path: '/plain/localWork' });
    expect(() => rowColorUri(undefined)).toThrow();
    expect(rowLookOf(rowColorUri('inactive', true))).toEqual({ color: 'inactive', badge: true });
    expect(rowLookOf(rowColorUri(undefined, true))).toEqual({ color: undefined, badge: true });
    expect(rowLookOf(rowColorUri('inactive'))).toEqual({ color: 'inactive', badge: false });
    expect(rowColorOf(rowColorUri('inactive', true))).toBe('inactive');
    expect(rowColorOf(rowColorUri(undefined, true))).toBeUndefined();
    // Any other path is no URI of a row.
    for (const path of ['/plain', '/inactive/other', '/inactive/localWork/x', '/toString/localWork', '/', '']) {
      expect(rowLookOf({ scheme: ROW_COLOR_SCHEME, path } as vscode.Uri)).toBeUndefined();
    }
    expect(rowLookOf({ scheme: 'file', path: '/plain/localWork' } as vscode.Uri)).toBeUndefined();
  });

  it('decorates a row with the badge with the arrow up, in the color of the row or of the theme, and without a tooltip', () => {
    const decorations = new RowColorDecorations();
    const gray = decorations.provideFileDecoration(rowColorUri('inactive', true)) as unknown as FileDecoration;
    expect(gray.badge).toBe(LOCAL_WORK_BADGE);
    expect(LOCAL_WORK_BADGE).toBe('\u2191');
    expect(gray.color?.id).toBe(RowColorIds.inactive);
    expect(gray.tooltip).toBeUndefined();
    const plain = decorations.provideFileDecoration(rowColorUri(undefined, true)) as unknown as FileDecoration;
    expect(plain.badge).toBe(LOCAL_WORK_BADGE);
    expect(plain.color).toBeUndefined();
    expect(plain.tooltip).toBeUndefined();
  });

  it('gives a tree item with the badge a URI also without a color, and keeps its hover', () => {
    const item = new TreeItem('acme/api');
    colorTreeItem(item as unknown as vscode.TreeItem, 'blank', undefined, true);
    expect((item.iconPath as ThemeIcon).color).toBeUndefined();
    expect(item.resourceUri).toMatchObject({ path: '/plain/localWork' });
    expect(item.tooltip).toBe('acme/api');
    const gray = new TreeItem('acme/web');
    colorLabel(gray as unknown as vscode.TreeItem, 'inactive', true);
    expect(gray.resourceUri).toMatchObject({ path: '/inactive/localWork' });
    const none = new TreeItem('acme/lib');
    colorLabel(none as unknown as vscode.TreeItem, undefined, false);
    expect(none.resourceUri).toBeUndefined();
  });
});
