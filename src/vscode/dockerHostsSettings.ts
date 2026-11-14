// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The gear "Docker Hosts Settings…" in the title bar of the view Docker Hosts (docs/requirements.md R-ENG-008): a quick
// pick that switches the settings of the view in the user settings (all have the scope `application`):
// devspaces.dockerHostsActions, devspaces.allowDestructiveActions, devspaces.allowContainerLogs,
// devspaces.allowContentReads and devspaces.dockerHostsConsoleButton. The setting devspaces.dockerHostsSettingsButton shows the gear (it stays in the
// Settings editor: a gear that hid itself could not show itself again); the command is not in the Command Palette, and
// a run while the setting is off changes nothing.
import * as vscode from 'vscode';
import type { DockerHostsActions, ExtensionSettings } from '../core/types';
import type { Logger } from '../core/ports';
import { showInformationMessage } from './notifications';
import { SETTINGS_SECTION } from './settings';

export const DockerHostsSettingsTexts = {
  title: 'Docker Hosts Settings',
  placeHolder: 'Choose what the view Docker Hosts allows',
  actionsGroup: 'Actions of the view',
  destructiveGroup: 'Actions that remove or delete',
  logsGroup: 'Logs of containers',
  filesGroup: 'Files of volumes and images',
  consoleGroup: 'Open Console on the host rows',
  actions: {
    disabled: { label: 'Disabled', detail: 'The view is read only: no action changes a host.' },
    contextMenu: { label: 'Context Menu', detail: 'The actions are in the context menu of a row.' },
    icons: { label: 'Icons', detail: 'Every action is in the context menu of a row; those that remove nothing are also buttons on it.' },
  } satisfies Record<DockerHostsActions, { label: string; detail: string }>,
  logsOn: { label: 'Allow', detail: 'Show Log of every container, and the Docker pipe of Devspaces carries the log of any container.' },
  logsOff: { label: 'Do Not Allow', detail: 'No log of a container: the Docker pipe of Devspaces refuses every log.' },
  destructiveOn: {
    label: 'Allow',
    detail: 'Delete…, Remove…, Remove Unused Build Cache…, Remove from the List, Remove Devspaces from This Docker Engine… and the removals of the VM in the context menu of a row (with Context Menu or Icons).',
  },
  destructiveOff: { label: 'Do Not Allow', detail: 'The view has no action that removes or deletes something; the Command Palette keeps its commands.' },
  filesOn: { label: 'Allow', detail: 'Show Files of every volume and image: the tree of its folders and files, with names, sizes and times, never the content of a file.' },
  filesOff: { label: 'Do Not Allow', detail: 'No Show Files: Devspaces reads no folder or file of a volume or an image for it.' },
  consoleOn: { label: 'Show', detail: 'A button on each host row opens a terminal with a shell on that host.' },
  consoleOff: { label: 'Hide', detail: 'No Open Console on the host rows.' },
  current: 'current',
  off: 'The Docker Hosts Settings button is off: turn on the setting devspaces.dockerHostsSettingsButton, or change the settings in the Settings editor.',
};

/** One choice of the quick pick: the setting that it writes, and its value. */
export interface DockerHostsSettingsChoice {
  key: 'dockerHostsActions' | 'allowDestructiveActions' | 'allowContainerLogs' | 'allowContentReads' | 'dockerHostsConsoleButton';
  value: DockerHostsActions | boolean;
}

type Item = vscode.QuickPickItem & { choice?: DockerHostsSettingsChoice };

/** The items of the quick pick: a group per setting, the current value of each marked. */
export function dockerHostsSettingsItems(
  settings: Pick<ExtensionSettings, 'dockerHostsActions' | 'allowDestructiveActions' | 'allowContainerLogs' | 'allowContentReads' | 'dockerHostsConsoleButton'>,
): Item[] {
  const texts = DockerHostsSettingsTexts;
  const actions = settings.dockerHostsActions ?? 'disabled';
  const destructive = settings.allowDestructiveActions === true;
  const logs = settings.allowContainerLogs === true;
  const files = settings.allowContentReads === true;
  const consoleButton = settings.dockerHostsConsoleButton === true;
  const item = (label: string, detail: string, current: boolean, choice: DockerHostsSettingsChoice): Item => ({
    label: `${current ? '$(check)' : '$(blank)'} ${label}`,
    detail,
    ...(current ? { description: texts.current } : {}),
    choice,
  });
  return [
    { label: texts.actionsGroup, kind: vscode.QuickPickItemKind.Separator },
    ...(['disabled', 'contextMenu', 'icons'] as const).map((value) => item(texts.actions[value].label, texts.actions[value].detail, actions === value, { key: 'dockerHostsActions', value })),
    { label: texts.destructiveGroup, kind: vscode.QuickPickItemKind.Separator },
    item(texts.destructiveOn.label, texts.destructiveOn.detail, destructive, { key: 'allowDestructiveActions', value: true }),
    item(texts.destructiveOff.label, texts.destructiveOff.detail, !destructive, { key: 'allowDestructiveActions', value: false }),
    { label: texts.logsGroup, kind: vscode.QuickPickItemKind.Separator },
    item(texts.logsOn.label, texts.logsOn.detail, logs, { key: 'allowContainerLogs', value: true }),
    item(texts.logsOff.label, texts.logsOff.detail, !logs, { key: 'allowContainerLogs', value: false }),
    { label: texts.filesGroup, kind: vscode.QuickPickItemKind.Separator },
    item(texts.filesOn.label, texts.filesOn.detail, files, { key: 'allowContentReads', value: true }),
    item(texts.filesOff.label, texts.filesOff.detail, !files, { key: 'allowContentReads', value: false }),
    { label: texts.consoleGroup, kind: vscode.QuickPickItemKind.Separator },
    item(texts.consoleOn.label, texts.consoleOn.detail, consoleButton, { key: 'dockerHostsConsoleButton', value: true }),
    item(texts.consoleOff.label, texts.consoleOff.detail, !consoleButton, { key: 'dockerHostsConsoleButton', value: false }),
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
