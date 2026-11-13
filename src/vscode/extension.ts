// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// Extension entry (esbuild entry of dist/extension.js): the composition root. activate() builds the components,
// registers the commands and listeners, and runs the tasks of the window role. Only the open pipeline of a restored
// window (role A) is awaited; everything else runs in the background.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { attachDiagnostics } from '../core/docker/attachDiagnostics';
import { BootstrapDocker } from '../core/docker/bootstrapDocker';
import { addDockerFolderToPath, dockerProcessEnv, findDockerCli, findExecutable, putFolderFirstInPath } from '../core/docker/dockerCli';
import { LOCAL_CLI_VERSION_FORMAT, LOCAL_CLI_VERSION_TIMEOUT_MS, localDockerCliApi, type DockerCliApi } from '../core/docker/dockerApiVersion';
import { ownDockerCliDownload, OWN_DOCKER_CLI_API, OWN_DOCKER_CLI_VERSION, presentOwnDockerCli } from '../core/docker/ownDockerCli';
import { WslSetup, dockerDesktopIntegrates, readWindowsArch, wslSetupFolder } from '../core/docker/wslSetup';
import { WslAfterInstall } from '../core/docker/wslAfterInstall';
import { WslKeeper, wslgPathOf } from '../core/docker/wslKeeper';
import { WSL_TASK_FOLDER, WslTask } from '../core/docker/wslTask';
import { WslLifetime } from '../core/docker/wslLifetime';
import {
  LIMA_HOST,
  WSL_DISTRIBUTION,
  WSL_HOST,
  WSL_LIST_ARGS,
  describeDockerHost,
  devspacesOfHost,
  dockerHostOf,
  hostAccessOf,
  isVmHost,
  parseWslList,
  remoteDockerTarget,
  sshCommandArgs,
  transportProgramOf,
  usesComputerDocker,
  wslCommandArgs,
  wslEnv,
  type DockerTarget,
} from '../core/docker/dockerHost';
import { RemovedEngineError, removedEngineImageNote, removedEngineNote } from '../core/docker/engineRemoval';
import { ensureDockerRunning, launchDetachedProcess } from '../core/docker/dockerStart';
import { DockerTargets, operationDockerTarget, outsideOperation, runWithDockerTarget, withoutMissingVm } from '../core/docker/dockerTargets';
import { SshLoginCache, noPromptEnv, sshHostsOfContexts, startDockerFor, type RemoteReachabilityDeps } from '../core/docker/remoteDocker';
import { RelayConnectionError } from '../core/relay/connection';
import { limaHostTransport, openRelayConnection, sshHostTransport, wslHostTransport, wslProcess } from '../core/relay/transport';
import { deferredByteProcess } from '../core/relay/deferredProcess';
import { CONTAINER_LOGS_OFF } from '../core/relay/dockerPipeRules';
import { presentLima } from '../core/vm/lima';
import { LimaVm } from '../core/vm/limaVm';
import { LimaSetup } from '../core/vm/limaSetup';
import { freeSpace, limaVmState, wslVmState, type VmState } from '../core/vm/vmState';
import { readMonitorLog } from '../core/hosts/monitorLog';
import { readResourceReport } from '../core/hosts/reportRead';
import { baseImageReferences, helperBaseImageReferences, knownDevspace, pruneBuildCache, readHostInventory, removeHostObjects, runningDevspaces, startHostContainer, stopHostContainer } from '../core/hosts/hostObjects';
import { limaDockerSocket, limaEnv, limaResources, type LimaResources } from '../core/vm/limaInstance';
import { consoleResizeCommand, limaConsoleArgs, sshConsoleArgs, wslConsoleArgs, wslConsoleResizeArgs } from '../core/hosts/hostConsole';
import { OomWatch } from '../core/vm/oomKills';
import { readVmArch } from '../core/vm/vmArch';
import { VmTask, vmTaskPaths, vscodeElectron } from '../core/vm/vmTask';
import { DOCKER_CONTEXT_TIMEOUT_MS, dockerConfigDir, dockerContextFile, syncDockerContext } from '../core/vm/dockerContext';
import { RelayConnections, relayAccess } from '../core/relay/connections';
import { serveWindowPipe, windowDockerHost } from '../core/relay/windowPipe';
import { HostPipes } from '../core/relay/hostPipes';
import { RemoteShells, type RemoteShellStart } from '../core/relay/remoteShells';
import { contextPipeAddress, dockerPipeBase, dockerPipeId, parseDockerPipeHost } from '../core/relay/pipeAddress';
import { ContextPipe } from '../core/relay/contextPipe';
import { processDockerDial } from '../core/relay/dockerPipe';
import { sshPromptSignal, sshPromptsAllowed } from '../core/sshAskpass';
import { DiscoveryService } from '../core/discovery/discoveryService';
import { GitHubApi } from '../core/discovery/githubApi';
import { sameScope } from '../core/discovery/scope';
import { errorMessage, UserFacingError } from '../core/errors';
import { helperImageTag, registryBaseDigest } from '../core/helper/helperImage';
import { HelperPrebuild, dockerEngineAnswers, type DockerEngineAnswersDeps } from '../core/helper/helperPrebuild';
import { MissingHelperBuild } from '../core/helper/missingHelperBuild';
import { HelperImages, helperDockerSocket } from '../core/helper/helperImages';
import { HelperChannels, openHelperChannel } from '../core/helperChannel/helperChannels';
import { HelperChannelError } from '../core/helperChannel/helperChannel';
import { Messages } from '../core/messages';
import { nodeHttpsTransport, takeUserAgentVersion, userAgentVersion } from '../core/http';
import { DockerCredentialStore } from '../core/imageCheck/credentials';
import { RegistryClient } from '../core/imageCheck/registryClient';
import { abortError, isoTime, systemClock, type RunResult, type StartedByteProcess } from '../core/ports';
import { usableTimeZone } from '../core/remoteMonitor/cron';
import { monitorSettingsOf } from './monitorSettings';
import { REMOTE_MONITOR_VOLUME } from '../core/remoteMonitor/protocol';
import { DevspaceOperations } from '../core/pipeline/devspaceOperations';
import { windowLifecycleMemory } from '../core/pipeline/lifecycleMemory';
import type { DockerStarter } from '../core/pipeline/operationBase';
import { NodeProcessRunner } from '../core/process';
import { nodeSshConfigFiles, parseSshConfig } from '../core/sshConfig';
import { ClosingWork } from '../core/session/closingWork';
import { heartbeatWiring } from '../core/session/heartbeatWiring';
import { WindowHeartbeats, hostEngine, resolveHeartbeatEngine } from '../core/session/windowHeartbeats';
import { isHandedOffStop, releaseDevspace } from '../core/session/windowRelease';
import { readOrCreateComputerId } from '../core/storage/computerId';
import { DockerEngineRecords } from '../core/storage/dockerEngineRecords';
import { devspacesUsed } from '../core/storage/firstUse';
import { StoragePaths } from '../core/storage/paths';
import { ConfigCheckStore } from '../core/storage/configChecks';
import { bundleHash } from '../core/loader/pipeLoader';
import { DevspaceRegistry } from '../core/storage/registry';
import { showWarningMessage } from './notifications';
import { backgroundEngineAtStart, backgroundWorkAtStart, findWindowDevspace, removedEngineWindowDevspace, restoreAfterPrebuild, windowDevspaceName, type ContainerDevspace } from './windowDevspace';
import { workerMonitor } from './workerMonitor';
import { defaultExtensionEntries, windowVscodeServer } from './vscodeServer';
import { HELPER_DOCKER_SOCKET, VSCODE_STORE_VOLUME } from '../core/names';
import { RemoteDockerState } from '../core/storage/remoteDockerState';
import { SessionFiles } from '../core/storage/sessionFiles';
import type { ExtensionSettings } from '../core/types';
import { AccountOffers } from './accountOffers';
import { VsCodeGitHubAuth, watchGitHubEnterpriseSettings } from './auth';
import { ComputerCleanup, computerVmState } from './computerCleanup';
import { ConnectionAdapter } from './connectionAdapter';
import { installOwnDockerCliWithProgress, OwnDockerCliTexts } from './ownDockerCliWindow';
import { Controller } from './controller';
import { DisconnectRequests } from './disconnectRequests';
import { dockerAdapterOptions } from './dockerAdapterOptions';
import { DockerHostIndicator } from './dockerHostIndicator';
import { DockerHostsView } from './dockerHostsView';
import { ReportPages } from './reportPage';
import { HostConsoles } from './hostConsole';
import { chooseDockerHostsSettings } from './dockerHostsSettings';
import { UsagePages } from './usagePage';
import { DOCKER_HOSTS_VIEW_ID } from './dockerHostsModel';
import { DockerSetup, currentUserName, readOsRelease } from './dockerSetup';
import { installTerminalOptions, terminalLines } from '../core/docker/dockerSetup';
import { OutputChannelLogger } from './logger';
import { updateOwnersContextKey } from './ownerSelector';
import { updateDevspacesOnlyContextKey } from './devspacesOnly';
import { isProcessAlive } from '../core/session/sessionRules';
import { extensionFlow, extensionHostSide, type HostSideDeps } from './hostSide';
import { VsCodePipelineUi } from './pipelineUi';
import { onDidChangeBusy } from './progress';
import { SshAskpassServer, vscodeSshLoginDialogs, type SshLogin } from './sshLoginPrompts';
import { SshKeyOffer, vscodeSshKeyDialogs } from './sshKeyOffer';
import { GroupMatchWorkerRunner } from './groupMatcher';
import { PreviewWorkerRunner } from './groupsPreviewRunner';
import { RemoteDockerCommands } from './remoteDockerCommands';
import { RowColorDecorations } from './rowColors';
import { WslSetupCommands } from './wslSetupCommands';
import { LimaSetupCommands, LimaSetupTexts } from './limaSetupCommands';
import { VmCommands } from './vmCommands';
import { RepositoryGroupsEditor } from './repositoryGroupsEditor';
import { SessionCoordinator } from './sessionCoordinator';
import {
  affectsSettings,
  devContainersDefaultExtensionsValue,
  dockerHostsActionsAllowed,
  readSettings,
  SETTINGS_SECTION,
  showSettingWarning,
  warnInvalidCacheUpdateSchedule,
  warnInvalidDefaultImage,
  warnVmResources,
  warnInvalidHostAccessChecksOff,
} from './settings';
import { Sidebar } from './sidebar';
import { DevspaceStatusBar } from './statusBar';
import { Throttle } from './tasks';
import { REPOSITORIES_VIEW_ID, RepositoriesTreeProvider, expandAll, revealRow, type TreeNode } from './treeView';

/** A window that gets the focus refreshes the sidebar at most this often. */
const FOCUS_REFRESH_INTERVAL_MS = 15_000;

/** Time limit of `wsl.exe --list --quiet`, which may start the WSL service; the choice of the host waits for it. */
const WSL_LIST_TIMEOUT_MS = 5_000;

/** Kept for deactivate(). */
let coordinator: SessionCoordinator | undefined;
/**
 * The work of deactivate() (the release of the window's devspace, bounded). VS Code disposes the subscriptions right
 * after it calls deactivate(); the worker channels, the preparation of the heartbeats, and the logger are disposed only
 * after it settled (ClosingWork.deferred), so the release still has its worker, can open it again, and logs to a live
 * channel.
 */
const closingWork = new ClosingWork();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // The reopen rule measures the age of the reopen record at this time, before any await.
  const activatedAt = systemClock.now();
  const logger = new OutputChannelLogger();
  // The release of deactivate() still logs.
  context.subscriptions.push(closingWork.deferred(logger));
  // The version of the manifest for the header User-Agent of the HTTPS requests, before any request; the worker gets
  // it at its start (channelRunArgs). No bundle holds the version.
  const manifestVersion: unknown = context.extension.packageJSON?.version;
  const invalidVersion = takeUserAgentVersion(manifestVersion, 'The version in the manifest of Devspaces');
  if (invalidVersion !== undefined) logger.warn(invalidVersion);
  // Links to Devspaces wait for the end of the activation, also of one that failed (Controller.setActivation).
  let activationEnded!: () => void;
  const activation = new Promise<void>((resolve) => (activationEnded = resolve));
  try {
    await activateExtension(context, logger, activatedAt, activation);
  } catch (error) {
    logger.error('Devspaces could not be started.', error);
    throw error;
  } finally {
    activationEnded();
  }
}

/**
 * The synchronous `closing` write and the reopen record first. Then, best effort and within about 2 seconds
 * (CLOSE_RELEASE_BOUNDS), the recorded state of the repository and the short release of the window's devspace; VS
 * Code gives deactivate() little time, and a lost release leaves the long limit of the heartbeats.
 */
export function deactivate(): Promise<void> | undefined {
  // Never throws; the disposals of ClosingWork.deferred wait for this promise.
  return closingWork.begin(() => coordinator?.deactivate());
}

async function activateExtension(
  context: vscode.ExtensionContext,
  logger: OutputChannelLogger,
  activatedAt: number,
  activation: Promise<void>,
): Promise<void> {
  const platform = process.platform;
  const env = process.env;
  const paths = new StoragePaths(context.globalStorageUri.fsPath);
  try {
    paths.ensureDirectoriesSync();
  } catch (error) {
    logger.warn(`The storage folder ${paths.root} could not be created: ${errorMessage(error)}`);
  }
  let settings: ExtensionSettings = readSettings();
  const getSettings = (): ExtensionSettings => settings;
  // Invalid entries of devspaces.hostAccessChecksOff are ignored, and so is an invalid devspaces.defaultImage; in place
  // of an invalid devspaces.cacheUpdateSchedule, the Monitor uses the default: a line in the log at the start and at
  // each change of the setting, and a warning once per window session for each invalid value, until the setting has a
  // valid value again (one set of shown warnings per setting).
  const hostAccessWarnings = new Set<string>();
  const defaultImageWarnings = new Set<string>();
  const cacheScheduleWarnings = new Set<string>();
  warnInvalidHostAccessChecksOff(logger, hostAccessWarnings);
  warnInvalidDefaultImage(logger, defaultImageWarnings);
  warnInvalidCacheUpdateSchedule(logger, cacheScheduleWarnings);
  // The memory and the CPUs of the Lima VM of Devspaces (macOS and Linux, R-VM-006): the settings, each at most half of
  // this computer; a larger value is named in a warning.
  const machine = { totalMemory: os.totalmem(), cpus: os.availableParallelism() };
  const vmResourceWarnings = { memory: new Set<string>(), cpus: new Set<string>() };
  const hasLimaVm = platform === 'darwin' || platform === 'linux';
  if (hasLimaVm) warnVmResources(logger, vmResourceWarnings, settings, machine);
  const vmWish = (): Partial<LimaResources> => ({ memoryGiB: settings.vmMemoryGiB, cpus: settings.vmCpus });
  const oomWatch = new OomWatch({
    log: (host, added) => logger.warn(Messages.oomKilled(hostAccessOf(host)?.kind === 'lima' ? 'the VM of Devspaces' : describeDockerHost(host), added)),
    warn: (host, added) => {
      if (hostAccessOf(host)?.kind !== 'lima') return;
      const given = limaResources(machine.totalMemory, machine.cpus, vmWish()).memoryGiB;
      const most = limaResources(machine.totalMemory, machine.cpus, { memoryGiB: Number.MAX_SAFE_INTEGER }).memoryGiB;
      showSettingWarning(logger, 'vmMemoryGiB', Messages.vmOutOfMemory(added, given, most));
    },
  });

  const runner = new NodeProcessRunner();
  // The window of an attached container, also in the names of its workers (ConnectionAdapter.windowName).
  const connection = new ConnectionAdapter(logger);
  const installedCli = findDockerCli(env, platform);
  logger.info(installedCli ? `Docker CLI: ${installedCli}` : 'This computer has no Docker CLI of its own (Docker Desktop or Docker Engine).');
  // The Docker CLI of Devspaces, one tested version (docs/architecture.md "The Docker CLI of Devspaces"), where Docker
  // publishes one that runs here. In every window, the Docker calls of Devspaces on a remote host take it when it is
  // installed, also on a computer without a Docker CLI (BootstrapDocker option ownCli); the other calls keep the Docker
  // CLI of this computer. The window of a devspace on another computer (its authority names a Docker pipe) runs the Dev
  // Containers extension with it too: its folder goes first in PATH of this extension host, before the Dev Containers
  // extension resolves the window. A CLI that this window needs and is not installed yet is downloaded below, before the
  // window looks up its devspace and serves its pipe; "Use a Remote Docker Host…" downloads it on a computer without a
  // Docker CLI.
  const pipeWindow = connection.currentDockerHost() !== undefined;
  const ownCliBuild = ownDockerCliDownload(platform, process.arch) !== undefined;
  if (pipeWindow && !ownCliBuild) {
    logger.info(`Docker publishes no Docker CLI for ${platform} on ${process.arch} that runs here, so this window uses the Docker CLI of this computer.`);
  }
  const presentOwnCli = (): string | undefined => (ownCliBuild ? presentOwnDockerCli(paths.dockerCliDir, platform, process.arch) : undefined);
  // Without a Docker CLI of this computer, the log names the Docker CLI of Devspaces, which runs the calls on a remote
  // host (the window of a devspace names it below, when it puts it first in PATH).
  if (installedCli === undefined && !pipeWindow) {
    const present = presentOwnCli();
    if (present !== undefined) logger.info(`The Docker CLI ${OWN_DOCKER_CLI_VERSION} of Devspaces is installed: ${present}`);
  }
  // Whether this window put the Docker CLI of Devspaces first in PATH (useOwnDockerCli).
  let ownCliInPath = false;
  const useOwnDockerCli = (cli: string): void => {
    ownCliInPath = true;
    putFolderFirstInPath(process.env, platform, path.dirname(cli));
    logger.info(`The Docker CLI ${OWN_DOCKER_CLI_VERSION} of Devspaces is first in PATH of this window: ${cli}`);
  };
  const ownCli = pipeWindow ? presentOwnCli() : undefined;
  if (ownCli !== undefined) useOwnDockerCli(ownCli);
  // The Docker CLI of this computer where the windows run it for a remote engine: in the window of a devspace without
  // the Docker CLI of Devspaces in PATH (no build for this computer, or a failed download), and in the other windows
  // where Docker publishes no such build. Read once, in the background: `docker version` prints the versions of the CLI
  // also when it reaches no engine, so it gets an address that nobody serves (and no context). Only its newest API
  // version (localDockerCliApi); undefined until it is read, and when it cannot be.
  let localCliApi: DockerCliApi | undefined;
  const readLocalCliApi = async (cli: string): Promise<void> => {
    const noEngine = platform === 'win32' ? `npipe:////./pipe/devspaces-no-docker-engine-${process.pid}` : `unix://${path.join(paths.root, 'no-docker-engine.sock')}`;
    const cliEnv: NodeJS.ProcessEnv = { ...dockerProcessEnv(env, platform, cli), DOCKER_HOST: noEngine };
    delete cliEnv.DOCKER_CONTEXT;
    const result = await runner.run(cli, ['version', '--format', LOCAL_CLI_VERSION_FORMAT], { env: cliEnv, timeoutMs: LOCAL_CLI_VERSION_TIMEOUT_MS });
    localCliApi = localDockerCliApi(result.stdout);
    if (localCliApi === undefined) {
      logger.warn(`The API version of the Docker CLI of this computer could not be read, so it is not checked against remote engines: ${(result.stderr || result.stdout).trim().slice(-500) || 'no output'}`);
    } else {
      logger.info(`${localCliApi.name.charAt(0).toUpperCase()}${localCliApi.name.slice(1)} speaks the Docker API up to version ${localCliApi.range.max}.`);
    }
  };
  if (installedCli !== undefined && (pipeWindow ? ownCli === undefined : !ownCliBuild)) {
    void readLocalCliApi(installedCli).catch((error: unknown) => logger.warn(`The API version of the Docker CLI of this computer could not be read: ${errorMessage(error)}`));
  }
  // The Docker CLI whose API versions are checked against a remote engine (dockerApiVersion.ts): the Docker CLI of
  // Devspaces in the window of a devspace when it put that CLI first in PATH, which its Dev Containers extension runs,
  // and in another window where Docker publishes it for this computer, as the windows of devspaces download and run it,
  // also the first one; else the Docker CLI of this computer.
  const dockerCliApi = (): DockerCliApi | undefined =>
    (pipeWindow ? ownCliInPath : ownCliBuild)
      ? { name: `the Docker CLI ${OWN_DOCKER_CLI_VERSION} of Devspaces`, range: OWN_DOCKER_CLI_API, kind: 'devspaces' }
      : localCliApi;
  const dockerPath = installedCli ?? ownCli;
  // Windows: the Dev Containers extension, which connects the windows to the containers, runs in this extension host and
  // looks up `docker` in its PATH and in C:\Program Files\Docker\Docker\resources\bin only. A CLI that Devspaces found
  // elsewhere, for example of a per-user Docker Desktop installed after VS Code (or the browser that opened a link of
  // Devspaces) started, gets its folder at the end of PATH of this extension host, so that the Dev Containers extension
  // uses the same CLI. Devspaces activates before the Dev Containers extension resolves the window of a devspace
  // (ATTACHED_CONTAINER_ACTIVATION_EVENT), and this runs before the first await of the activation (the download of the
  // Docker CLI of Devspaces comes later).
  const shareDockerFolder = (cli: string): void => {
    if (addDockerFolderToPath(process.env, platform, cli)) {
      logger.info(`The folder of the Docker CLI was added to PATH of the extension host: ${path.win32.dirname(cli)}`);
    }
  };
  if (dockerPath) shareDockerFolder(dockerPath);
  // Set below; the adapter reports each `docker info` to it (context key devspaces.dockerReady).
  let dockerSetup: DockerSetup | undefined;
  // The worker (the helper channels), set below; its failed opens are tried again at once when the Docker engine begins
  // to answer.
  let helperChannels: HelperChannels | undefined;
  // The background build of a helper image that the refresh found missing, and the sidebar that it refreshes
  // afterwards; both set below.
  let missingHelperBuild: MissingHelperBuild | undefined;
  let sidebarOfBuild: Sidebar | undefined;
  // The background prebuild of the helper image at the start, set below; "Remove Devspaces from This Docker Engine…"
  // stops it on its engine.
  let backgroundPrebuild: HelperPrebuild | undefined;
  let daemonRunning = false;
  const adapterOptions = dockerAdapterOptions(() => dockerSetup);
  // The Docker pipes of the extension, one per remote host, and the shells before the relay; both set below.
  let hostPipes: HostPipes | undefined;
  let remoteShells: RemoteShells | undefined;
  // The key of Devspaces for its SSH logins (the key offer), set below; the `ssh` of the Docker CLI uses it too.
  let keyOffer: SshKeyOffer | undefined;
  // The keeper of the WSL distribution of Devspaces at each `wsl.exe` of this window, and the rule for the Docker calls
  // in the background there (WslLifetime); set below, once the settings of the Monitor are known.
  let wslLifetime: WslLifetime | undefined;
  // WslLifetime.leavesStopped, for the checks whether an engine answers and for the refresh of the states.
  const leavesStopped = (host: string): Promise<boolean> => wslLifetime?.leavesStopped(host) ?? Promise.resolve(false);
  // Docker Desktop installed, updated, uninstalled or moved while VS Code runs is found or lost without a reload. The
  // Docker CLI of the extension is only the bootstrap's (BootstrapDocker). Its calls of an operation on an SSH host go
  // through the Docker pipe of the extension for the host while a connection of the relay to it is open; on the VM of
  // Devspaces (its WSL distribution, or its Lima VM) always through its pipe.
  const docker = new BootstrapDocker(runner, dockerPath, env, logger, platform, {
    ...adapterOptions,
    dockerPipe: (target) => hostPipes?.dockerHost(target.host),
    // The pipe of the VM of Devspaces listens from the first Docker call of an operation there.
    servePipe: async (target) => {
      if (isVmHost(target.host)) await hostPipes?.serve(target.host);
    },
    // A call of an operation that only reads, while the host has no pipe: on the shell before the relay of the host.
    remoteShell: (target, args, options) => remoteShells?.docker(target.host, args, options) ?? Promise.resolve(undefined),
    // A call with `ssh://<host>`: the `ssh` of the Docker CLI with the key of Devspaces when the host has it.
    sshEnv: (host, callEnv) => keyOffer?.dockerSshEnv(host, callEnv),
    // The calls of an operation on a remote host: the Docker CLI of Devspaces when it is installed.
    ownCli: presentOwnCli,
    // The build container of the helper image mounts the Docker socket of its engine, as the worker there does. Outside
    // an operation, the engine is the local Docker of the current Docker context.
    engineSocket: async (target): Promise<string> => engineSocket(target ?? (await targets.ofHost(''))),
    onCliFound: shareDockerFolder,
    onDaemonStatus: (running) => {
      if (running && !daemonRunning) helperChannels?.clearFailures();
      daemonRunning = running;
      adapterOptions.onDaemonStatus?.(running);
    },
  });
  // The Docker host of Devspaces (its own VM, or a host of its own list), read at the start of each operation. Devspaces
  // never uses the Docker of this computer (R-ENG-001): without a host, the sidebar shows the Docker setup.
  const remoteState = new RemoteDockerState(paths.remoteDocker, logger);
  // Whether the own VM of Devspaces exists (withoutMissingVm): while the chosen VM does not exist, Devspaces has no Docker
  // host, and the sidebar shows the setup of the VM. Set below with the VM; until then, it exists.
  let ownVmExists = async (_host: string): Promise<boolean> => true;
  const targets = new DockerTargets(docker, env, logger, platform, withoutMissingVm(remoteState, (host) => ownVmExists(host), logger), usesComputerDocker());
  // What this computer remembers about each Docker engine (docker-engines.json): the removal mark of "Remove Devspaces
  // from This Docker Engine…".
  const engineRecords = new DockerEngineRecords(paths.dockerEngines, { logger });
  // After "Remove Devspaces from This Docker Engine…", this computer does no Docker work on that engine by itself (no
  // worker for a passive read, no background build of the helper image, no background work at the start) until a
  // Start, a Rebuild or "Update All Images Now" of the user there clears the mark. A file that cannot be read, also after
  // the retries of a transient error, has no mark here (logged).
  const engineRemoved = async (target: Pick<DockerTarget, 'host'>): Promise<boolean> => {
    try {
      return await engineRecords.removed(target.host);
    } catch (error) {
      logger.warn(`The records of the Docker engines could not be read: ${errorMessage(error)}`);
      return false;
    }
  };
  const sshPath = (): string | undefined => findExecutable('ssh', env, platform);
  // `wsl.exe` for the WSL distribution of Devspaces (docs/architecture.md "The WSL distribution of Devspaces"); only on
  // Windows.
  const wslPath = (): string | undefined => (platform === 'win32' ? findExecutable('wsl', env, platform) : undefined);
  /** `wsl.exe --list --quiet` (WSL_LIST_ARGS): the WSL distributions of this Windows user; undefined without `wsl.exe`. */
  const runWslList = async (): Promise<RunResult | undefined> => {
    const wsl = wslPath();
    return wsl === undefined ? undefined : runner.run(wsl, WSL_LIST_ARGS, { env: wslEnv(env), timeoutMs: WSL_LIST_TIMEOUT_MS });
  };
  // The Lima VM of Devspaces (docs/architecture.md "The Lima VM of Devspaces"); only on macOS and Linux. Each transport to
  // it starts it first when it is stopped (LimaVm.ready). Its processor is the one of this computer, also when VS Code for
  // Intel runs under Rosetta (readVmArch asks sysctl only then).
  const vmArch = hasLimaVm ? await readVmArch(runner, platform, process.arch, logger) : process.arch;
  const limaVm = hasLimaVm
    ? new LimaVm({ runner, logger, platform, arch: vmArch, env, resources: () => limaResources(machine.totalMemory, machine.cpus, vmWish()) })
    : undefined;
  // The pipe of the Docker context `devspaces` on Windows (R-ENG-007): one window of the Windows user serves it while
  // the setting createDockerContext is on and the WSL distribution of Devspaces exists; each connection runs its own
  // `wsl.exe … docker system dial-stdio` there (dialStdio).
  const contextPipe =
    platform === 'win32'
      ? new ContextPipe({
          logger,
          address: contextPipeAddress(`${env.USERDOMAIN ?? ''}\\${currentUserName() ?? env.USERNAME ?? ''}`),
          connect: processDockerDial(
            () => {
              const dial = dialStdio(WSL_HOST);
              if (dial === undefined) throw new Error('wsl.exe was not found.');
              return dial;
            },
            logger,
            'the Docker context devspaces',
          ),
        })
      : undefined;
  context.subscriptions.push({ dispose: () => contextPipe?.stop() });
  /**
   * The Docker host of the context `devspaces` as the setting createDockerContext asks: the Docker socket of the Lima VM,
   * or on Windows the pipe of the context while the WSL distribution of Devspaces exists; undefined: no context.
   */
  const vmContextHost = async (): Promise<string | undefined> => {
    if (settings.createDockerContext !== true) return undefined;
    if (limaVm !== undefined) return `unix://${limaDockerSocket(limaVm.paths)}`;
    if (contextPipe === undefined || wslSetupCore === undefined) return undefined;
    const registration = await wslSetupCore.registration().catch((error: unknown) => {
      logger.info(`Whether the WSL distribution of Devspaces exists could not be read, so the Docker context devspaces waits: ${errorMessage(error)}`);
      return undefined;
    });
    if (registration !== undefined) wslDistributionKnown(registration !== 'none');
    return registration === 'own' ? contextPipe.address.dockerHost : undefined;
  };
  // The Docker context `devspaces` of the VM of Devspaces (R-ENG-007): created while the setting createDockerContext is
  // on, removed when it is off; only a context with the description of Devspaces. It reads the context store first and
  // runs the Docker CLI (of this computer, else of Devspaces) only for a change, without DOCKER_HOST and DOCKER_CONTEXT,
  // so that it sees the current context of the Docker CLI. At the start of the window and after the setup or the removal
  // of the VM it only logs; a change of the setting also shows what went wrong. One run at a time, so that two runs never
  // both create the context.
  let dockerContextRun: Promise<void> = Promise.resolve();
  const syncVmDockerContext = (byUser: boolean): Promise<void> => (dockerContextRun = dockerContextRun.catch(() => undefined).then(() => syncVmDockerContextNow(byUser)));
  const syncVmDockerContextNow = async (byUser: boolean): Promise<void> => {
    if (limaVm === undefined && contextPipe === undefined) return;
    const host = await vmContextHost();
    if (contextPipe !== undefined) {
      if (host === undefined) contextPipe.stop();
      else await contextPipe.serve();
    }
    const cli = installedCli ?? presentOwnCli();
    const cliEnv: NodeJS.ProcessEnv = cli === undefined ? {} : dockerProcessEnv(env, platform, cli);
    delete cliEnv.DOCKER_HOST;
    delete cliEnv.DOCKER_CONTEXT;
    const result = await syncDockerContext(
      {
        file: dockerContextFile(dockerConfigDir(env, platform)),
        docker: cli === undefined ? undefined : (args) => runner.run(cli, args, { env: cliEnv, timeoutMs: DOCKER_CONTEXT_TIMEOUT_MS }),
      },
      host,
    );
    let problem: string | undefined;
    switch (result.kind) {
      case 'unchanged':
        return;
      case 'created':
      case 'updated':
        logger.info(Messages.dockerContextCreated);
        return;
      case 'removed':
        logger.info(Messages.dockerContextRemoved);
        return;
      case 'noCli':
        logger.info(Messages.dockerContextNoCli);
        return;
      case 'taken':
        problem = Messages.dockerContextTaken;
        break;
      case 'current':
        problem = Messages.dockerContextCurrent;
        logger.info(`docker context rm: ${result.detail}`);
        break;
      case 'failed':
        problem = Messages.dockerContextFailed(result.detail);
        break;
    }
    logger.warn(problem);
    if (byUser) showSettingWarning(logger, 'createDockerContext', problem);
  };
  /**
   * The transport `command` to the Lima VM of Devspaces with the program `ssh` (limaHostTransport): its `ssh` starts when
   * the VM runs. Undefined without `ssh` or where Devspaces has no Lima VM.
   */
  const limaProcess = (ssh: string | undefined, command?: string): StartedByteProcess | undefined => {
    if (ssh === undefined || limaVm === undefined) return undefined;
    return deferredByteProcess(async (signal) => {
      await limaVm.ready(signal);
      if (signal.aborted) throw abortError();
      const transport = limaHostTransport(limaVm.paths, ssh, env, command);
      const started = runner.startBytes(transport.file, transport.args, { env: transport.env });
      // A failed transport may mean a VM that stopped meanwhile: the next transport checks it again.
      void started.exited.then(({ exitCode }) => {
        if (exitCode === 255) limaVm.forgetRunning();
      });
      return started;
    });
  };
  /** Whether the program of the transport of the remote host `host` is found (`ssh`, or `wsl.exe` for WSL). */
  const transportFound = (host: string): boolean => {
    const access = hostAccessOf(host);
    if (access === undefined) return false;
    if (access.kind === 'lima') return limaVm !== undefined && sshPath() !== undefined;
    return (access.kind === 'wsl' ? wslPath() : sshPath()) !== undefined;
  };
  // After a login with a password in a flow of the user, Devspaces offers once per host to log in with its own key
  // (~/.ssh/devspaces_ed25519) next time; every later login of Devspaces to a host with the key uses it.
  const sshKeys = new SshKeyOffer({
    home: os.homedir(),
    platform,
    computerName: os.hostname(),
    wrapperFolder: paths.sshWrapperDir,
    runner,
    sshPath,
    sshKeygenPath: () => findExecutable('ssh-keygen', env, platform),
    env,
    state: remoteState,
    dialogs: vscodeSshKeyDialogs(),
    logger,
  });
  keyOffer = sshKeys;
  void sshKeys.prepare();
  // `ssh … docker system dial-stdio` on an SSH host or in the Lima VM of Devspaces, or `wsl.exe … docker system
  // dial-stdio` in the WSL distribution, for a connection of a Docker pipe without the relay. The program is found once: a window that works without the
  // relay makes many short Docker connections.
  let dialSsh: string | undefined;
  let dialWsl: string | undefined;
  const dialStdio = (host: string): StartedByteProcess | undefined => {
    const access = hostAccessOf(host);
    if (access?.kind === 'wsl') {
      dialWsl ??= wslPath();
      if (dialWsl === undefined) return undefined;
      wslLifetime?.use(host);
      return wslProcess(runner.startBytes(dialWsl, wslCommandArgs(access.distribution, ['docker', 'system', 'dial-stdio']), { env: wslEnv(env) }));
    }
    if (access?.kind === 'lima') {
      dialSsh ??= sshPath();
      return limaProcess(dialSsh, 'docker system dial-stdio');
    }
    dialSsh ??= sshPath();
    if (dialSsh === undefined || access === undefined) return undefined;
    return runner.startBytes(dialSsh, sshCommandArgs(access.address, 'docker system dial-stdio', undefined, { identity: sshKeys.identityFor(host) }), {
      env: noPromptEnv(env),
    });
  };
  // The connections of the relay of this window, one per remote host: its worker channel, its Docker pipe and the
  // Docker pipe of the extension for the host share it. The pipe of the extension for a host listens from the first
  // connection to the host that passed its checks until the window closes.
  const relayConnections = new RelayConnections({ logger, onUse: (host) => void hostPipes?.serve(host) });
  hostPipes = new HostPipes({
    logger,
    platform,
    base: () => dockerPipeBase(env, os.tmpdir()),
    relayConnection: (host) => relayConnections.get(host),
    dialStdio,
    // Read at each request of the log of a container, so a change of the setting applies at once.
    allowContainerLogs: () => settings.allowContainerLogs === true,
  });
  // The questions of the SSH logins of the flows of the user in VS Code (a password, a host key): the helper of
  // SSH_ASKPASS and the pipe that it asks, prepared in the background. Every other login asks nothing (BatchMode).
  const askpass = new SshAskpassServer({
    folder: paths.askpassDir,
    platform,
    nodePath: process.execPath,
    base: () => dockerPipeBase(env, os.tmpdir()),
    dialogs: vscodeSshLoginDialogs(),
    logger,
  });
  context.subscriptions.push(askpass);
  void askpass.prepare();
  /**
   * A new login `ssh … sh -s` to `host` (sshHostTransport), for a shell before the relay or a connection of the relay.
   * Within a flow of the user (withSshPrompts), it may ask in VS Code until the Cancel of the flow; its questions end
   * with its process. With the key of Devspaces when the host has it; after a login that asked for the password, the key
   * offer runs on the shell (SshKeyOffer.afterLogin). For the WSL distribution of Devspaces `wsl.exe … sh -s`
   * (wslHostTransport), and for the Lima VM of Devspaces `ssh … lima-devspaces sudo -n sh -s` after its start
   * (limaHostTransport), which ask nothing. Undefined without the program of the transport and for a host that has none
   * (hostAccessOf).
   */
  const startLogin = (host: string): RemoteShellStart | undefined => {
    const access = hostAccessOf(host);
    if (access?.kind === 'lima') {
      const process = limaProcess(sshPath());
      return process === undefined ? undefined : { process };
    }
    if (access?.kind === 'wsl') {
      const wsl = wslPath();
      if (wsl === undefined) return undefined;
      wslLifetime?.use(host);
      const transport = wslHostTransport(access.distribution, wsl, env);
      return { process: wslProcess(runner.startBytes(transport.file, transport.args, { env: transport.env })) };
    }
    const ssh = sshPath();
    if (ssh === undefined) return undefined;
    const login: SshLogin | undefined = sshPromptsAllowed() ? askpass.login(host, sshPromptSignal()) : undefined;
    const transport = sshHostTransport(host, ssh, env, { prompts: login, identity: sshKeys.identityFor(host) });
    if (transport === undefined) {
      login?.dispose();
      return undefined;
    }
    const process = runner.startBytes(transport.file, transport.args, { env: transport.env });
    if (login !== undefined) void process.exited.then(() => login.dispose());
    return { process, prompts: login, afterLogin: login === undefined ? undefined : (shell) => sshKeys.afterLogin(host, login, shell) };
  };
  // Open Console of a host row of the view Docker Hosts (hostConsole.ts, R-ENG-008): a login shell on the host with a
  // terminal there, started on this computer as every transport (also in a remote window), with the same programs and
  // the same key of Devspaces. An SSH login may ask in VS Code (a password, a host key) until the terminal closes; the
  // WSL distribution and the Lima VM (which it starts, as `limactl shell` does) ask nothing. A change of the size of the
  // terminal is set on the host by a second connection that asks nothing.
  const hostConsoles = new HostConsoles({
    logger,
    allowed: () => settings.dockerHostsConsoleButton === true,
    start: (host, size, signal) => {
      const access = hostAccessOf(host);
      if (access?.kind === 'lima') {
        const ssh = sshPath();
        const vm = limaVm;
        if (ssh === undefined || vm === undefined) return undefined;
        return deferredByteProcess(async (cancel) => {
          await vm.ready(cancel);
          if (cancel.aborted) throw abortError();
          return runner.startBytes(ssh, limaConsoleArgs(vm.paths, size), { env: limaEnv(noPromptEnv(env), vm.paths) });
        });
      }
      if (access?.kind === 'wsl') {
        const wsl = wslPath();
        if (wsl === undefined) return undefined;
        wslLifetime?.use(host);
        return wslProcess(runner.startBytes(wsl, wslConsoleArgs(access.distribution, size), { env: wslEnv(env) }));
      }
      const ssh = sshPath();
      if (ssh === undefined || access === undefined) return undefined;
      const login = askpass.login(host, signal);
      const args = sshConsoleArgs(access.address, size, { prompts: login !== undefined, identity: sshKeys.identityFor(host) });
      const process = runner.startBytes(ssh, args, { env: login !== undefined ? login.env(env) : noPromptEnv(env) });
      if (login !== undefined) void process.exited.then(() => login.dispose());
      return process;
    },
    resize: (host, tty, size) => {
      const command = consoleResizeCommand(tty, size);
      if (command === undefined) return undefined;
      const access = hostAccessOf(host);
      if (access?.kind === 'lima') {
        const ssh = sshPath();
        if (ssh === undefined || limaVm === undefined) return undefined;
        const transport = limaHostTransport(limaVm.paths, ssh, env, command);
        return runner.startBytes(transport.file, transport.args, { env: transport.env });
      }
      if (access?.kind === 'wsl') {
        const wsl = wslPath();
        return wsl === undefined ? undefined : wslProcess(runner.startBytes(wsl, wslConsoleResizeArgs(access.distribution, command), { env: wslEnv(env) }));
      }
      const ssh = sshPath();
      if (ssh === undefined || access === undefined) return undefined;
      return runner.startBytes(ssh, sshCommandArgs(access.address, command, undefined, { identity: sshKeys.identityFor(host) }), { env: noPromptEnv(env) });
    },
  });
  // The shells before the relay, one per remote host: the checks before a connection of the relay run on one login,
  // which the connection then takes over (`ssh … sh -s` or `wsl.exe … sh -s`, as its transport).
  remoteShells = new RemoteShells({ logger, start: startLogin });
  const shells = remoteShells;
  // The SSH check before the Docker calls to a remote host: the login of its shell before the relay. A success counts
  // for a minute per host, and the Docker pipe of the extension for the host makes it needless while the calls go
  // through it (they start no `ssh`).
  const sshLogins = new SshLoginCache();
  const remoteDeps = (): RemoteReachabilityDeps => ({
    docker,
    runner,
    state: remoteState,
    logger,
    sshPath: sshPath(),
    env,
    sshLogins,
    viaDockerPipe: (host) => hostPipes?.dockerHost(host) !== undefined,
    shells,
    identityFor: (host) => sshKeys.identityFor(host),
    dockerCliApi,
  });
  // What the checks whether an engine answers need (dockerEngineAnswers): Docker is never started (a WSL distribution
  // only while its Monitor runs permanently or in a flow of the user, because `wsl.exe` starts it), and a remote host
  // gets the SSH check without questions first.
  const engineAnswersDeps = (): DockerEngineAnswersDeps => ({
    daemonStatus: (s, timeoutMs) => docker.daemonStatus(s, timeoutMs),
    ssh: remoteDeps(),
    leavesStopped,
    logger,
  });
  const registry = new DevspaceRegistry(paths, systemClock, { logger });
  const needsRestore = (): Promise<boolean> => registry.needsRestore();
  const sessionFiles = new SessionFiles(paths);
  const disconnectRequests = new DisconnectRequests(paths.root);
  const auth = new VsCodeGitHubAuth(logger);
  context.subscriptions.push(auth);
  const accountOffers = new AccountOffers({ auth, state: context.globalState, logger, focused: () => vscode.window.state.focused });
  // Credential helpers (docker-credential-*) are found like the Docker CLI, also with the short PATH of the extension host.
  const credentialEnv = dockerProcessEnv(env, platform, dockerPath);
  const credentials = new DockerCredentialStore(runner, {
    env: credentialEnv,
    platform,
    homeDir: os.homedir(),
    findExecutable: (name) => findExecutable(name, credentialEnv, platform),
    logger,
  });
  // Only the logins that Docker stored on this computer: the client has no operation, so it has no GitHub account whose
  // ghcr.io login it could use (the GitHub sign-in is the ghcr.io login of the operations in the worker only).
  const registryClient = new RegistryClient(nodeHttpsTransport, credentials.provider(), logger);
  const helperDockerfile = context.asAbsolutePath(path.join('resources', 'helper', 'Dockerfile'));
  // The helper image of the bootstrap, apart from the steps of the workspace helper (the worker's).
  const helper = new HelperImages({
    docker,
    logger,
    dockerfilePath: helperDockerfile,
    // The digest of the base image is read with this registry client, with its own time limit of 5 seconds: at the
    // build of a missing tag, and by the weekly check of the maintaining ensure (the preparation of the worker for an
    // operation `open`, and the background prebuild). It asks without a login first; the credentials of this computer
    // are read only when the registry refuses that request.
    statePath: paths.helperState,
    baseDigest: registryBaseDigest(registryClient),
    // The engine of the operation (its key: '' for the local Docker, else the host), without its socket, which only the
    // steps of the workspace helper read (the worker's own; the socket mount of the worker is engineSocket below).
    engine: async () => ({ key: (await targets.current()).host }),
    // On an SSH host, the rebuild that a check asked for and the cleanup change the engine only through the connection
    // of the relay of this window to the host (docs/requirements.md R-ENG-002): an open before that connection uses the
    // existing image, and the background prebuild runs them through the connection when it is open.
    mayChangeEngine: () => {
      const target = operationDockerTarget();
      return target?.kind !== 'remote' || hostAccessOf(target.host)?.kind !== 'ssh' || hostPipes?.dockerHost(target.host) !== undefined;
    },
    // A worker that could not be opened for want of the helper image is tried again at once. A build that succeeded
    // also ends the wait of the heartbeats' builds on its engine (the target of the operation that built it; every wait
    // when it is not known), in heartbeatWiring.
    onImageBuilt: (kind) => {
      helperChannels?.clearFailures();
      heartbeats.imageBuilt();
      // A build (a Start, for example) also ends the wait after a failed background build.
      missingHelperBuild?.clearFailures();
      const built = operationDockerTarget();
      // After the build of a missing tag, the next worker on the engine starts in a new container of the relay, from the
      // new image (the open connection keeps its streams); every remote engine when the engine of the build is not
      // known. A rebuild of the same tag does not end the connection for new workers: it ran through that connection,
      // which needs no new login, and its container runs the same tag (a new worker starts there only within an hour of
      // its open, RELAY_WORKER_MAX_AGE_MS).
      if (kind === 'create' && built === undefined) relayConnections.retireAll();
      else if (kind === 'create' && built?.kind === 'remote') relayConnections.retireAll(built.host);
      // A Stop or a Delete of a devspace that the user kept on an engine with the removal mark builds it there again.
      if (built !== undefined) void engineRemoved(built).then((removed) => (removed ? logger.info(removedEngineImageNote(describeDockerHost(built.host))) : undefined));
    },
  });
  // The preparation that a heartbeat starts (the helper image for the worker, and for a repair) runs with its own long
  // signal (HELPER_PREBUILD_TIMEOUT_MS, aborted when the window closes); the deadline of the heartbeat's attempt ends
  // only its wait, so the next attempt joins the build instead of starting it again. After a failed build for a
  // heartbeat, the next one on that engine waits 1, 2, then 5 minutes (REPAIR_BACKOFF_MS); a heartbeat within the wait
  // fails at once and counts towards the warning after failed heartbeats (HEARTBEAT_WARN_AFTER_FAILURES). Only a build
  // that started and failed starts the wait; within it a heartbeat goes on when the helper tag is present
  // (presentImage, never a build), and any successful preparation there ends it. The helper image of the worker and of
  // a repair of a heartbeat is built on its engine. This wiring (the preparation disposed with the window,
  // onImageBuilt, the worker's preparation and the repair through heartbeatHelperImage) is heartbeatWiring, tested in
  // core.
  const heartbeats = heartbeatWiring({
    helper,
    inTarget: runWithDockerTarget,
    onOutput: (text) => logger.output(text),
    operationTarget: operationDockerTarget,
    // A heartbeat prepares no worker on an engine with the removal mark (also while the removal runs there).
    engineRemoved,
    // The preparation is disposed only after the release of deactivate(), which may need to open the worker again.
    subscriptions: closingWork.deferredSubscriptions(context.subscriptions),
  });
  const heartbeatPreparation = heartbeats.preparation;
  // The worker per window and Docker engine (the helper channel, dist/helperChannel.js), local and remote. Every
  // operation runs in it; the extension sends no Docker call of its own through it. An operation makes it ready first
  // (the helper image, then the open), and is refused when that fails. Its socket mount is the one of the workspace
  // helper on that engine.
  const channelScriptPath = context.asAbsolutePath(path.join('dist', 'helperChannel.js'));
  // The source of the socket mount on the host of an engine, for the worker and the Monitor container: the
  // recorded socket of a rootless remote engine, else /var/run/docker.sock there; on the local Docker the socket of its
  // endpoint.
  const engineSocket = async (target: Pick<DockerTarget, 'kind' | 'host' | 'endpoint'>): Promise<string> =>
    target.kind === 'remote' ? ((await remoteState.rootlessSocket(target.host)) ?? HELPER_DOCKER_SOCKET) : helperDockerSocket(env, platform, target.endpoint);
  let channelScript: Promise<string> | undefined;
  const workerScript = (): Promise<string> => {
    channelScript ??= fs.promises.readFile(channelScriptPath, 'utf8');
    // A failed read is tried again at the next open.
    channelScript.catch(() => (channelScript = undefined));
    return channelScript;
  };
  // The remembered check results of the configurations, each stamped with the hash of the worker's code (the script
  // that this extension pipes into its workers), so an update forgets them.
  let workerCode: Promise<string> | undefined;
  const configChecks = new ConfigCheckStore(paths.configChecksDir, () => {
    workerCode ??= workerScript().then(bundleHash);
    workerCode.catch(() => (workerCode = undefined));
    return workerCode;
  });
  // When the refresh of the sidebar finds the helper image of an engine missing (for example after a purge of its
  // images), this window builds it in the background, once at a time per engine, and after a failure not again there
  // within 10 minutes (a Start, Stop or Delete builds it at once, as before). The build is the one of Start, Stop and
  // Delete (the preparation of their worker, `prepare` below, without the maintenance of an open: the same Dockerfile,
  // tag and privileges, and the window's shared build, which a Start at the same time joins); only when the engine
  // answers (as the background prebuild: Docker is never started). On an SSH host, only while the connection of the
  // relay of this window to the host is open, and only through it, without a login of its own (docs/requirements.md
  // R-ENG-002): otherwise the next Start, Stop or Delete there builds it. Shown in the status bar; then the sidebar
  // refreshes.
  const isSshHost = (target: DockerTarget): boolean => target.kind === 'remote' && hostAccessOf(target.host)?.kind === 'ssh';
  const helperBuilds = new MissingHelperBuild({
    engineAnswers: (target, signal) =>
      runWithDockerTarget(target, () =>
        dockerEngineAnswers(target, { ...engineAnswersDeps(), connected: (host) => hostPipes?.dockerHost(host) !== undefined }, signal),
      ),
    build: (target, signal) => {
      if (!isSshHost(target)) return heartbeats.prepareWorker(target, signal);
      // A call that would log in stops the build (as a cancel, so a Start that joined it builds for itself).
      const withoutLogin = new AbortController();
      return runWithDockerTarget(target, () => heartbeats.prepareWorker(target, AbortSignal.any([signal, withoutLogin.signal])), { withoutLogin });
    },
    progress: (target, work) =>
      Promise.resolve(
        vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: `Devspaces: preparing ${describeDockerHost(target.host)}…` }, work),
      ),
    onBuilt: () => {
      sidebarOfBuild?.refreshStates().catch((error: unknown) => logger.error('Could not update the sidebar.', error));
    },
    onChange: () => {
      sidebarOfBuild?.render().catch((error: unknown) => logger.error('Could not update the sidebar.', error));
    },
    logger,
  });
  missingHelperBuild = helperBuilds;
  // Cancelled when the window closes, after the release of deactivate() (which may join its build), as the preparations
  // of the heartbeats.
  context.subscriptions.push(closingWork.deferred({ dispose: () => helperBuilds.dispose() }));
  const channels = new HelperChannels({
    logger,
    dockerCliApi,
    // The refresh found no helper image (see helperBuilds above); never on an engine that Devspaces was removed from.
    onRefreshWithoutHelper: (target) => {
      void engineRemoved(target).then((removed) => (removed ? undefined : helperBuilds.request(target)));
    },
    // The helper image on the engine of the operation, as withDevspaceLock ensures it before the lock (only a
    // missing tag is built). For a heartbeat, with the long signal. For an operation `open`, the maintaining ensure
    // with its `maintenance` (heartbeatWiring).
    prepare: async (target, signal, maintenance) => {
      // For a heartbeat, no new build on this engine within the wait after a failed one; within it, the heartbeat goes
      // on when the tag is present (heartbeatWiring).
      await heartbeats.prepareWorker(target, signal, maintenance);
    },
    // The refresh of the sidebar only checks that the helper image is present. On an engine that Devspaces was removed
    // from, no worker starts for a passive read: its mounts would create the shared volumes again.
    checkPresent: async (target, signal) => {
      if (await engineRemoved(target)) throw new Error(removedEngineNote(describeDockerHost(target.host)));
      await runWithDockerTarget(target, () => helper.checkImagePresent({ signal }));
    },
    // With ChannelOpenOptions: a worker from the current build in the place of one from an earlier build (renew) never
    // starts on the open connection of the relay.
    open: (target, options) =>
      openHelperChannel(
        {
          start: (args) => docker.start(args),
          // A remote engine: the worker behind the relay, on the open connection of the host, or with one login
          // (`ssh … sh -s`, or `wsl.exe … sh -s` for the WSL distribution).
          relay: (target) => {
            if (target.kind !== 'remote') return undefined;
            // An SSH host without `ssh` starts its worker with the Docker CLI (`ssh://`); the WSL distribution only
            // behind the relay, whose open then says that wsl.exe is missing.
            const access = hostAccessOf(target.host);
            if (access === undefined || (access.kind === 'ssh' && sshPath() === undefined)) return undefined;
            // The login of the shell before the relay, when its checks left one open; else a new one, which may ask
            // within a flow of the user.
            const start = () => {
              const started = startLogin(target.host);
              if (started === undefined) {
                throw new RelayConnectionError(`The connection to ${target.host} could not be opened: ${transportProgramOf(target.host)} was not found.`);
              }
              return started;
            };
            return relayAccess(relayConnections, target.host, (command, bundle) =>
              openRelayConnection(start, command, bundle, { logger, name: target.host, takeOver: () => shells.takeOver(target.host) }),
            );
          },
          runDirect: (args, options, withoutPipe) => (withoutPipe === true ? docker.runWithoutPipe(args, options) : docker.run(args, options)),
          dockerCliApi,
          logger,
          script: workerScript,
          helperTag: async () => helperImageTag(await fs.promises.readFile(helperDockerfile, 'utf8')),
          socketPath: engineSocket,
          // The lock files of the devspaces, in the volume of the Monitor of the engine.
          stateVolume: REMOTE_MONITOR_VOLUME,
          // The shared VS Code server store of the engine, which the worker mounts read-write.
          vscodeVolume: VSCODE_STORE_VOLUME,
          // The name of this window, or of its devspace, in the name of the worker's container.
          windowName: () => connection.windowName(),
          devspaceName: () => windowDevspaceName(connection.currentContainerName(), target.host, registry),
        },
        target,
        options,
      ),
  });
  helperChannels = channels;
  // The extension relays no Docker call through the worker (its pipeline runs there). Disposed after the release of
  // deactivate() (bounded; it never rejects), which needs the worker.
  context.subscriptions.push(
    closingWork.deferred({
      dispose: () => {
        channels.dispose();
        relayConnections.dispose();
        shells.dispose();
        hostPipes?.dispose();
      },
    }),
  );
  // The heartbeats, the check of a container and the Git state of a release, as operations of the worker of the engine
  // (workerFlow is set below, before the first call). Also the ensure of the Monitor container (on every
  // engine), with the settings of this computer for its background run (cacheUpdateSchedule, in its time zone); the
  // worker holds the script of the monitor and runs from the helper image.
  const monitorCalls = workerMonitor({
    flow: (op, params, options) => workerFlow(op, params, options),
    owner: () => ({ windowId: windowCoordinator?.windowId ?? '', pid: process.pid }),
    logger,
    // The last check of the helper image by the Monitor of the engine of a heartbeat goes into the state of the helper
    // image of that engine (its key: '' for the local Docker, else the host), so that this window does not check it
    // while the Monitor did (docs/requirements.md R-DS-003).
    onHelperCheck: (target, check) => void helper.recordEngineCheck(target.host, check),
    // The processes that the kernel of the engine ended because the memory ran out: in the log on every engine, and on
    // the Lima VM a warning at the first one of each start of the VM, with the setting of its memory (R-VM-006).
    onOomKills: (target, kills) => oomWatch.seen(target.host, kills),
    // The worker of the engine runs from an earlier build of the helper image (a rebuild by the Monitor or a window): a
    // worker from the current build takes its place in the background, and the earlier one is closed once no operation
    // runs on it (docs/requirements.md R-DS-008).
    onEarlierBuild: (target) => void channels.renew(target),
  });
  // The source of the heartbeats and the owner of a permanent Monitor (computer.id); created by the first reader, and
  // read once (each open and each repair of the heartbeats asks for it; a failed read is tried again at the next call).
  let knownComputerId: string | undefined;
  const computerId = (): string => (knownComputerId ??= readOrCreateComputerId(paths.computerId));
  // The open carries the settings of this computer for the Monitor of its engine (no image prefixes and no image list):
  // the schedule of the monitor's whole background run (cacheUpdateSchedule), and its mode (monitorRunsPermanently,
  // R-DS-003: permanent on a remote host unless stopMonitorWhenIdle is on; on the WSL distribution or VM of Devspaces
  // and on the Docker of the computer it always ends when idle). In monitorSettings.ts, tested by its behaviour.
  const monitorSettings = monitorSettingsOf({
    settings: getSettings,
    // An unknown zone of Node.js (`Etc/Unknown`) is UTC.
    timeZone: () => usableTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone),
    computerId,
  });
  // The WSL distribution of Devspaces runs while its keeper runs: each `wsl.exe` of this window there starts it, and the
  // idle script of the VM in it holds the distribution while something runs there, also after VS Code closed
  // (R-VM-004). A Docker call in the background does not start a distribution that does not run, or one that stops now
  // (docs/architecture.md "The WSL distribution of Devspaces"). No keeper starts after the release of deactivate().
  const keeper = new WslKeeper({
    wslPath,
    env,
    launch: (file, args, onExit) => launchDetachedProcess(file, args, onExit, { windowsHide: true }),
    logger,
    // Nothing runs in the distribution anymore: the shell of this window there (the shared shell of the view Docker
    // Hosts) ends, so that it does not hold the distribution for up to 2 more minutes (R-VM-004).
    onIdleEnded: () => shells.close(WSL_HOST),
  });
  context.subscriptions.push({ dispose: () => keeper.dispose() });
  // The setup of the WSL distribution of Devspaces (Windows): the `.wsl` file of the image of the VM of Devspaces, with
  // its virtual disk in a folder of LOCALAPPDATA. The VM upgrades its packages itself (R-VM-007).
  const wslFolder = platform === 'win32' ? wslSetupFolder(env) : undefined;
  const wslSetupCore =
    wslFolder === undefined
      ? undefined
      : new WslSetup({ runner, wslPath, env, arch: () => readWindowsArch(runner, env, process.arch, logger), folder: wslFolder, logger });
  // Whether the own VM of Devspaces exists, for the Docker host of Devspaces (withoutMissingVm): the Lima VM from the file
  // of its instance at each read (no process). The registration of the WSL distribution needs wsl.exe and the registry,
  // so its answer comes from the reads that run anyway (the scheduled task at the start of the window, after the setup or
  // the removal and after a change of the schedule; the Docker context of the setting createDockerContext), and a read
  // in between takes the last answer (before the first one: it exists). A changed answer reads the Docker host again.
  let wslDistributionExists: boolean | undefined;
  const wslDistributionKnown = (exists: boolean): void => {
    const before = wslDistributionExists !== false;
    wslDistributionExists = exists;
    // DockerTargets.resolve never throws.
    if (before !== exists) void targets.resolve();
  };
  ownVmExists = async (host) => {
    if (host === LIMA_HOST) return limaVm === undefined || (await limaVm.exists());
    if (host === WSL_HOST) return wslDistributionExists !== false;
    return true;
  };
  // The record of the installation of WSL (Windows): after the restart of Windows, the first window goes on with the setup
  // of Docker for Devspaces, and with the link that needed it (Controller.goOnAfterWslInstall).
  const wslAfterInstall = platform === 'win32' ? new WslAfterInstall({ files: sessionFiles, logger }) : undefined;
  const lifetime = new WslLifetime({
    runner,
    wslPath,
    env,
    keeper,
    logger,
  });
  wslLifetime = lifetime;
  context.subscriptions.push(closingWork.deferred({ dispose: () => lifetime.dispose() }));
  // The heartbeats of this window to the Monitor container of the engine of each devspace it uses, through
  // this window's worker of that engine (its operation `heartbeat`; the worker is made ready first); a missing monitor
  // is started again as the open starts it. `signal` aborts at the deadline of the heartbeat's attempt; it ends only
  // the wait for the helper image, whose build runs with the long signal of the preparation. The same wait after a
  // failed build on this engine as for the worker of a heartbeat; within it, the repair goes on with the tag when it is
  // present (heartbeatWiring.repair). The repair is the operation `monitorEnsure` of the worker of that engine.
  const repairSessionMonitor = heartbeats.repair(async (target, signal) => monitorCalls.monitorEnsure(target, await monitorSettings.forTarget(target), signal));
  // Set below (the coordinator makes the ID of this window).
  let windowCoordinator: SessionCoordinator | undefined;
  // The engine of a devspace for its heartbeats and for the Docker pipe of its window (resolveHeartbeatEngine, hostEngine).
  const engineSources = {
    ofHost: (host: string) => targets.ofHost(host),
    ofContext: (name: string) => outsideOperation(() => targets.ofContext(name)),
  };
  const windowHeartbeats = new WindowHeartbeats({
    owner: () => ({ windowId: windowCoordinator?.windowId ?? '', pid: process.pid }),
    connected: () => windowCoordinator?.devspaceId ?? null,
    registry,
    settings: getSettings,
    sourceId: computerId,
    // The engine of the Docker host of the devspace, whatever host Devspaces uses now (resolveHeartbeatEngine).
    engineFor: (devspace, use) => resolveHeartbeatEngine(devspace, use, engineSources),
    // In the scope of a heartbeat, the worker's preparation runs with the long signal (heartbeatPreparation). The
    // operation `heartbeat` of the worker of that engine.
    send: (target, input, signal) => heartbeatPreparation.scope(() => monitorCalls.heartbeat(target, input, signal)),
    repair: repairSessionMonitor,
    // A Stop or a Delete of a devspace that the user kept on an engine with the removal mark sends its heartbeat there;
    // the Monitor is not started again.
    engineRemoved,
    // The container of the devspace (its name in the registry) on that engine; any failure counts as not there. The
    // operation `windowState` of the worker of that engine.
    containerExists: (target, devspace, signal) => heartbeatPreparation.scope(() => monitorCalls.containerExists(target, devspace, signal)),
    warn: (message) => {
      void showWarningMessage(message).then(undefined, (error: unknown) => logger.error('Could not show the message.', error));
    },
    logger,
  });
  context.subscriptions.push({ dispose: () => windowHeartbeats.dispose() });
  // One stored list per GitHub account.
  const discovery = new DiscoveryService(
    new GitHubApi(nodeHttpsTransport, logger, {
      onUnauthorized: (token) => auth.reportRejectedToken(token),
      onAuthorized: (token) => auth.reportAcceptedToken(token),
    }),
    (accountId) => paths.repositoriesFile(accountId),
    logger,
    systemClock,
    // The setting `owners` is the scan scope; GitHub is asked only about these owners.
    { scope: () => getSettings().owners },
  );
  const ui = new VsCodePipelineUi(auth, logger, () => logger.show(), systemClock, () => getSettings().updateContainer ?? 'notify');
  const sessionCoordinator: SessionCoordinator = new SessionCoordinator({
    paths,
    sessionFiles,
    logger,
    settings: getSettings,
    windowDockerContext: () => connection.currentDockerContext(),
    windowDockerHost: () => connection.currentDockerHost(),
    windowHeartbeats,
    // The release of a devspace this window leaves.
    release: (devspaceId, bounds) =>
      releaseDevspace(
        {
          registry,
          settings: getSettings,
          // Status files, pending connection files, and busy marks of other windows.
          otherWindowUses: (devspace) => sessionCoordinator.otherWindowUses(devspace),
          // The Git state, read in the running dev container as its user, on the engine this window uses it on, through
          // its worker.
          recordGitState: async (devspace, signal) => {
            const target = await windowHeartbeats.connectedEngine(devspace);
            if (target === undefined) return;
            // The operation `recordGitState` of the worker of that engine.
            await heartbeatPreparation.scope(() => monitorCalls.recordGitState(target, devspace, signal));
          },
          send: (id, limitSeconds, signal) => windowHeartbeats.release(id, limitSeconds, signal),
          // A Stop that this window handed off (its pending operation `stop`) goes to the Monitor instead of
          // the release.
          stop: {
            handedOff: async (devspace) => isHandedOffStop(await sessionFiles.readOperation(devspace.id), sessionCoordinator.windowId),
            send: (id, signal) => windowHeartbeats.sendStop(id, signal),
          },
          // The last use, for Delete's note, at the start of every release.
          markSeenInUse: (devspace, at) => registry.markSeenInUse(devspace.id, at),
          logger,
        },
        devspaceId,
        bounds,
      ),
    // A window that starts connected (a reload) was seen using its devspace.
    markSeenInUse: (devspaceId, at) => registry.markSeenInUse(devspaceId, at),
  });
  windowCoordinator = sessionCoordinator;
  coordinator = sessionCoordinator;
  context.subscriptions.push(sessionCoordinator);
  // The flows that run in the worker of the current engine (the worker is the deputy of this computer), with the
  // HostSide of this computer answering their requests; one for the service (also the token removal of the controller)
  // and the calls to the Monitor. The containers that this window remembers, for its pipeline and its worker.
  const lifecycleMemory = windowLifecycleMemory();
  const hostSideDeps: HostSideDeps = {
    registry,
    sessionFiles,
    ui,
    auth,
    credentials,
    windowId: sessionCoordinator.windowId,
    // The busy marks that a flow sets for this window, as its own pipeline sets them.
    pid: process.pid,
    clock: systemClock,
    isProcessAlive: (pid: number) => isProcessAlive(pid),
    // The profile of the account and the window's memory, for the open in the worker.
    viewer: (token, signal) => discovery.viewer(token, signal),
    lifecycleMemory,
    // The remembered check results of the configurations (this extension's storage).
    configChecks,
    logger,
  };
  // The HostSide of the account of each operation: the extension chooses that account, never the worker.
  const workerFlow = extensionFlow(channels, () => targets.current(), (account) => extensionHostSide(hostSideDeps, account), logger);
  // The step "Docker start" of an operation (and of "Update All Images Now"): the Docker host of Devspaces (its own VM,
  // or a remote host) is only checked; Devspaces never starts a Docker of this computer (R-ENG-001).
  const startDocker: DockerStarter = async ({ signal }) =>
    startDockerFor(
      await targets.current(),
      () => ensureDockerRunning(docker, logger, { signal }),
      remoteDeps(),
      signal,
    );
  // The operations of this window, each a flow in the worker of the Docker target; the pipeline runs there
  // (DevspaceService), never here.
  const service = new DevspaceOperations({
    flow: workerFlow,
    registry,
    sessionFiles,
    auth,
    lifecycleMemory,
    // The refresh of the sidebar in one operation of the worker of the Docker target of the operation (outside of an
    // operation, of the current one; never read directly). Within an operation, the worker is made ready first; when it
    // cannot be, the refresh fails (never read directly).
    workerRefresh: async (devspaces) => {
      // Always through the worker, of the target of the operation or else the current one; never on an engine that
      // Devspaces was removed from (the states stay unknown there).
      const target = operationDockerTarget() ?? (await targets.current());
      if (await engineRemoved(target)) throw new RemovedEngineError(target.host);
      try {
        return await channels.refresh(target, devspaces);
      } catch (error) {
        if (!(error instanceof HelperChannelError) || error.code !== 'unavailable') throw error;
        throw new UserFacingError('helperFailed', Messages.workerUnavailable(error.message), error.message);
      }
    },
    // Whether the Docker engine of the current target answers (Stop and the refresh do nothing without it).
    // As an operation on the current target: on an SSH host, the call goes through the connection of the relay when
    // one is open (BootstrapDocker), not with an SSH login of its own.
    dockerRunning: () => targets.withOperation(() => docker.isRunning()),
    // The refresh of the states asks nothing on an engine with the removal mark, also no `docker info`.
    engineRemoved: (host) => engineRemoved({ host }),
    // Nor on a WSL distribution that does not run, unless its Monitor runs permanently or a flow of the user asks.
    leavesStopped,
    ui,
    logger,
    clock: systemClock,
    owner: { windowId: sessionCoordinator.windowId, pid: process.pid },
    // The id of this computer in the Monitor, for the `forget` of Delete in the worker.
    monitorSource: computerId,
    settings: getSettings,
    windowStatuses: () => sessionFiles.readWindowStatuses(),
    // New devspaces record the Docker host; only its devspaces are used. An endpoint that is neither local nor
    // SSH is refused by every operation and never read.
    dockerTarget: () => targets.current(),
    // The settings that an open carries for the Monitor of its engine (the worker makes sure that the monitor
    // runs, and sends its first heartbeat). The Docker host of the open is empty for the local Docker and names the SSH
    // host otherwise. The image references in use come with it from the registry
    // (DevspaceOperations.referencesInUse); there is no image list.
    openMonitor: async (dockerHost) => ({ images: await monitorSettings.forOpen(dockerHost) }),
    // The commit and quality of this VS Code (product.json under vscode.env.appRoot, read once), which an open sends
    // when the build qualifies.
    vscodeServerOfWindow: windowVscodeServer(vscode.env.appRoot, (file) => fs.promises.readFile(file, 'utf8'), (message) => logger.info(message)),
    // The user's default extensions of the Dev Containers extension (the user settings only), which an open with a VS
    // Code server carries for the shared extension cache (read at each open).
    defaultExtensionsOfWindow: () => defaultExtensionEntries(devContainersDefaultExtensionsValue(), (message) => logger.info(message)),
    startDocker,
  });

  const tree = new RepositoriesTreeProvider(logger);
  const view = vscode.window.createTreeView<TreeNode>(REPOSITORIES_VIEW_ID, {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  const statusBar = new DevspaceStatusBar();
  // The colors of the names of the rows of the views Devspaces and Docker Hosts (gray, violet; rowColors.ts).
  context.subscriptions.push(tree, view, statusBar, vscode.window.registerFileDecorationProvider(new RowColorDecorations()));
  // The view's title and its first row name the Docker host (also the local Docker).
  const dockerHostIndicator = new DockerHostIndicator(view, logger, (host) => tree.setDockerHost(host));
  // A remote host needs a Docker CLI for remote engines (the one of Devspaces or of this computer), the local Docker the
  // Docker CLI of this computer.
  context.subscriptions.push({
    dispose: targets.onDidResolve((target) => dockerHostIndicator.update(target, docker.canRunOn(target))),
  });
  // While no Docker CLI is found, the sidebar shows the Docker setup (welcome view) instead of the repositories: when
  // no remote Docker host is configured and the local Docker is not available, the repositories are not shown.
  const setup = new DockerSetup({
    docker,
    runner,
    logger,
    platform,
    env,
    // The CLI was found or lost: the sidebar renders again and shows the repositories or the setup.
    onDidChangeInstalled: () => {
      sidebar.render().catch((error: unknown) => logger.error('Could not update the sidebar.', error));
    },
    // Devspaces uses a host of its list (as last read; onDockerHostChanged below). Without a Docker CLI for remote
    // engines, the read gives the local Docker, so the setup shows.
    remoteDockerHostConfigured: () => targets.last?.kind === 'remote',
    // Windows: `wsl --status` only while the view shows the setup (also onViewShown below).
    viewVisible: () => view.visible,
    wslAfterInstall,
  });
  dockerSetup = setup;
  context.subscriptions.push(setup);
  // A change of the Docker host of Devspaces, also by another window, shows or hides the Docker setup.
  context.subscriptions.push({ dispose: targets.onDidResolve(() => setup.onDockerHostChanged()) });
  // The worker thread of the repository groups (the regular expressions of the setting run there, with a time limit).
  const groupsWorkerScript = context.asAbsolutePath(path.join('dist', 'groupsPreviewWorker.js'));
  const groupMatcher = new GroupMatchWorkerRunner(groupsWorkerScript);
  context.subscriptions.push({ dispose: () => groupMatcher.dispose() });
  const sidebar = new Sidebar({
    logger,
    registry,
    sessionFiles,
    coordinator: sessionCoordinator,
    service,
    docker,
    discovery,
    auth,
    tree,
    settings: getSettings,
    groupMatcher,
    dockerSetupRequired: () => setup.setupRequired,
    dockerHost: () => targets.host(),
    dockerTargets: targets,
    view,
    // The reason of a state that could not be read (the background build of the helper image).
    helperBuilds,
  });
  sidebarOfBuild = sidebar;
  setup.initialize();
  const repositoryGroupsEditor = new RepositoryGroupsEditor({
    extensionUri: context.extensionUri,
    logger,
    groupingInput: () => sidebar.groupingInput(),
    onDidRender: sidebar.onDidRender,
    previewRunner: new PreviewWorkerRunner(groupsWorkerScript),
  });
  context.subscriptions.push(repositoryGroupsEditor);
  // After the choice of another Docker host: the background prebuild of the helper image there, as at the start of a
  // window, but also before the first use of Devspaces (the choice is a use), and never on an engine with the removal
  // mark. Nothing without a Docker host (after the removal of the host that Devspaces used), and nothing before the
  // activation created the prebuild: its start reads the current host.
  const prebuildAfterSwitch = async (): Promise<void> => {
    const prebuild = backgroundPrebuild;
    if (prebuild === undefined) return;
    const target = await targets.current();
    if (target.kind !== 'remote' || (await engineRemoved(target))) return;
    await prebuild.start(target);
  };
  // The view "Docker Hosts" (R-ENG-008), made below: the changes of the list of Devspaces show there.
  let hostsView: DockerHostsView | undefined;
  // "Use a Remote Docker Host…" and the choice of the first row of the view.
  const remoteDocker = new RemoteDockerCommands({
    docker,
    runner,
    targets,
    state: remoteState,
    logger,
    showLog: () => logger.show(),
    sshHosts: () => parseSshConfig(nodeSshConfigFiles, { home: os.homedir() }),
    sshPath,
    env,
    sshLogins,
    shells,
    identityFor: (host) => sshKeys.identityFor(host),
    sshEnv: (host, callEnv) => sshKeys.dockerSshEnv(host, callEnv),
    // The WSL distributions of this Windows user, for the WSL distribution of Devspaces (or its setup) in the choice of the
    // host; only on Windows. Without WSL, or without a distribution, `wsl.exe` says so with an exit code that is not 0:
    // then there is none.
    wslDistributions:
      platform !== 'win32'
        ? undefined
        : async () => {
            const result = await runWslList();
            if (result === undefined) return [];
            if (result.timedOut) throw new Error(`wsl.exe ${WSL_LIST_ARGS.join(' ')} did not answer within ${WSL_LIST_TIMEOUT_MS / 1000} seconds`);
            if (result.exitCode !== 0) {
              logger.info(`wsl.exe ${WSL_LIST_ARGS.join(' ')} lists no distribution (exit code ${result.exitCode}): ${parseWslList(result.stderr || result.stdout).join(' ')}`);
              return [];
            }
            return parseWslList(result.stdout);
          },
    // The Lima VM of Devspaces (or its setup) in the choice of the host; only on macOS and Linux.
    limaVmExists: limaVm === undefined ? undefined : () => limaVm.exists(),
    devspaceCount: async (host) => devspacesOfHost(await registry.list(), host).length,
    onDidSwitch: async () => {
      // The helper image on the new host in the background (HelperPrebuild, once per host in this window, and again where
      // the first try found Docker not running), also after the setup of the VM of Devspaces, so that the first Start
      // there does not wait for its build.
      background(prebuildAfterSwitch(), 'prepare the workspace helper image in the background');
      await sidebar.render();
      if (view.visible) await sidebar.refreshStates();
      hostsView?.changed();
    },
    // The list of Devspaces changed: the view "Docker Hosts" shows its hosts again.
    onDidChangeList: () => hostsView?.changed(),
    // A computer without a Docker CLI: the Docker CLI of Devspaces for the remote host.
    installOwnCli: ownCliBuild
      ? () => installOwnDockerCliWithProgress({ folder: paths.dockerCliDir, platform, arch: process.arch, logger, fallback: undefined, failed: OwnDockerCliTexts.failedForRemoteHost })
      : undefined,
  });
  // "Set Up Docker for Devspaces in WSL…" and "Remove the WSL Distribution of Devspaces…" (Windows): after its setup,
  // the distribution is the Docker host of Devspaces.
  const wslSetup = new WslSetupCommands({
    setup: wslSetupCore,
    folder: wslFolder,
    dockerDesktopIntegrates: (isDefault) => dockerDesktopIntegrates(env, WSL_DISTRIBUTION, isDefault),
    isWindows: platform === 'win32',
    logger,
    showLog: () => logger.show(),
    installWsl: (link) => setup.installWsl(link),
    restartPending: async () => (await wslAfterInstall?.restartPending()) === true,
    wslInstallDone: async () => wslAfterInstall?.forget(),
    // After the setup, the Docker context of the setting createDockerContext, which waited for the distribution, and the
    // scheduled task of the distribution. The setup registered the distribution, so the Docker host is the distribution
    // again (ownVmExists).
    useHost: async (host) => {
      wslDistributionExists = true;
      const used = await remoteDocker.useHost(host);
      background(syncVmDockerContext(false), 'update the Docker context of the VM of Devspaces');
      background(updateVmTask(), 'update the scheduled task of the VM of Devspaces');
      return used;
    },
    forgetHost: (host) => remoteDocker.forgetHost(host),
    beforeRemove: () => closeVmConnections(),
    // Without the distribution, the Docker context of the setting createDockerContext and the scheduled task go too.
    forgetDistribution: async () => {
      background(syncVmDockerContext(false), 'update the Docker context of the VM of Devspaces');
      background(updateVmTask(), 'update the scheduled task of the VM of Devspaces');
    },
    distributionGone: () => {
      wslDistributionKnown(false);
      contextPipe?.stop();
    },
  });
  // "Set Up Docker for Devspaces in Its VM…" (macOS and Linux): after its setup, the Lima VM is the Docker host of
  // Devspaces.
  const limaSetupCore = limaVm === undefined ? undefined : new LimaSetup({ vm: limaVm, runner, logger, platform, arch: vmArch, env, resources: vmWish, machine });
  const limaSetup = new LimaSetupCommands({
    setup: limaSetupCore,
    folder: limaVm?.paths.root,
    logger,
    showLog: () => logger.show(),
    useRemoteHost: () => remoteDocker.useRemoteHost(),
    // After the setup, the Docker context of the setting createDockerContext, which may have waited for a Docker CLI,
    // and the scheduled task of the VM.
    useHost: async (host) => {
      const used = await remoteDocker.useHost(host);
      background(syncVmDockerContext(false), 'update the Docker context of the VM of Devspaces');
      background(updateVmTask(), 'update the scheduled task of the VM of Devspaces');
      return used;
    },
    // "Remove the VM…" (R-VM-010): the connections of this window to the VM end first; the host leaves the list of
    // Devspaces; without the VM, the Docker context of the setting createDockerContext and the scheduled task go too.
    beforeRemove: () => closeVmConnections(),
    forgetHost: (host) => remoteDocker.forgetHost(host),
    afterRemove: async () => {
      background(syncVmDockerContext(false), 'update the Docker context of the VM of Devspaces');
      background(updateVmTask(), 'update the scheduled task of the VM of Devspaces');
    },
    // Linux: QEMU and the group kvm with one administrator prompt (sudo) in a visible terminal of this computer, with a
    // fixed shell, folder and environment, as the installation of Docker had.
    installQemu:
      platform === 'linux'
        ? {
            input: async () => ({ arch: process.arch, osRelease: (await readOsRelease()) ?? {}, userName: currentUserName() }),
            localWindow: () => vscode.env.remoteName === undefined,
            runInTerminal: (commands) => {
              const terminal = vscode.window.createTerminal({ name: LimaSetupTexts.qemuTerminal, ...installTerminalOptions(platform, env, os.homedir(), currentUserName()) });
              terminal.show();
              for (const line of terminalLines(commands, platform)) terminal.sendText(line);
            },
          }
        : undefined,
  });
  context.subscriptions.push(limaSetup);
  // The scheduled task of the user (R-VM-005): on macOS and Linux (src/core/vm/vmTask.ts) it starts the Lima VM and its
  // Monitor at the times of devspaces.cacheUpdateSchedule, in the time zone of this computer; on Windows
  // (src/core/docker/wslTask.ts) a task of Task Scheduler starts the WSL distribution of Devspaces and its Monitor at
  // those times. Each window brings it to the current settings at its start, after the setup or the removal of the VM
  // and after a change of the schedule; it writes only what changed. Without the VM (on Windows: without the
  // distribution that Devspaces set up), the task goes; before the pinned Lima is installed, nothing changes.
  const vmTask =
    limaVm === undefined
      ? undefined
      : new VmTask({
          runner,
          logger,
          platform,
          homeDir: os.homedir(),
          paths: vmTaskPaths(limaVm.paths.root),
          bundledProgram: context.asAbsolutePath(path.join('dist', 'vmTask.js')),
          uid: () => os.userInfo().uid,
        });
  const wslTask =
    wslFolder === undefined
      ? undefined
      : new WslTask({
          runner,
          logger,
          env,
          // Next to the folder of the distribution: %LOCALAPPDATA%\nimblescape\devspaces\task.
          folder: path.win32.join(path.win32.dirname(wslFolder), WSL_TASK_FOLDER),
          // wslg.exe has no console window; the task falls back to wsl.exe as the keeper does.
          program: () => {
            const wslg = wslgPathOf(env);
            return fs.existsSync(wslg) ? wslg : wslPath();
          },
        });
  const updateWslTask = async (): Promise<void> => {
    if (wslTask === undefined || wslSetupCore === undefined) return;
    // Without WSL, no call of wsl.exe: only a task that this computer registered goes (WslTask.remove).
    if (wslPath() === undefined) {
      wslDistributionKnown(false);
      return wslTask.remove();
    }
    // When the registry cannot be read, the task stays as it is until a later window can tell.
    const registration = await wslSetupCore.registration().catch((error: unknown) => {
      logger.info(`Whether the WSL distribution of Devspaces exists could not be read, so its scheduled task stays as it is: ${errorMessage(error)}`);
      return undefined;
    });
    if (registration === undefined) return;
    wslDistributionKnown(registration !== 'none');
    if (registration !== 'own') return wslTask.remove();
    const { schedule, timeZone } = await monitorSettings.forOpen(WSL_HOST);
    await wslTask.update({ schedule, timeZone });
  };
  const updateVmTask = async (): Promise<void> => {
    if (wslTask !== undefined) return updateWslTask();
    if (limaVm === undefined || vmTask === undefined) return;
    if (!(await limaVm.exists())) return vmTask.remove();
    const limactl = presentLima(limaVm.paths.lima, platform, vmArch);
    if (limactl === undefined) return;
    const { schedule, timeZone } = await monitorSettings.forOpen(LIMA_HOST);
    await vmTask.update({ config: { schedule, timeZone, limactl, limaHome: limaVm.paths.home }, electron: vscodeElectron(platform, vscode.env.appRoot, process.execPath) });
  };
  // The VM of Devspaces on this platform (R-VM-010): the Lima VM on macOS and Linux, the WSL distribution on Windows.
  const vmHost = limaVm !== undefined ? LIMA_HOST : wslSetupCore !== undefined ? WSL_HOST : undefined;
  // Its state without a start: no download, no `limactl start`, no `wsl.exe` in the distribution.
  const readVmState = async (): Promise<VmState> => {
    if (limaVm !== undefined) {
      return limaVmState({ exists: () => limaVm.exists(), limactl: () => presentLima(limaVm.paths.lima, platform, vmArch), paths: limaVm.paths, runner, logger, env });
    }
    if (wslSetupCore !== undefined && wslFolder !== undefined) {
      // The answer of the registry is also the answer whether the distribution exists, for the Docker host (ownVmExists).
      const registration = async (): Promise<'own' | 'foreign' | 'none'> => {
        const answer = await wslSetupCore.registration();
        wslDistributionKnown(answer !== 'none');
        return answer;
      };
      return wslVmState({ registration, running: () => lifetime.running(WSL_DISTRIBUTION), folder: wslFolder });
    }
    return { kind: 'notSetUp' };
  };
  // All Docker calls of the view Docker Hosts and of Read Sizes of the utilization page run on the one shared shell of
  // the host (`onShell`), also the actions of the view and also on the VM, so they share one login of the host instead
  // of one connection each; on an SSH host with an open connection of the relay, they go through its pipe, which shares
  // the login of the relay.
  const onHostShell = <T>(host: string, fn: () => Promise<T>, openLoginOnly?: AbortController): Promise<T> =>
    runWithDockerTarget(remoteDockerTarget(host), fn, { onShell: true, ...(openLoginOnly !== undefined ? { openLoginOnly } : {}) });
  // The base image of the helper image, from its Dockerfile in this extension: read once, and again at the next read of
  // a host after a failed read (then none; the first failure is logged).
  let helperBaseImages: Promise<Set<string>> | undefined;
  let helperBaseImagesWarned = false;
  const readHelperBaseImages = (): Promise<Set<string>> =>
    (helperBaseImages ??= fs.promises.readFile(helperDockerfile, 'utf8').then(helperBaseImageReferences, (error: unknown) => {
      helperBaseImages = undefined;
      if (!helperBaseImagesWarned) logger.warn(`The Dockerfile of the helper image could not be read for the view Docker Hosts: ${errorMessage(error)}`);
      helperBaseImagesWarned = true;
      return new Set<string>();
    }));
  // The objects of a host with their sizes: for the view Docker Hosts and for the sizes of the utilization page.
  // `openLoginOnly`: the read of the page in the background, only on a login that is open (an AbortError without one).
  const readInventory = async (host: string, signal: AbortSignal, options: { openLoginOnly?: boolean } = {}) => {
    const here = devspacesOfHost(await registry.list(), host);
    const helperBases = await readHelperBaseImages();
    const read = (callSignal: AbortSignal) =>
      readHostInventory(docker, { known: here.map(knownDevspace), baseImages: baseImageReferences(here), helperBaseImages: helperBases, signal: callSignal });
    if (options.openLoginOnly !== true) return onHostShell(host, () => read(signal));
    const refused = new AbortController();
    return onHostShell(host, () => read(AbortSignal.any([signal, refused.signal])), refused);
  };
  // The utilization pages of the hosts (R-ENG-009): each sample is one command on the shared shell of the host, and the
  // page never starts the VM of Devspaces (R-VM-004). The free space of this computer for the disk of the VM is that of
  // the folder of its disk.
  const vmDiskFolder = limaVm !== undefined ? limaVm.paths.home : wslFolder;
  const usagePages = new UsagePages({
    extensionUri: context.extensionUri,
    logger,
    showLog: () => logger.show(),
    vmHost,
    shells,
    vmState: readVmState,
    vmStopping: () => vmHost === WSL_HOST && keeper.stopping(WSL_DISTRIBUTION),
    startVm: () => vmCommands.start(),
    actionsAllowed: () => dockerHostsActionsAllowed(settings),
    readSizes: readInventory,
    ...(vmDiskFolder !== undefined ? { localDiskFree: () => freeSpace(vmDiskFolder) } : {}),
  });
  context.subscriptions.push(usagePages);
  // The report pages of the objects of the view Docker Hosts (R-ENG-010): their reads run on the shared shell of the
  // host, as the reads of the view, and never start the VM of Devspaces (the page reads its state first).
  let currentHelperTag: Promise<string | undefined> | undefined;
  const readCurrentHelperTag = (): Promise<string | undefined> =>
    (currentHelperTag ??= fs.promises.readFile(helperDockerfile, 'utf8').then(helperImageTag, () => {
      currentHelperTag = undefined;
      return undefined;
    }));
  const reportPages = new ReportPages({
    extensionUri: context.extensionUri,
    logger,
    vmHost,
    vmState: readVmState,
    startVm: () => vmCommands.start(),
    read: async (target, clock) => {
      const listed = await registry.list();
      const repositories = new Map(listed.map((devspace) => [devspace.id, devspace.repository] as const));
      // The objects of a devspace of this computer report its entry; only of the devspaces of the host of the report.
      const devspaces = new Map(devspacesOfHost(listed, target.host).map((devspace) => [devspace.id, devspace] as const));
      const helperTag = await readCurrentHelperTag();
      const computer = { id: computerId(), repositories, devspaces, version: userAgentVersion() ?? '0.0.0' };
      return onHostShell(target.host, () => readResourceReport(docker, { object: target.object, ...(helperTag !== undefined ? { currentHelperTag: helperTag } : {}), computer, clock }));
    },
    objectOf: (host, kind, id) => hostsView?.objectOf(host, kind, id),
    // Never a log while the setting devspaces.allowContainerLogs is off: the page shows no Show Log then, and the Docker
    // pipe of the extension refuses the log too; this covers the shared shell of the host, which has no such filter.
    readMonitorLog: (host, timeZone) => (settings.allowContainerLogs === true ? onHostShell(host, () => readMonitorLog(docker, timeZone)) : Promise.reject(new Error(CONTAINER_LOGS_OFF))),
    clock: () => ({ now: Date.now(), timeZone: usableTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone) }),
    allowed: () => ({ actions: dockerHostsActionsAllowed(settings), logs: settings.allowContainerLogs === true }),
  });
  context.subscriptions.push(reportPages);
  // Before a stop or a removal of the VM: its utilization page pauses, and the worker channel, the relay connection and
  // the shell (the shared shell of the view Docker Hosts and of the page) of this window to it end.
  const closeVmConnections = (): void => {
    if (vmHost === undefined) return;
    usagePages.vmClosing();
    channels.close(remoteDockerTarget(vmHost));
    relayConnections.close(vmHost, 'the VM of Devspaces stops');
    shells.close(vmHost);
  };
  // The view "Docker Hosts" (R-ENG-008): the VM of Devspaces and the remote hosts of the list, each with all containers,
  // networks, images and volumes there and its build cache. A host is read only when the user opens its row or clicks
  // Refresh. All Docker calls of the view run on the one shared shell of the host (`onHostShell` above).
  const dockerHosts = new DockerHostsView({
    logger,
    showLog: () => logger.show(),
    actionsAllowed: () => dockerHostsActionsAllowed(settings),
    vmHost,
    hostList: async () => {
      const file = await remoteState.read();
      return { hosts: file.remoteHosts ?? [], selected: file.dockerHost };
    },
    vmState: readVmState,
    read: readInventory,
    stopContainer: (host, object, signal) => onHostShell(host, () => stopHostContainer(docker, object, logger, signal)),
    startContainer: (host, object, signal) => onHostShell(host, () => startHostContainer(docker, object, logger, signal)),
    pruneBuildCache: (host, signal) => onHostShell(host, () => pruneBuildCache(docker, logger, signal)),
    removeObjects: (host, objects, signal, onItem) => onHostShell(host, () => removeHostObjects(docker, objects, { logger, signal, onItem })),
    removeFromList: (host) => remoteDocker.removeFromList(host),
  });
  hostsView = dockerHosts;
  let resolvedHost: string | undefined;
  const hostsTree = vscode.window.createTreeView(DOCKER_HOSTS_VIEW_ID, { treeDataProvider: dockerHosts, canSelectMany: true, showCollapseAll: true });
  context.subscriptions.push(
    dockerHosts,
    hostsTree,
    // The check mark of the Docker host of Devspaces follows a change in another window too; each operation reads the
    // Docker host, so only a change shows the hosts again.
    {
      dispose: targets.onDidResolve((target) => {
        if (target.host === resolvedHost) return;
        resolvedHost = target.host;
        dockerHosts.changed();
      }),
    },
    // The rows of the hosts (not their objects) are read again when the view shows again.
    hostsTree.onDidChangeVisibility((event) => {
      if (event.visible) dockerHosts.changed();
    }),
  );
  // Start, Stop, Remove, Remove and Set Up Again, and the settings of the VM in its row (R-VM-010).
  const vmCommands = new VmCommands({
    logger,
    showLog: () => logger.show(),
    vmHost,
    hasSettings: limaVm !== undefined,
    state: readVmState,
    // The test of the host with its progress, as a choice of the host has it: a Docker call there starts the VM.
    start: (host) => remoteDocker.testHost(host),
    runningDevspaces: async () => {
      if (vmHost === undefined) return [];
      const here = devspacesOfHost(await registry.list(), vmHost);
      return onHostShell(vmHost, () => runningDevspaces(docker, here.map(knownDevspace)));
    },
    stop: async (signal) => {
      if (limaSetupCore !== undefined) return limaSetupCore.stop(signal);
      if (wslSetupCore !== undefined) return wslSetupCore.stop(signal);
    },
    closeConnections: closeVmConnections,
    remove: () => (platform === 'win32' ? wslSetup.remove() : limaSetup.remove()),
    removeAndSetUpAgain: () => (platform === 'win32' ? wslSetup.removeAndSetUpAgain() : limaSetup.removeAndSetUpAgain()),
    setUp: () => (platform === 'win32' ? wslSetup.setUp() : limaSetup.setUp()),
    onDidChange: (reread) => {
      if (reread && vmHost !== undefined) dockerHosts.invalidate(vmHost);
      dockerHosts.changed();
      usagePages.vmChanged();
      reportPages.vmChanged();
    },
  });
  const controller = new Controller({
    logger,
    registry,
    registryNeedsRestore: needsRestore,
    sessionFiles,
    disconnectRequests,
    docker,
    // The flows of the window, also the token removal, run in the worker of the current engine through `service` (the
    // worker is the deputy of this computer).
    service,
    discovery,
    auth,
    connection,
    coordinator: sessionCoordinator,
    sidebar,
    statusBar,
    settings: getSettings,
    dockerSetup: setup,
    repositoryGroupsEditor,
    viewVisible: () => view.visible,
    expandAll: () => expandAll(view, tree.getModel()),
    revealRow: (rowId) => revealRow(view, tree, rowId),
    development: context.extensionMode === vscode.ExtensionMode.Development,
    dockerTargets: targets,
    // The Docker pipe of the window of a devspace on a remote host (docs/architecture.md "The Docker pipe").
    windowDockerHost: (devspace, shownContainer) =>
      windowDockerHost(devspace, shownContainer, {
        computerId,
        platform,
        env,
        tmpdir: os.tmpdir(),
        transportFound,
        current: connection.currentDockerHost(),
      }),
    // The connection of the window of a devspace on an SSH host after a Start: through the worker of its engine, as the
    // Docker pipe of the window opens it, but before the attach (Controller.connectAfterStart).
    hostConnection: {
      sshHostOf: (devspace) => {
        const host = dockerHostOf(devspace);
        return hostAccessOf(host)?.kind === 'ssh' ? host : undefined;
      },
      connect: async (host, options) => {
        const target = await hostEngine(host, engineSources);
        if (target === undefined) throw new Error(`${host} is no remote Docker host`);
        await channels.ensure(target, options.signal, { again: options.again });
      },
    },
    remoteDocker,
    wslSetup,
    limaSetup,
    wslAfterInstall,
    dockerHosts,
    usagePages,
    reportPages,
    vm: vmCommands,
    hostConsoles,
    dockerHostsSettings: () => chooseDockerHostsSettings({ logger, settings: () => settings }),
    // Close and Keep Running tells the Monitor at once, on every engine, and Keep Running When Closed and Stop
    // When Closed too, through this window's worker of the engine.
    sessionMonitor: {
      sendHeartbeat: (devspaceId) => windowHeartbeats.sendFor(devspaceId),
      // The stopNow heartbeat of a manual Stop.
      sendStop: (devspaceId) => windowHeartbeats.sendStop(devspaceId),
    },
    // "Update All Images Now", through this window's worker of the engine, with the monitor settings of this computer
    // for that engine (as the repair of a heartbeat).
    updateImagesNow: async (target, signal) => monitorCalls.monitorRunNow(target, await monitorSettings.forTarget(target), signal),
    // Before the request, the step "Docker start" of Start: Podman is refused, a local Docker that does not run is
    // started.
    startDocker,
    // The removal mark of the engines, which a Start, a Rebuild and "Update All Images Now" of the user clear there.
    engineRecords,
    // "Remove Devspaces from This Docker Engine…": whether the engine answers (as for the background builds: Docker is
    // never started, a remote host gets the SSH check without questions first), the Docker CLI of the extension for the
    // inventory and the removal, the end of this window's worker there, and the ID of this computer.
    engineRemoval: {
      engineAnswers: (target, signal) =>
        runWithDockerTarget(target, () =>
          dockerEngineAnswers(target, engineAnswersDeps(), signal),
        ),
      docker,
      // The connection of the relay too: the removal removes the container of its worker next. Its calls after this log
      // in with the Docker context without a new SSH check: the connection was such a login without questions, and it
      // carried the calls of the inventory a moment before.
      closeWorker: (target) => {
        channels.close(target);
        if (target.kind === 'remote') relayConnections.close(target.host, 'Devspaces is removed from the engine');
      },
      // Neither background build of the helper image makes it again after its removal.
      stopHelperBuilds: async (target) => {
        await Promise.all([backgroundPrebuild?.stop(target), helperBuilds.stop(target)]);
      },
      computerId,
    },
    // "Remove Devspaces from This Computer…" (R-GEN-009): the VM without its question, the SSH key of Devspaces with its
    // line on each host, the files of the uninstall hook (with the environment of this window, which VS Code took from
    // the shell of the user), and the uninstall of the extension by VS Code.
    computerCleanup: new ComputerCleanup({
      logger,
      state: remoteState,
      vmHost,
      vmState: () =>
        computerVmState({
          limaHome: limaVm?.paths.home,
          wsl: limaVm === undefined && wslSetupCore !== undefined && wslFolder !== undefined ? { registration: () => wslSetupCore.registration(), folder: wslFolder, known: wslDistributionKnown } : undefined,
        }),
      removeVm: () => (limaVm !== undefined ? limaSetup.removeForComputer() : wslSetup.removeForComputer()),
      vmGone: () => {
        background(syncVmDockerContext(false), 'update the Docker context of the VM of Devspaces');
        background(updateVmTask(), 'update the scheduled task of the VM of Devspaces');
      },
      key: sshKeys,
      folder: limaVm?.paths.root ?? (wslFolder !== undefined ? path.win32.dirname(wslFolder) : undefined),
      files: { runner, platform, env, homeDir: os.homedir(), uid: () => os.userInfo().uid },
      uninstallExtension: async () => {
        await vscode.commands.executeCommand('workbench.extensions.uninstallExtension', context.extension.id);
      },
    }),
  });
  // A link to Devspaces, for example on a website (links.ts; the activation event onUri starts the extension for it):
  // taken at once, because VS Code keeps a link only for some minutes until an extension takes it. Controller.openLink
  // waits for the end of the activation, when this window knows its role and its devspace.
  controller.setActivation(activation);
  context.subscriptions.push(
    sidebar,
    controller,
    ...controller.registerCommands(),
    vscode.window.registerUriHandler({ handleUri: (uri) => controller.openLink(uri) }),
    controller.watchDisconnectRequests(),
    // Enter on an owner or a group opens or closes it and runs no command (Controller.rowEnter).
    view.onDidExpandElement(() => controller.nodeToggled()),
    view.onDidCollapseElement(() => controller.nodeToggled()),
    // The first load shows the repositories as they arrive.
    discovery.onPartialResult((result) => sidebar.onPartialResult(result)),
  );

  const background = (promise: Promise<unknown>, what: string): void => {
    promise.catch((error: unknown) => logger.error(`Could not ${what}.`, error));
  };
  // The distribution of Devspaces is never the default distribution of WSL, and Docker Desktop does not integrate it
  // (only with its folder; WslSetupCommands.checkSeparation).
  if (wslPath() !== undefined) background(wslSetup.checkSeparation(), 'check the WSL distribution of Devspaces');

  // The Docker CLI of Devspaces that this window needs and does not have yet: downloaded now, with a progress notification
  // (its link Show details needs the commands above), before the window looks up its devspace and serves its pipe, and
  // before activate() returns. On a computer without a Docker CLI, the Docker calls of Devspaces and the Docker setup in
  // the sidebar take it at once.
  if (pipeWindow && ownCliBuild && ownCli === undefined) {
    const cli = await installOwnDockerCliWithProgress({ folder: paths.dockerCliDir, platform, arch: process.arch, logger, fallback: installedCli });
    if (cli !== undefined) {
      useOwnDockerCli(cli);
      if (installedCli === undefined) {
        docker.lookUpCliNow();
        dockerSetup?.checkCli();
      }
    }
  }

  // The devspace of this window: the container of its folder URI, if the registry knows it.
  const containerName = connection.currentContainerName();
  // Whether this window reaches its container through its Docker pipe for the Docker host `host` (the ID of the pipe in
  // its authority, dockerPipeId): its window connects there, so it starts a WSL distribution there anyway, and the
  // restore of a lost registry for it may start it too. False without an ID of this computer.
  const windowPipeOn = (host: string): boolean => {
    const address = parseDockerPipeHost(connection.currentDockerHost() ?? '', platform);
    if (containerName === undefined || address === undefined) return false;
    try {
      return address.id === dockerPipeId(computerId(), host, containerName);
    } catch {
      return false;
    }
  };
  // Before the first use of Devspaces (no registry.json and no marker of it), the activation asks Docker nothing in the
  // background: no restore of lost devspaces, no prebuild of the helper image. The window of a devspace container does
  // both, so it finds its devspace also after the storage folder was lost (backgroundWorkAtStart).
  const startWork = backgroundWorkAtStart(await devspacesUsed(paths, logger), containerName);
  // A lost registry is restored from the current engine, through its worker: never from an engine with the removal
  // mark, which this computer asks nothing by itself (the check of the worker for a passive read refuses it there too).
  const mayRestore = startWork ? async (): Promise<boolean> => !(await engineRemoved(await targets.current())) : false;
  const currentDevspace = containerName
    ? await findWindowDevspace(containerName, { registry, needsRestore, docker, current: () => targets.current(), service, logger, mayRestore, windowPipeOn })
    : undefined;
  // Nothing was restored from an engine with the removal mark: the labels of the container of this window still give its
  // devspace and its owner (one plain `docker container inspect`, no worker), so that the account rule holds there too.
  const labeled: ContainerDevspace =
    containerName !== undefined && currentDevspace === undefined && startWork
      ? await removedEngineWindowDevspace(containerName, { needsRestore, docker, current: () => targets.current(), removed: engineRemoved, now: () => isoTime(systemClock), logger })
      : { kind: 'none' };
  const windowDevspace = currentDevspace ?? (labeled.kind === 'devspace' ? labeled.devspace : undefined);
  // A window of a devspace that the user kept on an engine with the removal mark ("Remove Devspaces from This Docker
  // Engine…") works without Devspaces: its heartbeats and its open would set Devspaces up there again. Its session
  // starts without the devspace, and the window stays connected as a plain container window; the account rule still
  // closes the window of a devspace that the signed-in account may not use (Controller.workWithoutDevspaces), and the
  // window of a container whose owner cannot be read (Controller.leaveUnknownOwner).
  const onRemovedEngine = labeled.kind !== 'none' || (currentDevspace !== undefined && (await engineRemoved({ host: dockerHostOf(currentDevspace) })));
  // The Docker pipe in the authority of this window (docs/architecture.md "The Docker pipe"): served before activate()
  // returns, because the Dev Containers extension reaches the engine of the devspace through it once VS Code resolves
  // the authority; and before the session starts, so that a window whose pipe is refused is never the window of its
  // devspace in its status file.
  let pipeRefused: string | undefined;
  const pipeHost = connection.currentDockerHost();
  if (pipeHost !== undefined && containerName) {
    const served = await serveWindowPipe(pipeHost, containerName, windowDevspace, {
      logger,
      platform,
      computerId,
      // The hosts of the list of Devspaces, and the SSH hosts of the Docker contexts of the user.
      knownHosts: async () => {
        const [listed, contexts] = await Promise.all([remoteState.remoteHosts(), sshHostsOfContexts(docker).catch(() => [])]);
        return [...new Set([...listed, ...contexts.map((entry) => entry.host)])];
      },
      engineRemoved: (host) => engineRemoved({ host }),
      openRelayConnection: (host) => relayConnections.get(host),
      relayConnection: async (host) => {
        // The worker of the engine opens the connection, whatever host Devspaces uses now.
        const target = await hostEngine(host, engineSources);
        if (target === undefined) throw new Error(`${host} is no remote Docker host`);
        await channels.ensure(target);
        const opened = relayConnections.get(host);
        if (opened === undefined) throw new Error(`the worker on ${host} runs without the connection of the relay`);
        return opened;
      },
      dialStdio,
    });
    // Closed at once when the window closes (the release of deactivate() does not use it), so that the extension host of
    // the window after a reload can serve the address.
    if (served.kind === 'served') context.subscriptions.push({ dispose: () => served.pipe.close() });
    if (served.kind === 'refused' && labeled.kind !== 'unreadable') pipeRefused = served.reason;
  }

  // Writes the window status file and cleans up the storage folder. Its result is the pending connection file of this
  // window's devspace, which the first status write removes (role A).
  const started = sessionCoordinator.start(onRemovedEngine || pipeRefused !== undefined ? null : (currentDevspace?.id ?? null));
  controller.setReady(started);

  const focusThrottle = new Throttle(FOCUS_REFRESH_INTERVAL_MS);
  context.subscriptions.push(
    onDidChangeBusy((change) => controller.onBusyChanged(change)),
    sessionCoordinator.onDidHeartbeat(() => {
      controller.onHeartbeat();
      // Only the coordination files; Docker is not asked in the background (Resource Saver of Docker Desktop).
      if (view.visible) background(sidebar.render(), 'update the sidebar');
    }),
    sidebar.onDidRefreshStates(() => controller.onStatesRefreshed()),
    // The name of the devspace in the status bar follows the rows of the sidebar (a changed list or setting).
    sidebar.onDidRender(() => controller.onStatesRefreshed()),
    view.onDidChangeVisibility((event) => {
      if (!event.visible) return;
      setup.onViewShown();
      background(sidebar.refreshStates(), 'update the sidebar');
    }),
    vscode.window.onDidChangeWindowState((state) => {
      // An offer of a GitHub account that waited for the focus of this window.
      if (state.focused) background(accountOffers.onFocused(), 'offer the GitHub accounts of VS Code');
      if (!state.focused || !focusThrottle.tryAcquire()) return;
      background(view.visible ? sidebar.refreshStates() : sidebar.render(), 'update the sidebar');
    }),
    auth.onDidChangeSession(() => {
      // A window of a devspace of an account that signed out closes; the view shows the lists of the accounts now.
      background(controller.onSessionChanged(), 'check the devspace of this window after the account change');
      background(sidebar.onSessionChanged(), 'update the sign-in state');
      // A GitHub account of VS Code that Devspaces does not use yet is offered once.
      background(accountOffers.check(), 'offer the GitHub accounts of VS Code');
    }),
    // GitHub rejected the token of the session, or accepted it again: the same account, so only the view changes.
    auth.onDidChangeSignInState(() => background(sidebar.onSessionChanged({ again: false }), 'update the sign-in state')),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!affectsSettings(event)) return;
      const previous = settings;
      settings = readSettings();
      warnInvalidHostAccessChecksOff(logger, hostAccessWarnings, event);
      warnInvalidDefaultImage(logger, defaultImageWarnings, event);
      warnInvalidCacheUpdateSchedule(logger, cacheScheduleWarnings, event);
      if (hasLimaVm) warnVmResources(logger, vmResourceWarnings, settings, machine, event);
      if (event.affectsConfiguration(`${SETTINGS_SECTION}.createDockerContext`)) background(syncVmDockerContext(true), 'update the Docker context of the VM of Devspaces');
      if (event.affectsConfiguration(`${SETTINGS_SECTION}.cacheUpdateSchedule`)) background(updateVmTask(), 'update the scheduled task of the VM of Devspaces');
      updateOwnersContextKey(settings.owners, logger);
      updateDevspacesOnlyContextKey(settings.showOnlyDevspaces === true, logger);
      // The menus follow dockerHostsActions by themselves (`config.` in their `when`); the rows of the view and the report
      // pages show their actions and Show Log again.
      if (event.affectsConfiguration(`${SETTINGS_SECTION}.dockerHostsActions`) || event.affectsConfiguration(`${SETTINGS_SECTION}.allowContainerLogs`)) {
        dockerHosts.changed();
        reportPages.settingsChanged();
        usagePages.settingsChanged();
      }
      // Another scan scope loads the list again at once.
      if (!sameScope(previous.owners, settings.owners)) {
        background(sidebar.onScopeChanged(), 'load the repository list of the selected organizations');
      }
      background(sidebar.render(), 'update the sidebar');
      sidebar.restartTimer();
    }),
  );

  // The icons of Select Organizations… and Show Only Devspaces in the view title bar.
  updateOwnersContextKey(settings.owners, logger);
  updateDevspacesOnlyContextKey(settings.showOnlyDevspaces === true, logger);
  // The note of the welcome view when the settings of VS Code name a GitHub Enterprise instance.
  context.subscriptions.push(watchGitHubEnterpriseSettings(logger));
  // The Docker host of the view title (every later read of the context updates it too).
  background(targets.resolve(), 'read the Docker host');
  // The Docker context of the VM as the setting createDockerContext asks (usually only a read of the context store).
  background(syncVmDockerContext(false), 'update the Docker context of the VM of Devspaces');
  // The scheduled task of the VM as the settings ask (usually only reads of its files).
  background(updateVmTask(), 'update the scheduled task of the VM of Devspaces');
  // The stored list at once, then the background refresh.
  const listed = sidebar.initialize();
  background(listed, 'show the repository list');
  // A GitHub account of VS Code that Devspaces does not use yet is offered once (not before the stored list shows).
  background(listed.then(() => accountOffers.check()), 'offer the GitHub accounts of VS Code');
  if (view.visible) {
    // The view may have become visible while the activation waited above: VS Code sends that event once, before the
    // listener existed, so the setup looks at the view here too (`wsl --status` while it shows the Docker setup).
    setup.onViewShown();
    background(sidebar.refreshStates(), 'update the sidebar');
  }
  // A lost registry is rebuilt from the volume labels (only when Docker runs, and not before the first use). A window
  // whose container the registry did not know takes its restored devspace. Neither runs on an engine that Devspaces
  // was removed from (backgroundEngineAtStart).
  const adopt = Boolean(containerName) && currentDevspace === undefined;
  const startEngine = startWork ? backgroundEngineAtStart({ current: () => targets.current(), removed: engineRemoved, logger }) : Promise.resolve(undefined);
  background(
    startEngine.then((target) => (target === undefined ? undefined : controller.reconcileIfRegistryLost({ passive: true, adopt, mayStart: windowPipeOn(target.host) }))),
    'restore the devspaces from the volumes',
  );
  // When helper.json does not know the current helper tag (after the installation, or an update that changed it; there
  // is no previous helper image to fall back to), the helper image is built in the background, when Docker runs and
  // Devspaces was used before (startWork; before the first use, the first Start builds it). No cross-window lock:
  // windows that start together may each build once, later ones find the record. The build (HelperImages.prebuildImage)
  // is shared with the preparation of a worker in this window (HelperImages.ensureImagePresent, ensureImageUse before
  // an open) and cancelled when the extension is deactivated.
  // With updateImagesOnConnect on, it also runs when helper.json says that the refresh of the helper image is due (the
  // rebuild that a check asked for, the weekly check), never for the daily cleanup alone; its maintaining ensure then
  // also runs the cleanup when that is due. On the Docker engine of the current Docker context, local or remote alike,
  // as an operation on it (the state file and engine key of an open there); the WSL distribution gets the start of its
  // shell before its `docker info` (dockerEngineAnswers), and an SSH host is prepared only through the connection of
  // this window to it, when that connection is open (`connection`). A switch to another host starts the prebuild there
  // (prebuildAfterSwitch), once per host in this window, and again on a host where the first try found Docker not running
  // (the VM of Devspaces before its setup).
  const helperPrebuild = new HelperPrebuild({
    helper,
    dockerRunning: (target, signal) =>
      dockerEngineAnswers(target, engineAnswersDeps(), signal),
    // On an SSH host, it waits for the connection of the relay of this window to the host, and runs only through it
    // (docs/requirements.md R-ENG-002).
    connection: (host, signal) => (hostPipes === undefined ? Promise.reject(abortError()) : hostPipes.whenDockerHost(host, signal)),
    dockerfilePath: context.asAbsolutePath(path.join('resources', 'helper', 'Dockerfile')),
    statePath: paths.helperState,
    // The setting decides the check of the base image and the rebuild, not the cleanup.
    checkBaseImage: () => getSettings().updateImagesOnConnect,
    logger,
  });
  context.subscriptions.push(helperPrebuild);
  backgroundPrebuild = helperPrebuild;
  background(
    startEngine.then(async (target) => {
      if (target === undefined) return;
      const outcome = await helperPrebuild.start(target);
      // A lost registry is restored again once the helper image was built. A failed restore is logged as such, not as
      // a failed preparation.
      await restoreAfterPrebuild(outcome, () => controller.reconcileIfRegistryLost({ passive: false, adopt, mayStart: windowPipeOn(target.host) })).catch((error: unknown) =>
        logger.error('Could not restore the devspaces from the volumes after the helper image was prepared.', error),
      );
    }),
    'prepare the workspace helper image in the background',
  );

  if (currentDevspace && containerName && docker.isInstalled() && !onRemovedEngine && connection.currentDockerHost() === undefined) {
    // Which Docker the Dev Containers extension asks when it resolves this window. Only for a devspace of this
    // extension, and not for a window whose authority names a Docker host: its Docker pipe logs the Docker calls that
    // come through it, and serveWindowPipe logged any other address. Its context: the one in the authority of this
    // window (a window of a remote devspace of the versions that made a Docker context for each host), through which
    // the Dev Containers extension attaches; else the current context, which a window of a local devspace uses.
    const own = connection.currentDockerContext();
    const logDocker = async (): Promise<void> => {
      const lines = await attachDiagnostics(docker, docker.processEnv(), containerName, own);
      for (const line of lines) logger.info(`While this window connects: ${line}`);
    };
    background(logDocker(), 'log the Docker of this window');
  }

  // Without its Docker pipe, the window must not connect. The window of a container whose owner cannot be read leaves
  // below, after the token left the container.
  if (pipeRefused !== undefined && containerName) {
    await started;
    await controller.leaveWithoutDockerPipe(containerName, pipeRefused);
    return;
  }

  if (windowDevspace && containerName) {
    // Role A: the open pipeline runs before VS Code connects this window (awaited). Assumption
    // (ATTACHED_CONTAINER_ACTIVATION_EVENT): VS Code waits for activate() before it resolves the authority.
    const pending = await started;
    // The stored list first, so that the progress and the status bar name the devspace as the sidebar shows it (with
    // the word of its source when the repository has several sources).
    await listed.catch(() => undefined);
    if (onRemovedEngine) await controller.workWithoutDevspaces(windowDevspace, containerName);
    else await controller.openAttachedWindow(windowDevspace, containerName, pending);
    return;
  }
  if (labeled.kind === 'unreadable' && containerName) {
    await started;
    await controller.leaveUnknownOwner(containerName, labeled);
    return;
  }
  background(started, 'start the window session');
  // Role B: pending operations, then the reopen rule. Role C (a local folder or another remote): nothing of its own.
  if (connection.isEmptyWindow()) background(controller.runEmptyWindowTasks(activatedAt), 'run the tasks of the empty window');
  // Windows: the setup of Docker for Devspaces, and its link, after the restart that the installation of WSL asked for.
  if (wslAfterInstall !== undefined) background(started.then(() => controller.goOnAfterWslInstall()), 'go on with the setup of Docker after the restart of Windows');
}
