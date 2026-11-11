// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The script of one utilization sample of a host (docs/architecture.md "The utilization samples"): one fixed POSIX sh
// script that the page of a host runs with `sh -s` on the shared shell of that host (RemoteShells, the shell that the
// view Docker Hosts uses), as the input of that one command. It reads files of /proc and /sys/fs/cgroup and the space
// of the disks; it writes no file, starts no container and calls no Docker CLI, so nothing of it stays on the host and
// it cannot hang on a Docker daemon. Each run prints one block of values (usageSample.ts reads it). It runs in dash
// (Debian), BusyBox ash (Alpine) and bash. The Docker calls of the samples are scripts of their own (usageDockerScript),
// with a time limit on the host. No `vscode`.
import { randomBytes } from 'crypto';
import { shellWord } from '../relay/startScript';

/** The protocol of the script, the second field of its line `#H`. */
export const USAGE_PROTOCOL = 2;

/** The kind of a sample: `t` the counters, `d` also the disks and, on WSL, the idle check. */
export type UsageSampleKind = 't' | 'd';

/**
 * The script with the placeholders @MARK@ (the marker, 32 hexadecimal digits), @SEQ@ (the number of the sample), @KIND@
 * (t or d), @WI@ (1: the idle check of WSL) and @ROOT@ (the data folder of Docker when it is not /var/lib/docker, else
 * empty). The whole text is one compound command in braces, so the shell reads all of it before it runs any part.
 * Notes on the parts that look odd:
 * - The age of process 1 (`#H` field 6), not /proc/uptime: all distributions of WSL share one kernel, so its uptime is
 *   not the start of the distribution.
 * - The first process of a container is also searched one cgroup below its own (docker-in-docker moves its processes).
 */
export const USAGE_SCRIPT = `{
# One utilization sample of Devspaces, protocol 2. The extension runs \`sh -s\` with this fixed text as its input and
# fills in only the marker (32 hexadecimal digits), the number of the sample, its kind (t: the counters; d: also the
# disks and, on WSL, the idle check), 0 or 1, and the data folder of Docker. The script only reads: it creates no file,
# starts no container and calls no Docker CLI.
exec 0</dev/null
mk=@MARK@ seq=@SEQ@ c=@KIND@ wi=@WI@ rd='@ROOT@'
nl='
'
up=; read -r up _ 2>/dev/null </proc/uptime
case $up in [0-9]*.[0-9][0-9]) ;; *) printf '@%s\\n#X noproc\\n' "$mk"; exit 0;; esac
C=/sys/fs/cgroup
if [ -f $C/cgroup.controllers ]; then v=2; U=$C
elif [ -f $C/unified/cgroup.controllers ]; then v=1; U=$C/unified
else v=1; U=
fi
boot=; read -r boot 2>/dev/null </proc/sys/kernel/random/boot_id
rel=; read -r rel 2>/dev/null </proc/sys/kernel/osrelease
uid=; while read -r k x _; do case $k in Uid:) uid=$x; break;; esac; done 2>/dev/null </proc/self/status
# The age of process 1 in 1/100 s (USER_HZ 100): on WSL, a distribution that started after the check of the extension.
ia=-; l=; read -r l 2>/dev/null </proc/1/stat
if [ -n "$l" ]; then
  l=\${l##*) }; set -f; set -- $l; set +f
  case \${20} in *[!0-9]*|'') ;; *) ia=$(( \${up%.*}\${up#*.} - \${20} ));; esac
fi
printf '@%s\\n#H 2 %s %s %s %s %s\\n' "$mk" "$v" "\${uid:--}" "\${boot:--}" "$ia" "\${rel:--}" || exit 0

ctr() { # $1 id, $2 path of the cgroup below $C (v2) or below $C/<controller> (v1)
  o="$o\${nl}C $1"; pid=
  if [ $v = 2 ]; then
    d=$C/$2
    while read -r k x; do case $k in usage_usec) o="$o\${nl}u $x"; break;; esac; done 2>/dev/null <"$d/cpu.stat"
    read -r x 2>/dev/null <"$d/memory.current" && o="$o\${nl}m $x"
    read -r x 2>/dev/null <"$d/memory.max" && o="$o\${nl}x $x"
    f=0; while read -r k x; do case $k in anon|file|inactive_file) o="$o\${nl}s $k $x"; f=$((f+1)); [ $f = 3 ] && break;; esac; done 2>/dev/null <"$d/memory.stat"
    while read -r k x; do case $k in oom_kill) o="$o\${nl}k $x"; break;; esac; done 2>/dev/null <"$d/memory.events"
    while read -r l; do o="$o\${nl}i $l"; done 2>/dev/null <"$d/io.stat"
    read -r x 2>/dev/null <"$d/pids.current" && o="$o\${nl}p $x"
  else
    if [ -n "$U" ] && [ -f "$U/$2/cpu.stat" ]; then
      while read -r k x; do case $k in usage_usec) o="$o\${nl}u $x"; break;; esac; done 2>/dev/null <"$U/$2/cpu.stat"
    else
      read -r x 2>/dev/null <"$C/cpuacct/$2/cpuacct.usage" && o="$o\${nl}U $x"
    fi
    d=$C/memory/$2
    read -r x 2>/dev/null <"$d/memory.usage_in_bytes" && o="$o\${nl}m $x"
    read -r x 2>/dev/null <"$d/memory.limit_in_bytes" && o="$o\${nl}x $x"
    f=0; while read -r k x; do case $k in total_rss|total_cache|total_inactive_file) o="$o\${nl}s $k $x"; f=$((f+1)); [ $f = 3 ] && break;; esac; done 2>/dev/null <"$d/memory.stat"
    while read -r k x; do case $k in oom_kill) o="$o\${nl}k $x"; break;; esac; done 2>/dev/null <"$d/memory.oom_control"
    while read -r dv op x; do case $op in Read|Write) o="$o\${nl}b $dv $op $x";; esac; done 2>/dev/null <"$C/blkio/$2/blkio.throttle.io_service_bytes_recursive"
    read -r x 2>/dev/null <"$C/pids/$2/pids.current" && o="$o\${nl}p $x"
  fi
  # The first process: in the cgroup, or one level below it (docker-in-docker moves its processes to a child cgroup).
  read -r pid 2>/dev/null <"$d/cgroup.procs"
  if [ -z "$pid" ]; then
    for q in "$d"/*/cgroup.procs; do read -r pid 2>/dev/null <"$q" && [ -n "$pid" ] && break; done
  fi
  [ -n "$pid" ] || { o="$o\${nl}n ?"; return 0; }
  if [ "/proc/$pid/net/dev" -ef /proc/self/net/dev ]; then o="$o\${nl}n host"; return 0; fi
  f=0 e=0
  while IFS=': ' read -r k rx x x x x x x x tx x; do
    f=1; case $k:$rx in lo:*|*:|*:*[!0-9]*) ;; *) o="$o\${nl}n $k $rx $tx"; e=1;; esac
  done 2>/dev/null </proc/$pid/net/dev
  [ $f = 1 ] || { o="$o\${nl}n ?"; return 0; }
  [ $e = 1 ] || o="$o\${nl}n none"
}

# WSL only: whether the idle script of a keeper of Devspaces runs (a process "idle" of this PID namespace, not a zombie).
idlecheck() {
  x=0
  for p in /proc/[0-9]*; do
    read -r l 2>/dev/null <"$p/comm" || continue
    [ "$l" = idle ] || continue
    read -r l 2>/dev/null <"$p/stat" || continue
    case \${l##*) } in Z*) continue;; esac
    [ "$p/ns/pid" -ef /proc/self/ns/pid ] || continue
    x=1; break
  done
  o="$o\${nl}I $x"
}

o="#T $seq $up"
while read -r l; do case $l in cpu*) o="$o\${nl}$l";; *) break;; esac; done 2>/dev/null </proc/stat
read -r l 2>/dev/null </proc/loadavg && o="$o\${nl}L $l"
while read -r k x u; do
  case $k in MemTotal:|MemFree:|MemAvailable:|Buffers:|Cached:|SwapTotal:) o="$o\${nl}M $k $x";; SwapFree:) o="$o\${nl}M $k $x"; break;; esac
done 2>/dev/null </proc/meminfo
while read -r k x; do case $k in oom_kill) o="$o\${nl}O $x"; break;; esac; done 2>/dev/null </proc/vmstat
for r in cpu memory io; do
  while read -r l; do o="$o\${nl}P $r $l"; done 2>/dev/null </proc/pressure/$r
done
if [ $c = d ]; then
  case $rd in /var/lib/docker|/var/lib/containerd|"$HOME/.local/share/docker") rd=;; esac
  l=$(stat -f -c 'D %i %S %b %f %a %c %d %n' /var/lib/docker /var/lib/containerd "$HOME/.local/share/docker" \${rd:+"$rd"} 2>/dev/null)
  [ -n "$l" ] && o="$o\${nl}$l"
  [ "$wi" = 1 ] && idlecheck
fi
if [ $v = 2 ]; then
  set -- $C/system.slice/docker-*.scope $C/docker/* $C/user.slice/user-*.slice/user@*.service/user.slice/docker-*.scope
else
  set -- $C/memory/system.slice/docker-*.scope $C/memory/docker/*
fi
for d do
  [ -d "$d" ] || continue
  id=\${d##*/}; id=\${id#docker-}; id=\${id%.scope}
  case $id in *[!0-9a-f]*) continue;; esac
  [ \${#id} = 64 ] || continue
  if [ $v = 2 ]; then ctr "$id" "\${d#"$C"/}"; else ctr "$id" "\${d#"$C"/memory/}"; fi
done
read -r up x 2>/dev/null </proc/uptime
printf '%s\\n#E %s %s\\n' "$o" "$seq" "$up"
exit 0
}
`;

/** The time limit of a Docker call of the samples on the host (seconds), where the host has `timeout`. */
export const USAGE_DOCKER_SECONDS = 5;

/**
 * A Docker call of the samples (`docker <args>`, a read) as a script for `sh -s` on the shared shell, like USAGE_SCRIPT:
 * one compound command, with its input closed. Where the host has a `timeout` of this form (coreutils, BusyBox from
 * 1.30), the call has a time limit of USAGE_DOCKER_SECONDS there, so that a Docker Engine that does not answer ends the
 * call (exit code 124) and not the shared shell, which a time limit of the extension stops. Throws for an argument with
 * a line break or a NUL.
 */
export function usageDockerScript(args: readonly string[]): string {
  if (args.some((arg) => /[\0\r\n]/.test(arg))) throw new Error('An argument of a Docker call of the utilization samples has a line break or a NUL.');
  const command = ['docker', ...args].map(shellWord).join(' ');
  return `{\nexec 0</dev/null\nif timeout 1 true 2>/dev/null; then exec timeout ${USAGE_DOCKER_SECONDS} ${command}; fi\nexec ${command}\n}\n`;
}

/** A new marker for USAGE_SCRIPT: 32 hexadecimal digits. */
export function newUsageMarker(): string {
  return randomBytes(16).toString('hex');
}

/** The values of one sample (usageScript). */
export interface UsageSampleValues {
  /** newUsageMarker. */
  marker: string;
  /** The number of the sample, from 1. */
  seq: number;
  kind: UsageSampleKind;
  /** The idle check of the WSL distribution of Devspaces (line `I`). */
  wslIdle?: boolean;
  /** The data folder of Docker (`docker info`) when it is not /var/lib/docker: its disk is read too. */
  dockerRoot?: string;
}

/** A data folder of Docker that the script may name: an absolute path without a quote, a line break or a NUL. */
export function isUsableDockerRoot(path: string): boolean {
  return /^\/[^\0\r\n']{0,1023}$/.test(path);
}

/**
 * USAGE_SCRIPT with its placeholders filled. Throws for a value that is not valid (a marker that is not 32 hexadecimal
 * digits, a number that is not a positive integer, a data folder that isUsableDockerRoot refuses), so that no other
 * text reaches the shell.
 */
export function usageScript(values: UsageSampleValues): string {
  const { marker, seq, kind, wslIdle = false, dockerRoot = '' } = values;
  if (!/^[0-9a-f]{32}$/.test(marker)) throw new Error('The marker of a utilization sample must be 32 hexadecimal digits.');
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('The number of a utilization sample must be a positive integer.');
  if (kind !== 't' && kind !== 'd') throw new Error('The kind of a utilization sample must be t or d.');
  if (dockerRoot !== '' && !isUsableDockerRoot(dockerRoot)) throw new Error('The data folder of Docker for a utilization sample must be an absolute path without a quote or a line break.');
  return USAGE_SCRIPT.replace('@MARK@', marker)
    .replace('@SEQ@', String(seq))
    .replace('@KIND@', kind)
    .replace('@WI@', wslIdle ? '1' : '0')
    .replace('@ROOT@', () => dockerRoot);
}
