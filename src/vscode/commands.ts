// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The commands of package.json. No `vscode` import.

export const Commands = {
  start: 'devspaces.start',
  // Start in a new window, or (while the setting openInNewWindow is on) in the current window.
  startInNewWindow: 'devspaces.startInNewWindow',
  startInCurrentWindow: 'devspaces.startInCurrentWindow',
  // A new devspace of another GitHub account of Devspaces, or its devspace (row context menu only, hidden in the Command
  // Palette): on a row whose repository two or more accounts can access.
  startWithAccount: 'devspaces.startWithAccount',
  stop: 'devspaces.stop',
  delete: 'devspaces.delete',
  rebuild: 'devspaces.rebuild',
  showOnGitHub: 'devspaces.showOnGitHub',
  switchDevspace: 'devspaces.switchDevspace',
  // The switcher for a new window, or (while the setting openInNewWindow is on) for the current window.
  switchDevspaceInNewWindow: 'devspaces.switchDevspaceInNewWindow',
  switchDevspaceInCurrentWindow: 'devspaces.switchDevspaceInCurrentWindow',
  refresh: 'devspaces.refresh',
  search: 'devspaces.search',
  showLog: 'devspaces.showLog',
  signIn: 'devspaces.signIn',
  // Another GitHub account for Devspaces: the account picker of VS Code with "Sign in to another account".
  addAccount: 'devspaces.addAccount',
  selectOwners: 'devspaces.selectOwners',
  /** The same command with the filled filter icon, for the view title bar while the setting `owners` is set. */
  selectOwnersFiltered: 'devspaces.selectOwnersFiltered',
  // The switch of the setting showOnlyDevspaces; the view title bar shows one of the two.
  showOnlyDevspaces: 'devspaces.showOnlyDevspaces',
  showAllRepositories: 'devspaces.showAllRepositories',
  // Expand All in the view title bar, next to VS Code's own Collapse All.
  expandAll: 'devspaces.expandAll',
  // The editor of the setting repositoryGroups (Command Palette, view title "…" menu, link in the setting).
  editRepositoryGroups: 'devspaces.editRepositoryGroups',
  // The switch of the host access checks of a repository (row context menu only, hidden in the Command Palette).
  turnOffHostAccessChecks: 'devspaces.turnOffHostAccessChecks',
  turnOnHostAccessChecks: 'devspaces.turnOnHostAccessChecks',
  // The switch Keep Running When Closed of a devspace. The row context menu shows one of the two; the Command
  // Palette offers both with a picker of the devspaces, as Stop.
  keepRunning: 'devspaces.keepRunning',
  stopWhenClosed: 'devspaces.stopWhenClosed',
  // Close and Keep Running: closes the window of a devspace; its container keeps running this time. Only in a
  // window connected to a devspace (context key devspaces.connected) and in its row.
  closeAndKeepRunning: 'devspaces.closeAndKeepRunning',
  // The button Install WSL 2 of the Docker setup in the sidebar (welcome view), and Show Docker Setup, the action Show
  // Docker Setup… of the error dockerNotInstalled (both hidden in the Command Palette).
  dockerSetupInstallWsl: 'devspaces.dockerSetup.installWsl',
  dockerSetupShow: 'devspaces.dockerSetup.show',
  // Docker on another computer over SSH (a host of the list of Devspaces), and back.
  useRemoteDockerHost: 'devspaces.useRemoteDockerHost',
  // The choice of the Docker host, the command of the first row of the view (hidden in the Command Palette): another
  // remote host, or the local Docker.
  chooseDockerHost: 'devspaces.chooseDockerHost',
  // The WSL distribution of Devspaces on Windows (wslSetupCommands.ts): set up with Docker Engine inside (also a button
  // of the Docker setup in the sidebar), and removed.
  setUpWslDistribution: 'devspaces.setUpWslDistribution',
  removeWslDistribution: 'devspaces.removeWslDistribution',
  // The button "Remove and Set Up Again" of the error about a damaged disk of the distribution (hidden in the Command
  // Palette, because it removes the distribution without a question: the message says what it deletes).
  resetWslDistribution: 'devspaces.resetWslDistribution',
  // The Lima VM of Devspaces on macOS and Linux (limaSetupCommands.ts): set up with Docker Engine inside (also a button
  // of the Docker setup in the sidebar).
  setUpLimaVm: 'devspaces.setUpLimaVm',
  // The command of a repository row (TreeItem.command, hidden in the Command Palette): a double-click runs Start
  // (rowActivation.ts).
  rowActivated: 'devspaces.rowActivated',
  // Enter on a row without children in the view (a keybinding, hidden in the Command Palette): the activation of the
  // row that follows runs Start at once (rowActivation.ts).
  rowEnter: 'devspaces.rowEnter',
  // The Monitor of the current Docker engine runs its background run at once (the images in use, the VS Code
  // server and the extensions), for example after a new image was pushed (Command Palette, the "…" menu of the view).
  updateImagesNow: 'devspaces.updateImagesNow',
  // Removes what Devspaces keeps on the current Docker engine (the Monitor, the helper containers and images, the shared
  // volumes), and on request the devspaces of the signed-in account there (Command Palette, the "…" menu of the view).
  removeFromDockerEngine: 'devspaces.removeFromDockerEngine',
  // Removes Devspaces from this computer (R-GEN-009): from each remote Docker host of the list with the devspaces of the
  // signed-in accounts, the VM with its devspaces, the SSH key of Devspaces with its line on each host, and the files of
  // Devspaces; then VS Code uninstalls the extension (Command Palette, the "…" menu of the repository view).
  removeFromComputer: 'devspaces.removeFromComputer',
  // The view "Docker Hosts" (dockerHostsView.ts, R-ENG-008): Refresh of the view or of a host row (a host is read only
  // when the user opens it or clicks Refresh), Remove from the List of a remote host row, and Stop and Remove… of a
  // container, an image or a volume that is no object of a devspace of this computer (hidden in the Command Palette:
  // they take rows). The Docker host of Devspaces is chosen only in the first row of the repository view.
  refreshDockerHosts: 'devspaces.refreshDockerHosts',
  removeDockerHostFromList: 'devspaces.removeDockerHostFromList',
  stopDockerObject: 'devspaces.stopDockerObject',
  startDockerObject: 'devspaces.startDockerObject',
  pruneBuildCache: 'devspaces.pruneBuildCache',
  removeDockerObjects: 'devspaces.removeDockerObjects',
  // The utilization page of a host row of the view "Docker Hosts" (usagePage.ts, R-ENG-009): one page per host in the
  // editor (hidden in the Command Palette: it takes a row).
  showUtilization: 'devspaces.showUtilization',
  // A shell on the host of a host row of the view "Docker Hosts" (hostConsole.ts, R-ENG-008), shown with the setting
  // devspaces.dockerHostsConsoleButton (hidden in the Command Palette: it takes a row).
  openConsole: 'devspaces.openConsole',
  // The report page of an object row of the view "Docker Hosts" (reportPage.ts, R-ENG-010): the click on the row and
  // Show Report of its menu (hidden in the Command Palette: it takes a row).
  showResourceReport: 'devspaces.showResourceReport',
  // Show Log of a container row of the view Docker Hosts (R-ENG-008), while devspaces.allowContainerLogs is on.
  showContainerLog: 'devspaces.showContainerLog',
  // The VM of Devspaces in its row of the view "Docker Hosts" (vmCommands.ts, R-VM-010), the same on every platform:
  // Start, Stop, Remove, Remove and Set Up Again, and its settings (macOS and Linux).
  startVm: 'devspaces.startVm',
  stopVm: 'devspaces.stopVm',
  removeVm: 'devspaces.removeVm',
  resetVm: 'devspaces.resetVm',
  vmSettings: 'devspaces.vmSettings',
  // The gear in the title bar of the view "Docker Hosts" (dockerHostsSettings.ts, R-ENG-008), shown with the setting
  // devspaces.dockerHostsSettingsButton: a quick pick for the settings dockerHostsActions and allowContainerLogs
  // (hidden in the Command Palette: the settings are changed in the Settings editor).
  dockerHostsSettings: 'devspaces.dockerHostsSettings',
} as const;

export type CommandName = keyof typeof Commands;
