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
// The same decoration gives the badge LOCAL_WORK_BADGE to a row of the view Devspaces whose devspace holds work that is
// not on GitHub yet, and to each level above it (R-DS-001): the URI names it too, after the color (or `plain` for a
// row without a color). VS Code shows a badge at the right edge of the row, in the color of the row, while
// `explorer.decorations.badges` is on (the default); a badge has at most 2 characters, so it carries no number.
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

/**
 * The badge of a row whose devspace holds work that is not on GitHub yet (uncommitted files, unpushed commits,
 * stashes), and of each level above it (R-DS-001). The arrow up of VS Code's own count of the commits to push.
 */
export const LOCAL_WORK_BADGE = '\u2191';

/** The first segment of the path of a URI of a row with the badge and without a color. */
const PLAIN = 'plain';
/** The second segment of the path of a URI of a row with the badge LOCAL_WORK_BADGE. */
const LOCAL_WORK = 'localWork';

/** What the URI of a row names: its color (none: the color of the theme), and whether it has the badge. */
export interface RowLook {
  color: RowColor | undefined;
  badge: boolean;
}

/**
 * The URI of a row with the color `color` and, with `badge`, the badge LOCAL_WORK_BADGE:
 * `devspaces-row-color:/inactive`, `devspaces-row-color:/inactive/localWork`, `devspaces-row-color:/plain/localWork`.
 * Never for a row with neither (it gets no URI).
 */
export function rowColorUri(color: RowColor | undefined, badge = false): vscode.Uri {
  if (color === undefined && !badge) throw new Error('A row without a color and without a badge has no URI of a row.');
  return vscode.Uri.from({ scheme: ROW_COLOR_SCHEME, path: `/${color ?? PLAIN}${badge ? `/${LOCAL_WORK}` : ''}` });
}

/** The color and the badge of a URI of rowColorUri, else undefined. */
export function rowLookOf(uri: vscode.Uri): RowLook | undefined {
  if (uri.scheme !== ROW_COLOR_SCHEME) return undefined;
  const segments = uri.path.replace(/^\//, '').split('/');
  if (segments.length > 2 || (segments.length === 2 && segments[1] !== LOCAL_WORK)) return undefined;
  const badge = segments.length === 2;
  if (segments[0] === PLAIN) return badge ? { color: undefined, badge } : undefined;
  return Object.prototype.hasOwnProperty.call(RowColorIds, segments[0]) ? { color: segments[0] as RowColor, badge } : undefined;
}

/** The color of a URI of rowColorUri, else undefined. */
export function rowColorOf(uri: vscode.Uri): RowColor | undefined {
  return rowLookOf(uri)?.color;
}

/** The icon of a row with the color of the row (undefined: the color of the theme for icons). */
export function coloredIcon(id: string, color: RowColor | undefined): vscode.ThemeIcon {
  return color === undefined ? new vscode.ThemeIcon(id) : new vscode.ThemeIcon(id, new vscode.ThemeColor(RowColorIds[color]));
}

/**
 * Gives the label of a tree item the color `color` and, with `badge`, the badge LOCAL_WORK_BADGE by its `resourceUri`
 * (none for neither). The item must have a ThemeIcon: without one, VS Code would show the icon of the file icon theme
 * for the URI. A row with a `resourceUri` and without a tooltip would show the path of the URI (`/inactive`) as its
 * hover, so it gets its label as its tooltip, as VS Code shows it for a row without a `resourceUri`.
 */
export function colorLabel(item: vscode.TreeItem, color: RowColor | undefined, badge = false): void {
  if (color === undefined && !badge) return;
  item.resourceUri = rowColorUri(color, badge);
  if (item.tooltip === undefined && typeof item.label === 'string') item.tooltip = item.label;
}

/**
 * Gives a tree item the color `color`: its icon `icon` (a codicon or an icon of Devspaces) and its label; with `badge`,
 * also the badge LOCAL_WORK_BADGE.
 */
export function colorTreeItem(item: vscode.TreeItem, icon: string, color: RowColor | undefined, badge = false): void {
  item.iconPath = coloredIcon(icon, color);
  colorLabel(item, color, badge);
}

/**
 * The colors and the badges of the labels of the rows: a file decoration with the color of the row (none: the color of
 * the theme) and the badge LOCAL_WORK_BADGE when the URI names it, never with a tooltip (VS Code would add it to the
 * hover of the row after a `•`).
 */
export class RowColorDecorations implements vscode.FileDecorationProvider {
  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const look = rowLookOf(uri);
    if (look === undefined) return undefined;
    return new vscode.FileDecoration(look.badge ? LOCAL_WORK_BADGE : undefined, undefined, look.color === undefined ? undefined : new vscode.ThemeColor(RowColorIds[look.color]));
  }
}
