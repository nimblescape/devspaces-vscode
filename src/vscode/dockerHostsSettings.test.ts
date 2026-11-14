// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The gear Docker Hosts Settings… of the view Docker Hosts (docs/requirements.md R-ENG-008): its quick pick marks the
// current values, one choice writes one user setting, and a run while its setting is off changes nothing.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', async () => (await import('./testing/fakeVscode')).fakeVscode);

import type { ExtensionSettings } from '../core/types';
import { DockerHostsSettingsTexts, chooseDockerHostsSettings, dockerHostsSettingsItems } from './dockerHostsSettings';
import { DEFAULT_SETTINGS } from './settings';
import { fakeVscode, resetFakeVscode } from './testing/fakeVscode';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), output: vi.fn() };

beforeEach(() => {
  resetFakeVscode();
  vi.clearAllMocks();
});

describe('dockerHostsSettingsItems', () => {
  it('lists a group per setting of the view (actions, removals, logs, files, console), the current values marked', () => {
    const items = dockerHostsSettingsItems({ dockerHostsActions: 'contextMenu', allowDestructiveActions: true, allowContainerLogs: false });
    expect(items.map((item) => item.label)).toEqual([
      DockerHostsSettingsTexts.actionsGroup,
      '$(blank) Disabled',
      '$(check) Context Menu',
      '$(blank) Icons',
      DockerHostsSettingsTexts.destructiveGroup,
      '$(check) Allow',
      '$(blank) Do Not Allow',
      DockerHostsSettingsTexts.logsGroup,
      '$(blank) Allow',
      '$(check) Do Not Allow',
      DockerHostsSettingsTexts.filesGroup,
      '$(blank) Allow',
      '$(check) Do Not Allow',
      DockerHostsSettingsTexts.consoleGroup,
      '$(blank) Show',
      '$(check) Hide',
    ]);
    expect(items.filter((item) => item.kind === fakeVscode.QuickPickItemKind.Separator)).toHaveLength(5);
    expect(items.filter((item) => item.description === DockerHostsSettingsTexts.current).map((item) => item.choice)).toEqual([
      { key: 'dockerHostsActions', value: 'contextMenu' },
      { key: 'allowDestructiveActions', value: true },
      { key: 'allowContainerLogs', value: false },
      { key: 'allowContentReads', value: false },
      { key: 'dockerHostsConsoleButton', value: false },
    ]);
    // Without values: the defaults.
    expect(dockerHostsSettingsItems({}).filter((item) => item.description === DockerHostsSettingsTexts.current).map((item) => item.choice?.value)).toEqual([
      'disabled',
      false,
      false,
      false,
      false,
    ]);
  });
});

describe('chooseDockerHostsSettings', () => {
  const settings = (overrides: Partial<ExtensionSettings>): ExtensionSettings => ({ ...DEFAULT_SETTINGS, dockerHostsSettingsButton: true, ...overrides });

  it('writes the chosen value into the user settings', async () => {
    const update = vi.fn(async () => undefined);
    fakeVscode.workspace.getConfiguration.mockReturnValue({ update });
    fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ choice?: { value: unknown } }>) => items.find((item) => item.choice?.value === 'icons'));
    await chooseDockerHostsSettings({ logger, settings: () => settings({}) });
    expect(fakeVscode.workspace.getConfiguration).toHaveBeenCalledWith('devspaces');
    expect(update).toHaveBeenCalledWith('dockerHostsActions', 'icons', fakeVscode.ConfigurationTarget.Global);
    for (const key of ['allowDestructiveActions', 'allowContainerLogs', 'allowContentReads', 'dockerHostsConsoleButton'] as const) {
      fakeVscode.window.showQuickPick.mockImplementationOnce(async (items: Array<{ choice?: { key: string; value: unknown } }>) =>
        items.find((item) => item.choice?.key === key && item.choice.value === true),
      );
      await chooseDockerHostsSettings({ logger, settings: () => settings({}) });
      expect(update).toHaveBeenLastCalledWith(key, true, fakeVscode.ConfigurationTarget.Global);
    }
    expect(fakeVscode.window.showQuickPick).toHaveBeenCalledWith(expect.any(Array), { title: DockerHostsSettingsTexts.title, placeHolder: DockerHostsSettingsTexts.placeHolder });
  });

  it('changes nothing when the quick pick is closed, and nothing while its setting is off', async () => {
    const update = vi.fn(async () => undefined);
    fakeVscode.workspace.getConfiguration.mockReturnValue({ update });
    fakeVscode.window.showQuickPick.mockResolvedValueOnce(undefined);
    await chooseDockerHostsSettings({ logger, settings: () => settings({}) });
    await chooseDockerHostsSettings({ logger, settings: () => settings({ dockerHostsSettingsButton: false }) });
    expect(fakeVscode.window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(fakeVscode.window.showInformationMessage).toHaveBeenCalledWith(DockerHostsSettingsTexts.off);
    expect(update).not.toHaveBeenCalled();
  });
});
