// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The parts of "Remove Devspaces from This Computer…" (docs/requirements.md R-GEN-009) besides the Docker engines of the
// list, which the controller removes itself: the VM of Devspaces, the SSH key of Devspaces with its line on each host,
// the files of Devspaces outside of VS Code (the steps of the uninstall hook, src/core/devspacesFiles.ts), and at the
// end the uninstall of the extension. Each step returns what stays, for the last message of the command; each one is
// logged too. No question: the command asked once before.
import * as fs from 'fs';
import { removeDevspacesFiles, type DevspacesFilesDeps } from '../core/devspacesFiles';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/ports';
import { shellWord } from '../core/relay/startScript';
import { removeKeyLinesCommand, type PublicKey } from '../core/sshKey';
import type { RemoteDockerState, RemoteDockerStateFile } from '../core/storage/remoteDockerState';
import type { SshKeyOffer } from './sshKeyOffer';

/** What this computer has of Devspaces besides the devspaces, for the question of the command. */
export interface ComputerInventory {
  /**
   * Why the list of Docker hosts of Devspaces (remote-docker.json) could not be read, or undefined. Then the remote
   * hosts and the SSH key with its line there stay, because the command does not know them.
   */
  listUnreadable: string | undefined;
  /** The remote Docker hosts of the list of Devspaces, without the VM of Devspaces. */
  engines: string[];
  /** The VM of Devspaces on this platform (LIMA_HOST or WSL_HOST), when it exists. */
  vm: string | undefined;
  /** True when only the files of a setup of the VM that did not end are there (`vm` names the host then too). */
  vmLeftovers: boolean;
  /** The hosts where Devspaces added the line of its SSH key to `~/.ssh/authorized_keys` (remote-docker.json). */
  keyHosts: string[];
  /** The private key of Devspaces, when its file exists. */
  keyFile: string | undefined;
  /** The folder of Devspaces outside of VS Code (`~/.nimblescape/devspaces`), when it exists. */
  folder: string | undefined;
}

export interface ComputerCleanupDeps {
  logger: Logger;
  state: Pick<RemoteDockerState, 'readStrict' | 'setSshKey'>;
  /** The VM of Devspaces on this platform (LIMA_HOST or WSL_HOST), undefined where there is none. */
  vmHost: string | undefined;
  /**
   * Whether the VM of Devspaces exists, without a start: `leftovers` when only the files of a setup that did not end are
   * there (which only the removal of the VM removes).
   */
  vmState: () => Promise<'vm' | 'leftovers' | 'none'>;
  /** The removal of the VM without a question (LimaSetupCommands/WslSetupCommands.removeForComputer): what stays. */
  removeVm: () => Promise<string | undefined>;
  /**
   * After the removal of the VM, when the files step did not run (a Cancel): the window updates the scheduled task and
   * the Docker context in the background, as after "Remove the VM…".
   */
  vmGone: () => void;
  /**
   * The SSH key of Devspaces (SshKeyOffer): its file, its public key from the private key (`ssh-keygen -y`), and a
   * command on a host with a login without questions that may use only that key.
   */
  key: Pick<SshKeyOffer, 'keyPath' | 'publicKey' | 'runWithKey'>;
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
  keyLineLeft: (host: string, detail: string, keyPath: string) =>
    `The line of the SSH key of Devspaces could not be removed from ~/.ssh/authorized_keys on ${host} (${detail.replace(/\.$/, '')}). ${ComputerCleanupTexts.removeLinesByHand(keyPath)}`,
  keyKept: (keyPath: string) => `The SSH key of Devspaces stays on this computer (${keyPath}), so that a new run of the command can still log in with it.`,
  keyKeptFor: (hosts: readonly string[], keyPath: string) =>
    `The SSH key of Devspaces stays on this computer (${keyPath}), and so does its line on ${hosts.join(', ')}, where something of Devspaces stays, so that a new run of the command can still log in there with it.`,
  listUnreadable: (detail: string) =>
    `The list of Docker hosts of Devspaces could not be read (${detail}), so Devspaces stays on the remote hosts of the list, and so does its SSH key with its line there. Run the command again when the list can be read, or remove them by hand (Uninstall in the user guide).`,
  keyUnreadable: (keyPath: string, detail: string, hosts: readonly string[]) =>
    `The SSH key of Devspaces ${keyPath} could not be read (${detail.replace(/\.$/, '')}), so its line stays in ~/.ssh/authorized_keys on ${hosts.join(', ')}. ${ComputerCleanupTexts.removeLinesByHand(keyPath)}`,
  keyRefused: (host: string, keyPath: string) =>
    `${host} does not accept the SSH key of Devspaces any more, so Devspaces cannot remove its line there. If ~/.ssh/authorized_keys there still has it, remove it by hand. ${ComputerCleanupTexts.removeLinesByHand(keyPath)}`,
  /** The removal by hand of the lines of the key, with any comment (also from a former name of this computer). */
  removeLinesByHand: (keyPath: string) =>
    `Remove each line there with the public key of ${keyPath}.pub; its comment is "devspaces@" and the name of this computer, or a former name of it.`,
  keyFileLeft: (file: string, detail: string) => `The file ${file} could not be deleted: ${detail}`,
};

export class ComputerCleanup {
  constructor(private readonly deps: ComputerCleanupDeps) {}

  /**
   * What this computer has of Devspaces besides the devspaces. Never throws: a list that cannot be read is named
   * (listUnreadable), never counted as empty, and a VM whose state cannot be read counts as there, so that the question
   * names it.
   */
  async inventory(): Promise<ComputerInventory> {
    const { logger, vmHost } = this.deps;
    let file: RemoteDockerStateFile = {};
    let listUnreadable: string | undefined;
    try {
      file = await this.deps.state.readStrict();
    } catch (error) {
      listUnreadable = errorMessage(error);
      logger.warn(`The list of Docker hosts of Devspaces could not be read: ${listUnreadable}`);
    }
    const vmState = await this.vmState();
    return {
      listUnreadable,
      engines: (file.remoteHosts ?? []).filter((host) => host !== vmHost),
      vm: vmState === 'none' ? undefined : vmHost,
      vmLeftovers: vmState === 'leftovers',
      keyHosts: keyHostsOf(file, vmHost),
      keyFile: this.exists(this.deps.key.keyPath) ? this.deps.key.keyPath : undefined,
      folder: this.deps.folder !== undefined && this.exists(this.deps.folder) ? this.deps.folder : undefined,
    };
  }

  /** Whether the VM of Devspaces exists now (as `vm` of inventory), also only the files of a setup. Never throws. */
  async vmExists(): Promise<boolean> {
    return (await this.vmState()) !== 'none';
  }

  /** Whether the VM of Devspaces itself exists now (not only the files of a setup). Never throws. */
  async vmSetUp(): Promise<boolean> {
    return (await this.vmState()) === 'vm';
  }

  vmGone(): void {
    this.deps.vmGone();
  }

  /** The state of the VM; one that cannot be read counts as there, so that the question names it. */
  private async vmState(): Promise<'vm' | 'leftovers' | 'none'> {
    if (this.deps.vmHost === undefined) return 'none';
    return this.deps.vmState().catch(() => 'vm' as const);
  }

  /** The VM of Devspaces with every devspace in it, its host in the list, its Docker context and its scheduled task. */
  removeVm(): Promise<string | undefined> {
    return this.deps.removeVm();
  }

  /**
   * The line of the key of Devspaces in `~/.ssh/authorized_keys` on each host of `hosts` (a login with the key itself,
   * which asks nothing), then the key files, but only when every line went and `keepFor` is empty: with a line that
   * stays, the key stays too, so that a new run of the command can log in with it. `keepFor`: the hosts with the line
   * where something of Devspaces stays, whose line is not removed. What stays. Never throws.
   */
  async removeSshKey(hosts: readonly string[], keepFor: readonly string[] = []): Promise<string[]> {
    const { logger } = this.deps;
    const { keyPath } = this.deps.key;
    const left: string[] = [];
    let linesLeft = false;
    if (hosts.length > 0) {
      // From the private key itself, never from the .pub file: the login uses the private key, so a .pub file of another
      // key would remove other lines and leave the line of the key.
      const key = await this.deps.key.publicKey().catch((error: unknown) => ({ error }));
      if ('error' in key) {
        const text = ComputerCleanupTexts.keyUnreadable(keyPath, errorMessage(key.error), [...hosts, ...keepFor]);
        logger.warn(text);
        return [text];
      }
      for (const host of hosts) {
        const failure = await this.removeKeyLine(host, key);
        const forget = (): Promise<void> =>
          this.deps.state.setSshKey(host, undefined).catch((error: unknown) => logger.warn(`The key state of ${host} could not be recorded: ${errorMessage(error)}`));
        if (failure === undefined) {
          logger.info(`The line of the SSH key of Devspaces was removed from ~/.ssh/authorized_keys on ${host}.`);
          await forget();
          continue;
        }
        // A host that refuses the login with the key (its line went, or the account changed; the text of `ssh`, not that
        // of a file step there): no later run can log in there with it, so the key does not stay for it, and the record
        // forgets it, so that the next run does not try again.
        if (/Permission denied \(/.test(failure)) {
          const text = ComputerCleanupTexts.keyRefused(host, keyPath);
          logger.warn(`${text} (${failure.replace(/\.$/, '')})`);
          left.push(text);
          await forget();
          continue;
        }
        const text = ComputerCleanupTexts.keyLineLeft(host, failure, keyPath);
        logger.warn(text);
        left.push(text);
        linesLeft = true;
      }
    }
    // A host that got the line meanwhile (another window): the key stays for it too.
    const added = await this.installedHosts().then(
      (installed) => installed.filter((host) => !hosts.includes(host) && !keepFor.includes(host)),
      (error: unknown) => {
        logger.warn(`The list of Docker hosts of Devspaces could not be read again: ${errorMessage(error)}`);
        return undefined;
      },
    );
    if (added === undefined) {
      left.push(ComputerCleanupTexts.keyKept(keyPath));
      return left;
    }
    if (keepFor.length > 0 || added.length > 0) {
      left.push(ComputerCleanupTexts.keyKeptFor([...keepFor, ...added], keyPath));
      return left;
    }
    if (linesLeft) {
      left.push(ComputerCleanupTexts.keyKept(keyPath));
      return left;
    }
    let deleted = true;
    for (const file of [keyPath, `${keyPath}.pub`]) {
      try {
        await fs.promises.rm(file, { force: true });
      } catch (error) {
        const text = ComputerCleanupTexts.keyFileLeft(file, errorMessage(error));
        logger.warn(text);
        left.push(text);
        deleted = false;
      }
    }
    if (deleted) logger.info(`Devspaces deleted its SSH key ${keyPath}, if it was there.`);
    return left;
  }

  /** The hosts of the list whose record says that the line of the key is there, now. Throws when the list cannot be read. */
  private async installedHosts(): Promise<string[]> {
    return keyHostsOf(await this.deps.state.readStrict(), this.deps.vmHost);
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
    // In `sh`, whatever the login shell of the account is.
    return this.deps.key.runWithKey(host, `sh -c ${shellWord(removeKeyLinesCommand(key))}`).catch((error: unknown) => errorMessage(error));
  }

  private exists(file: string): boolean {
    return (this.deps.exists ?? fs.existsSync)(file);
  }
}

/** The hosts of `file` whose record says that the line of the key is there, without the VM. */
function keyHostsOf(file: RemoteDockerStateFile, vmHost: string | undefined): string[] {
  return (file.hosts ?? []).filter((record) => record.sshKey === 'installed' && record.host !== vmHost).map((record) => record.host);
}
