// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The colors of the rows of the views Devspaces and Docker Hosts: an inactive row is gray, an object that is not of
// Devspaces is violet (a dimmed violet when it is inactive). A tree item of VS Code takes the color of its icon from
// its ThemeIcon, and the color of its label only from a file decoration of its `resourceUri`: each row with a color
// gets a URI of the scheme ROW_COLOR_SCHEME that names its color, and RowColorDecorations gives that color to it. The
// colors are theme colors of package.json (contributes.colors), so that a user can change them in
// `workbench.colorCustomizations`. The decoration colors the whole text of the row (its name and its description), and
// VS Code applies it only while `explorer.decorations.colors` is on (the default); the icons keep their color anyway.
import * as vscode from 'vscode';

/** The theme colors of the rows (package.json contributes.colors), by the kind of row. */
export const RowColorIds = {
  /** A row without an active devspace, or an object of Devspaces that is not active. */
  inactive: 'devspaces.inactiveForeground',
  /** An active object that is not of Devspaces (view Docker Hosts). */
  notDevspaces: 'devspaces.hosts.notDevspacesForeground',
  /** An inactive object that is not of Devspaces (view Docker Hosts). */
  notDevspacesInactive: 'devspaces.hosts.notDevspacesInactiveForeground',
} as const;

export type RowColor = keyof typeof RowColorIds;

/** The scheme of the URIs that carry the color of a row; no file system has it. */
export const ROW_COLOR_SCHEME = 'devspaces-row-color';

/** The URI of a row with the color `color`: `devspaces-row-color:/inactive`. */
export function rowColorUri(color: RowColor): vscode.Uri {
  return vscode.Uri.from({ scheme: ROW_COLOR_SCHEME, path: `/${color}` });
}

/** The color of a URI of rowColorUri, else undefined. */
export function rowColorOf(uri: vscode.Uri): RowColor | undefined {
  if (uri.scheme !== ROW_COLOR_SCHEME) return undefined;
  const color = uri.path.replace(/^\//, '');
  return Object.prototype.hasOwnProperty.call(RowColorIds, color) ? (color as RowColor) : undefined;
}

/** The icon of a row with the color of the row (undefined: the color of the theme for icons). */
export function coloredIcon(id: string, color: RowColor | undefined): vscode.ThemeIcon {
  return color === undefined ? new vscode.ThemeIcon(id) : new vscode.ThemeIcon(id, new vscode.ThemeColor(RowColorIds[color]));
}

/**
 * Gives the label of a tree item the color `color` by its `resourceUri`. The item must have a ThemeIcon: without one,
 * VS Code would show the icon of the file icon theme for the URI. A row with a `resourceUri` and without a tooltip would
 * show the path of the URI (`/inactive`) as its hover, so it gets its label as its tooltip, as VS Code shows it for a row
 * without a `resourceUri`.
 */
export function colorLabel(item: vscode.TreeItem, color: RowColor | undefined): void {
  if (color === undefined) return;
  item.resourceUri = rowColorUri(color);
  if (item.tooltip === undefined && typeof item.label === 'string') item.tooltip = item.label;
}

/** Gives a tree item the color `color`: its icon `icon` (a codicon or an icon of Devspaces) and its label. */
export function colorTreeItem(item: vscode.TreeItem, icon: string, color: RowColor | undefined): void {
  item.iconPath = coloredIcon(icon, color);
  colorLabel(item, color);
}

/** The colors of the labels of the rows: a file decoration with a color only, without a badge or a tooltip. */
export class RowColorDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const color = rowColorOf(uri);
    return color === undefined ? undefined : new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor(RowColorIds[color]));
  }
}
