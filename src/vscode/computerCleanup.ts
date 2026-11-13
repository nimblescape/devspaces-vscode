// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The parts of "Remove Devspaces from This Computer…" (docs/requirements.md R-GEN-009) besides the Docker engines of the
// list, which the controller removes itself: the VM of Devspaces, the SSH key of Devspaces with its line on each host,
// the files of Devspaces outside of VS Code (the steps of the uninstall hook, src/core/devspacesFiles.ts), and at the
// end the uninstall of the extension. Each step returns what stays, for the last message of the command; each one is
// logged too. No question: the command asked once before.
import * as fs from 'fs';
import { sshCommandArgs, sshTargetOf } from '../core/docker/dockerHost';
import { noPromptEnv } from '../core/docker/remoteDocker';
import { removeDevspacesFiles, type DevspacesFilesDeps } from '../core/devspacesFiles';
import { errorMessage } from '../core/errors';
import type { Logger, ProcessRunner } from '../core/ports';
import { shellWord } from '../core/relay/startScript';
import { parsePublicKey, removeKeyLinesCommand, type PublicKey } from '../core/sshKey';
import type { RemoteDockerState } from '../core/storage/remoteDockerState';

/** The longest time of a login to a host for the removal of the line of the key, and of `ssh-keygen -y`. */
const KEY_STEP_TIMEOUT_MS = 30_000;

/** What this computer has of Devspaces besides the devspaces, for the question of the command. */
export interface ComputerInventory {
  /** The remote Docker hosts of the list of Devspaces, without the VM of Devspaces. */
  engines: string[];
  /** The VM of Devspaces on this platform (LIMA_HOST or WSL_HOST), when it exists. */
  vm: string | undefined;
  /** The hosts where Devspaces added the line of its SSH key to `~/.ssh/authorized_keys` (remote-docker.json). */
  keyHosts: string[];
  /** The private key of Devspaces, when its file exists. */
  keyFile: string | undefined;
  /** The folder of Devspaces outside of VS Code (`~/.nimblescape/devspaces`), when it exists. */
  folder: string | undefined;
}

export interface ComputerCleanupDeps {
  logger: Logger;
  runner: ProcessRunner;
  env: NodeJS.ProcessEnv;
  state: Pick<RemoteDockerState, 'remoteHosts' | 'read' | 'setSshKey'>;
  /** The VM of Devspaces on this platform (LIMA_HOST or WSL_HOST), undefined where there is none. */
  vmHost: string | undefined;
  /** Whether the VM of Devspaces exists, without a start. */
  vmExists: () => Promise<boolean>;
  /** The removal of the VM without a question (LimaSetupCommands/WslSetupCommands.removeForComputer): what stays. */
  removeVm: () => Promise<string | undefined>;
  /** The private key of Devspaces (devspacesKeyPath). */
  keyPath: string;
  /** The `ssh` and the `ssh-keygen` of this computer (findExecutable), or undefined. */
  sshPath: () => string | undefined;
  sshKeygenPath: () => string | undefined;
  /** The folder of Devspaces outside of VS Code, or undefined where there is none. */
  folder: string | undefined;
  /** The deps of the steps of the uninstall hook in this window (removeDevspacesFiles), without the logger. */
  files: Omit<DevspacesFilesDeps, 'logger'>;
  /** VS Code uninstalls this extension (the command workbench.extensions.uninstallExtension). */
  uninstallExtension: () => Promise<void>;
  /** Only for the tests. */
  exists?: (file: string) => boolean;
}

/** User-visible texts of the steps (plain language). */
export const ComputerCleanupTexts = {
  keyLineLeft: (host: string, detail: string) =>
    `The line of the SSH key of Devspaces could not be removed from ~/.ssh/authorized_keys on ${host} (${detail}). Remove the line that ends with "devspaces@" and the name of this computer there.`,
  keyKept: (keyPath: string) => `The SSH key of Devspaces stays on this computer (${keyPath}), so that a new run of the command can still log in with it.`,
  keyUnreadable: (keyPath: string, detail: string) => `The SSH key of Devspaces ${keyPath} could not be read, so its line stays on the hosts: ${detail}`,
  keyFileLeft: (file: string, detail: string) => `The file ${file} could not be deleted: ${detail}`,
};

export class ComputerCleanup {
  constructor(private readonly deps: ComputerCleanupDeps) {}

  /**
   * What this computer has of Devspaces besides the devspaces. Never throws: a list that cannot be read counts as empty,
   * a VM whose state cannot be read counts as there, so that the question names it.
   */
  async inventory(): Promise<ComputerInventory> {
    const { logger, vmHost } = this.deps;
    const list = await this.deps.state.remoteHosts().catch((error: unknown) => {
      logger.warn(`The list of Docker hosts of Devspaces could not be read: ${errorMessage(error)}`);
      return [];
    });
    const records = await this.deps.state.read().catch(() => ({ hosts: [] }));
    const vm = vmHost !== undefined && (await this.deps.vmExists().catch(() => true)) ? vmHost : undefined;
    return {
      engines: list.filter((host) => host !== vmHost),
      vm,
      keyHosts: (records.hosts ?? []).filter((record) => record.sshKey === 'installed').map((record) => record.host),
      keyFile: this.exists(this.deps.keyPath) ? this.deps.keyPath : undefined,
      folder: this.deps.folder !== undefined && this.exists(this.deps.folder) ? this.deps.folder : undefined,
    };
  }

  /** The VM of Devspaces with every devspace in it, its host in the list, its Docker context and its scheduled task. */
  removeVm(): Promise<string | undefined> {
    return this.deps.removeVm();
  }

  /**
   * The line of the key of Devspaces in `~/.ssh/authorized_keys` on each host of `hosts` (a login with the key itself,
   * which asks nothing), then the key files, but only when every line went: with a line that stays, the key stays too,
   * so that a new run of the command can log in with it. What stays. Never throws.
   */
  async removeSshKey(hosts: readonly string[]): Promise<string[]> {
    const { logger, keyPath } = this.deps;
    const left: string[] = [];
    if (hosts.length > 0) {
      const key = await this.publicKey().catch((error: unknown) => ({ error }));
      if ('error' in key) {
        const text = ComputerCleanupTexts.keyUnreadable(keyPath, errorMessage(key.error));
        logger.warn(text);
        return [text];
      }
      for (const host of hosts) {
        const failure = await this.removeKeyLine(host, key);
        if (failure === undefined) {
          logger.info(`The line of the SSH key of Devspaces was removed from ~/.ssh/authorized_keys on ${host}.`);
          await this.deps.state.setSshKey(host, undefined).catch((error: unknown) => logger.warn(`The key state of ${host} could not be recorded: ${errorMessage(error)}`));
          continue;
        }
        const text = ComputerCleanupTexts.keyLineLeft(host, failure);
        logger.warn(text);
        left.push(text);
      }
    }
    if (left.length > 0) {
      left.push(ComputerCleanupTexts.keyKept(keyPath));
      return left;
    }
    for (const file of [keyPath, `${keyPath}.pub`]) {
      try {
        await fs.promises.rm(file, { force: true });
      } catch (error) {
        const text = ComputerCleanupTexts.keyFileLeft(file, errorMessage(error));
        logger.warn(text);
        left.push(text);
      }
    }
    if (left.length === 0) logger.info(`Devspaces deleted its SSH key ${keyPath}, if it was there.`);
    return left;
  }

  /** The Docker context, the scheduled task and the folder of Devspaces outside of VS Code (removeDevspacesFiles). */
  removeFiles(): Promise<string[]> {
    return removeDevspacesFiles({ ...this.deps.files, logger: this.deps.logger });
  }

  uninstallExtension(): Promise<void> {
    return this.deps.uninstallExtension();
  }

  /** Removes the line of `key` on `host` with a login that may use only the key; undefined when it went, else why not. */
  private async removeKeyLine(host: string, key: PublicKey): Promise<string | undefined> {
    const ssh = this.deps.sshPath();
    const target = sshTargetOf(host);
    if (ssh === undefined) return 'ssh was not found on this computer';
    if (target === undefined) return 'the host is no SSH alias or address';
    // In `sh`, whatever the login shell of the account is.
    const command = `sh -c ${shellWord(removeKeyLinesCommand(key))}`;
    try {
      const result = await this.deps.runner.run(ssh, sshCommandArgs(target, command, undefined, { identity: this.deps.keyPath, identityOnly: true }), {
        env: noPromptEnv(this.deps.env),
        timeoutMs: KEY_STEP_TIMEOUT_MS,
      });
      if (result.timedOut) return `ssh did not answer within ${KEY_STEP_TIMEOUT_MS / 1000} seconds`;
      return result.exitCode === 0 ? undefined : result.stderr.trim() || `ssh failed with exit code ${result.exitCode}`;
    } catch (error) {
      return errorMessage(error);
    }
  }

  /** The public key of the key file of Devspaces: from the private key (`ssh-keygen -y`), else from its `.pub` file. */
  private async publicKey(): Promise<PublicKey> {
    const { keyPath, runner, env } = this.deps;
    const keygen = this.deps.sshKeygenPath();
    if (keygen !== undefined && this.exists(keyPath)) {
      const read = await runner.run(keygen, ['-y', '-f', keyPath], { env: noPromptEnv(env), timeoutMs: KEY_STEP_TIMEOUT_MS });
      const key = read.exitCode === 0 ? parsePublicKey(read.stdout) : undefined;
      if (key !== undefined) return key;
    }
    const text = await fs.promises.readFile(`${keyPath}.pub`, 'utf8');
    const key = parsePublicKey(text);
    if (key === undefined) throw new Error(`${keyPath}.pub holds no Ed25519 public key`);
    return key;
  }

  private exists(file: string): boolean {
    return (this.deps.exists ?? fs.existsSync)(file);
  }
}
