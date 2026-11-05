// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The build context of an image as a tar archive, for `docker build -` on another computer, whose Docker CLI reads the
// context from its standard input (BootstrapDocker.buildImage with BootstrapDockerOptions.hostCli: the build in the
// WSL distribution of Devspaces with its own Docker CLI and buildx). Only the files at the top of the folder (the folder
// of the helper image has only its Dockerfile), each with the mode 0644 and the time 0, so that the same files give
// the same archive. No `vscode`.
import * as fs from 'fs';
import * as path from 'path';

/** The size of a header block, and of the blocks that the data is padded to (TAR_BLOCK_BYTES of tarFile.ts, the reader of the worker). */
const BLOCK = 512;
/** The longest name of a file in the header of the archive (ustar, without the prefix field). */
const MAX_NAME_BYTES = 100;
/** The largest context: the folder of the helper image has a few kilobytes. */
const MAX_CONTEXT_BYTES = 1024 * 1024;

/** The ustar header of the file `name` (ASCII) with `size` bytes. */
function header(name: string, size: number): Buffer {
  const block = Buffer.alloc(BLOCK, 0);
  const field = (offset: number, length: number, value: string): void => {
    block.write(value, offset, length, 'ascii');
  };
  /** A number in octal with its NUL, in a field of `length` bytes. */
  const octal = (offset: number, length: number, value: number): void => field(offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`);
  field(0, MAX_NAME_BYTES, name);
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, 0);
  // The checksum is counted with its own field as spaces.
  field(148, 8, '        ');
  field(156, 1, '0');
  field(257, 6, 'ustar\0');
  field(263, 2, '00');
  let sum = 0;
  for (const byte of block) sum += byte;
  field(148, 8, `${sum.toString(8).padStart(6, '0')}\0 `);
  return block;
}

/**
 * The regular files at the top of `folder` as a tar archive (ustar), sorted by name; folders and links in it are left
 * out. Throws for a name that is not ASCII or longer than 100 bytes, and for a context larger than 1 MiB.
 */
export async function contextTar(folder: string): Promise<Buffer> {
  const entries = await fs.promises.readdir(folder, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  const parts: Buffer[] = [];
  let total = 0;
  for (const name of names) {
    if (!/^[\x20-\x7e]+$/.test(name) || name.length > MAX_NAME_BYTES) throw new Error(`The build context has a file whose name a tar header cannot hold: ${name}`);
    const content = await fs.promises.readFile(path.join(folder, name));
    total += content.length;
    if (total > MAX_CONTEXT_BYTES) throw new Error(`The build context ${folder} is larger than ${MAX_CONTEXT_BYTES} bytes.`);
    parts.push(header(name, content.length), content, Buffer.alloc((BLOCK - (content.length % BLOCK)) % BLOCK, 0));
  }
  // The end of the archive: two empty blocks.
  parts.push(Buffer.alloc(2 * BLOCK, 0));
  return Buffer.concat(parts);
}
