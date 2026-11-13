// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The gear "Docker Hosts Settings…" in the title bar of the view Docker Hosts (docs/requirements.md R-ENG-008): a quick
// pick that switches the settings devspaces.dockerHostsActions and devspaces.allowContainerLogs in the user settings
// (both have the scope `application`). The setting devspaces.dockerHostsSettingsButton shows the gear; the command is
// not in the Command Palette, and a run while the setting is off changes nothing.
import * as vscode from 'vscode';
import type { DockerHostsActions, ExtensionSettings } from '../core/types';
import type { Logger } from '../core/ports';
import { showInformationMessage } from './notifications';
import { SETTINGS_SECTION } from './settings';

export const DockerHostsSettingsTexts = {
  title: 'Docker Hosts Settings',
  placeHolder: 'Choose what the view Docker Hosts allows',
  actionsGroup: 'Actions of the view',
  logsGroup: 'Logs of containers',
  actions: {
    disabled: { label: 'Disabled', detail: 'The view is read only: no action changes a host.' },
    contextMenu: { label: 'Context Menu', detail: 'The actions are in the context menu of a row.' },
    icons: { label: 'Icons', detail: 'Every action is a button on its row, and in the context menu.' },
  } satisfies Record<DockerHostsActions, { label: string; detail: string }>,
  logsOn: { label: 'Allow', detail: 'Show Log of every container, and the Docker pipe of Devspaces carries the log of any container.' },
  logsOff: { label: 'Do Not Allow', detail: 'No log of a container: the Docker pipe of Devspaces refuses every log.' },
  current: 'current',
  off: 'The Docker Hosts Settings button is off: turn on the setting devspaces.dockerHostsSettingsButton, or change the settings in the Settings editor.',
};

/** One choice of the quick pick: the setting that it writes, and its value. */
export interface DockerHostsSettingsChoice {
  key: 'dockerHostsActions' | 'allowContainerLogs';
  value: DockerHostsActions | boolean;
}

type Item = vscode.QuickPickItem & { choice?: DockerHostsSettingsChoice };

/** The items of the quick pick: two groups, the current value of each marked. */
export function dockerHostsSettingsItems(settings: Pick<ExtensionSettings, 'dockerHostsActions' | 'allowContainerLogs'>): Item[] {
  const texts = DockerHostsSettingsTexts;
  const actions = settings.dockerHostsActions ?? 'disabled';
  const logs = settings.allowContainerLogs === true;
  const item = (label: string, detail: string, current: boolean, choice: DockerHostsSettingsChoice): Item => ({
    label: `${current ? '$(check)' : '$(blank)'} ${label}`,
    detail,
    ...(current ? { description: texts.current } : {}),
    choice,
  });
  return [
    { label: texts.actionsGroup, kind: vscode.QuickPickItemKind.Separator },
    ...(['disabled', 'contextMenu', 'icons'] as const).map((value) => item(texts.actions[value].label, texts.actions[value].detail, actions === value, { key: 'dockerHostsActions', value })),
    { label: texts.logsGroup, kind: vscode.QuickPickItemKind.Separator },
    item(texts.logsOn.label, texts.logsOn.detail, logs, { key: 'allowContainerLogs', value: true }),
    item(texts.logsOff.label, texts.logsOff.detail, !logs, { key: 'allowContainerLogs', value: false }),
  ];
}

export interface DockerHostsSettingsDeps {
  logger: Logger;
  settings: () => ExtensionSettings;
}

/** The command Docker Hosts Settings… (devspaces.dockerHostsSettings): one choice writes one user setting. */
export async function chooseDockerHostsSettings(deps: DockerHostsSettingsDeps): Promise<void> {
  const settings = deps.settings();
  if (settings.dockerHostsSettingsButton !== true) {
    showInformationMessage(DockerHostsSettingsTexts.off).then(undefined, (error: unknown) => deps.logger.error('Could not show the message.', error));
    return;
  }
  const picked = await vscode.window.showQuickPick(dockerHostsSettingsItems(settings), { title: DockerHostsSettingsTexts.title, placeHolder: DockerHostsSettingsTexts.placeHolder });
  const choice = picked?.choice;
  if (choice === undefined) return;
  deps.logger.info(`Docker Hosts Settings: ${SETTINGS_SECTION}.${choice.key} = ${String(choice.value)} (user settings).`);
  await vscode.workspace.getConfiguration(SETTINGS_SECTION).update(choice.key, choice.value, vscode.ConfigurationTarget.Global);
}
