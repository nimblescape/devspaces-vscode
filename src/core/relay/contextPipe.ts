// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The named pipe of the Docker context `devspaces` on Windows (R-ENG-007, docs/architecture.md "The Docker context of
// the VM"): while the setting devspaces.createDockerContext is on and the WSL distribution of Devspaces exists, one
// window of the Windows user serves it at a fixed address (contextPipeAddress), and each of its connections runs its own
// `wsl.exe … docker system dial-stdio` in the distribution. It lets every request through, as a Docker context gives
// full access; only this Windows user can write to it (the default security of a named pipe). The other windows try to
// listen again every minute, so that one of them serves it within a minute after the window that served it closed. No
// `vscode`.
import type { Duplex } from 'stream';
import { errorMessage } from '../errors';
import type { Logger } from '../ports';
import { DockerPipe, type DockerPipeOptions } from './dockerPipe';
import type { DockerPipeAddress } from './pipeAddress';

/** How often a window that does not serve the pipe tries to listen again. */
export const CONTEXT_PIPE_RETRY_MS = 60_000;
/** The name of the pipe in the log. */
const NAME = 'the Docker context devspaces';

export interface ContextPipeDeps {
  logger: Logger;
  address: DockerPipeAddress;
  /** Connects one connection of the pipe with the Docker engine of the WSL distribution (processDockerDial). */
  connect(connection: Duplex): Promise<void>;
  /** For tests. Default: CONTEXT_PIPE_RETRY_MS. */
  retryMs?: number;
  /** For tests. Default: DockerPipe.listen. */
  listen?: (options: DockerPipeOptions) => Promise<Pick<DockerPipe, 'close' | 'isServing'>>;
}

export class ContextPipe {
  private pipe: Pick<DockerPipe, 'close' | 'isServing'> | undefined;
  private wanted = false;
  private listening: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The address was in use at the last try, and this was logged: the next tries log nothing. */
  private inUseLogged = false;

  constructor(private readonly deps: ContextPipeDeps) {}

  get address(): DockerPipeAddress {
    return this.deps.address;
  }

  /** True while this window serves the pipe. */
  isServing(): boolean {
    return this.pipe?.isServing() === true;
  }

  /** Serves the pipe from now on: listens at once, and while another window serves it, tries again every minute. */
  serve(): Promise<void> {
    this.wanted = true;
    return this.tryListen();
  }

  /** Stops serving: closes the pipe, ends its connections, and tries no more. */
  stop(): void {
    this.wanted = false;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pipe?.close();
    this.pipe = undefined;
  }

  private tryListen(): Promise<void> {
    this.listening ??= this.listen().finally(() => {
      this.listening = undefined;
    });
    return this.listening;
  }

  private async listen(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.wanted || this.isServing()) return;
    this.pipe?.close();
    this.pipe = undefined;
    const { logger, address } = this.deps;
    try {
      const pipe = await (this.deps.listen ?? ((options) => DockerPipe.listen(options)))({
        address,
        connect: (connection) => this.deps.connect(connection),
        logger,
        name: NAME,
        // Another window serves the address: no wait for its end, the next try comes in a minute.
        inUseWaitMs: 0,
      });
      if (!this.wanted) {
        pipe.close();
        return;
      }
      this.pipe = pipe;
      this.inUseLogged = false;
    } catch (error) {
      if (!this.inUseLogged) logger.info(`This window does not serve the pipe of ${NAME} now, another window may serve it: ${errorMessage(error)}`);
      this.inUseLogged = true;
    }
    if (this.wanted && this.pipe === undefined) {
      this.timer = setTimeout(() => void this.tryListen(), this.deps.retryMs ?? CONTEXT_PIPE_RETRY_MS);
      this.timer.unref?.();
    }
  }
}
