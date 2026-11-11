// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Which rows of the repository view are active (in the colors of the theme) and which are gray: a row whose devspace
// runs, and every level of the tree above such a row.
import { describe, expect, it } from 'vitest';
import type { DevspaceState } from '../core/types';
import { holdsActiveRow, isActiveRow, type GroupNode, type HintRow, type OwnerGroup, type RepositoryNode, type RepositoryRow } from './treeModel';

const row = (state: DevspaceState | undefined, extra: Partial<RepositoryRow> = {}): RepositoryRow =>
  ({ kind: 'repository', id: `repo:${state ?? 'none'}`, label: 'api', ...(state !== undefined ? { state } : {}), ...extra }) as RepositoryRow;
const hint = { kind: 'hint', id: 'hint:acme' } as HintRow;
const node = (children: RepositoryRow[]): RepositoryNode => ({ kind: 'repositoryNode', id: 'node', children }) as unknown as RepositoryNode;
const group = (children: GroupNode['children']): GroupNode => ({ kind: 'group', id: 'group', children }) as unknown as GroupNode;
const owner = (children: OwnerGroup['children']): OwnerGroup => ({ kind: 'owner', id: 'owner', owner: 'acme', children }) as unknown as OwnerGroup;

describe('active rows of the repository view', () => {
  it('counts a devspace as active while its container runs: connected, in another window, running, updating', () => {
    expect((['connected', 'connectedOtherWindow', 'running', 'updating'] as DevspaceState[]).every((state) => isActiveRow(row(state)))).toBe(true);
    expect((['stopped', 'noContainer', 'filesMissing'] as DevspaceState[]).some((state) => isActiveRow(row(state)))).toBe(false);
    expect(isActiveRow(row(undefined))).toBe(false);
  });

  it('never grays a row whose state Devspaces could not read, or whose other containers run (`· containers running`)', () => {
    expect(isActiveRow(row('stopped', { stateUnknown: true }))).toBe(true);
    expect(isActiveRow(row('stopped', { servicesRunning: true }))).toBe(true);
  });

  it('counts a level as active while any row below it is active, through groups and repositories with several sources; a hint never', () => {
    expect(holdsActiveRow(node([row('stopped'), row('running')]))).toBe(true);
    expect(holdsActiveRow(node([row('stopped'), row(undefined)]))).toBe(false);
    expect(holdsActiveRow(owner([hint, row(undefined), group([group([node([row('connected')])])])]))).toBe(true);
    expect(holdsActiveRow(owner([hint, row('noContainer'), group([node([row('stopped')])])]))).toBe(false);
    expect(holdsActiveRow(owner([hint]))).toBe(false);
  });
});
