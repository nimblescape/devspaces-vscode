// SPDX-License-Identifier: MIT
// © 2026 Hannes Stauss (scalarion@nimblescape.com)
// Licensed under the MIT License. See LICENSE in the repository root for details.

// The script of the utilization stream of a host (docs/architecture.md "The utilization stream"): one fixed POSIX sh
// script that the page of a host writes to `sh -s` on the host, through the transport of that host (Lima, WSL or SSH).
// It reads files of /proc and /sys/fs/cgroup and asks the Docker CLI of the host; it writes no file and starts no
// container, so nothing of it stays on the host. The extension paces it: each request byte gives one block of values
// (usageStream.ts reads them). It runs in dash (Debian), BusyBox ash (Alpine) and bash. No `vscode`.
import { randomBytes } from 'crypto';

/** The protocol of the script, the first field of its line `#H`. */
export const USAGE_PROTOCOL = 1;
/** The default time without a request byte after which the script ends (seconds; only with `timeout` on the host). */
export const USAGE_HEARTBEAT_SECONDS = 30;
/** The longest time of the Docker call of a block (\`docker ps\` or \`docker info\`; seconds). */
export const USAGE_DOCKER_SECONDS = 5;
/** The longest time of all calls of a sizes read together (seconds). */
export const USAGE_SIZES_SECONDS = 170;
/** The bounds of the time without a request byte (seconds): at least 3 times USAGE_KEEP_ALIVE_MS of usageSession.ts. */
export const MIN_USAGE_HEARTBEAT_SECONDS = 30;
export const MAX_USAGE_HEARTBEAT_SECONDS = 120;

/**
 * The script with the placeholders @MARK@ (the marker, 32 hexadecimal digits), @HB@ (USAGE_HEARTBEAT_SECONDS) and @WI@
 * (1: the idle check of WSL). The whole text is one compound command in braces, so the shell reads all of it before it
 * runs any part: the request bytes after it never reach the parser of the shell. Notes on the parts that look odd:
 * - `dd bs=1 count=1`, not `head -c 1`: BusyBox head reads every byte that waits in the pipe and keeps only the first.
 * - No trap: dash and BusyBox ash run a trapped TERM only after a blocked write returns, so a trap could keep a script
 *   whose reader is gone. The clock kills a blocked sampler instead.
 * - The age of process 1 (`#H` field 7), not /proc/uptime: all distributions of WSL share one kernel, so its uptime is
 *   not the start of the distribution.
 * - The first process of a container is also searched one cgroup below its own (docker-in-docker moves its processes).
 * - `tmz` runs only inside `$(…)` and replaces that subshell with `exec`: so the Docker CLI (or `timeout`, which passes
 *   the signal on) is a child of the sampler, and the clock reaches it.
 * - A block has at most one Docker call of USAGE_DOCKER_SECONDS, and a sizes read all its calls within
 *   USAGE_SIZES_SECONDS: both stay below the answer times of usageSession.ts.
 */
export const USAGE_SCRIPT = `{
# The utilization stream of Devspaces, protocol 1. The extension writes this fixed text to \`sh -s\` on the host and fills
# in only the marker (32 hexadecimal digits) and two numbers. The script reads only: it creates no file and starts no
# container. After the marker line, each byte on the input asks for one sample: t (the counters), d (also the disks and,
# on WSL, the idle check), s (also the sizes of \`docker system df\`); a space only says that the extension is still
# there. Without \`timeout\` and \`dd\` on the host, each request is a line. The script ends when its input ends, when no
# byte came for HB seconds (only with \`timeout\`), and when its output is closed.
mk=@MARK@ hb=@HB@ wi=@WI@
exec 3<&0 0</dev/null
if timeout 1 true 2>/dev/null && command -v dd >/dev/null 2>&1; then wd=1; else wd=0; fi
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
printf '@%s\\n#H 1 %s %s %s %s %s %s\\n' "$mk" "$v" "\${uid:--}" "$wd" "\${boot:--}" "$ia" "\${rel:--}" || exit 0

# The clock: passes each request byte to the sampler as a line (dd reads exactly one byte; BusyBox \`head -c 1\` reads
# more). It ends at the end of the input, after HB seconds without a byte, and when the sampler is gone (its next write
# fails). Then the sampler sees the end of its input; a sampler that is still there 2 seconds later (blocked in a write
# to a dead connection, or in a sizes read) is killed with its children. No trap: a trapped signal waits while dash or
# BusyBox blocks in a write. Only processes whose parent is this shell are hit, and only while the clock is its child.
clock() {
  if [ $wd = 1 ]; then
    while b=$(timeout $hb dd bs=1 count=1 <&3 2>/dev/null) && [ -n "$b" ]; do [ "$b" = ' ' ] || printf '%s\\n' "$b" || return 0; done
  else
    while read -r b <&3; do case \${b##* } in t|d|s) printf '%s\\n' "\${b##* }" || return 0;; esac; done
  fi
  exec 1>&- 3<&-
  read -r me _ _ pp _ 2>/dev/null </proc/self/stat
  for g in 1 2 3; do
    [ "$pp" = $$ ] || return 0
    sm=
    for p in /proc/[0-9]*; do
      l=; read -r l 2>/dev/null <"$p/stat"; l=\${l##*) }
      case $l in [!Z]\\ $$\\ *) [ "\${p#/proc/}" = "$me" ] || sm=\${p#/proc/};; esac
    done
    [ -n "$sm" ] || return 0
    [ $g = 3 ] || sleep 1
    pp=; read -r _ _ _ pp _ 2>/dev/null </proc/self/stat
  done
  for p in /proc/[0-9]*; do
    l=; read -r l 2>/dev/null <"$p/stat"; l=\${l##*) }
    case $l in ?\\ $sm\\ *) kill -TERM "\${p#/proc/}" 2>/dev/null;; esac
  done
  kill -KILL "$sm" 2>/dev/null
}

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

# Only inside $(…): exec replaces the subshell, so that the clock reaches the Docker CLI as a child of the sampler.
tmz() { t=$1; shift; if [ $wd = 1 ]; then exec timeout $t "$@"; else exec "$@"; fi; }

# One call of the sizes read ($1 the step, then the command), within the rest of its time (se): its output in x, or a
# line Z! with the exit code (124: no time left) and false.
zr() {
  zs=$1; shift
  read -r l _ 2>/dev/null </proc/uptime; l=$(( se - \${l%.*} ))
  [ $l -ge 1 ] || { o="$o\${nl}Z! $zs 124"; return 1; }
  x=$(tmz $l "$@" 2>/dev/null) && return 0
  o="$o\${nl}Z! $zs $?"; return 1
}

# The sizes: the reads of the view Docker Hosts (readHostInventory), one line each, or one line per item, all within
# ${USAGE_SIZES_SECONDS} seconds.
sizes() {
  read -r se _ 2>/dev/null </proc/uptime; se=$(( \${se%.*} + ${USAGE_SIZES_SECONDS} ))
  zr df docker system df --verbose --format '{{json .}}' || return 0
  case $x in *"$nl"*) o="$o\${nl}Z! df lines"; return 0;; esac
  o="$o\${nl}Z df $x"
  # The containerd image store lists dangling images only with --filter dangling=true (as listImagesByLabel).
  for q in dev:label=nimblescape.devspaces.id helper:label=nimblescape.devspaces.worker=true; do
    for g in '' dangling=true; do
      zr "\${q%%:*}" docker image ls --filter "\${q#*:}" \${g:+--filter "$g"} --no-trunc --format '{{.ID}}' || return 0
      set -f; y=$IFS; IFS=$nl; for l in $x; do o="$o\${nl}Z \${q%%:*} $l"; done; IFS=$y; set +f
    done
  done
  zr net docker network ls --no-trunc --format '{{json .}}' || return 0
  set -f; y=$IFS; IFS=$nl; for l in $x; do o="$o\${nl}Z net $l"; done; IFS=$y; set +f
  # One line per tag of an image: \`docker system df -v\` names only the first tag of an image (as IMAGE_TAGS_ARGS).
  zr tag docker image ls --no-trunc --format '{{json .}}' || return 0
  set -f; y=$IFS; IFS=$nl; for l in $x; do o="$o\${nl}Z tag $l"; done; IFS=$y; set +f
  o="$o\${nl}Z."
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

sampler() {
  seq=0 ids0= pend=0 nt=-99999 rq= rd=
  while read -r c; do
    case $c in t|d|s) ;; *) continue;; esac
    seq=$((seq+1))
    read -r up x 2>/dev/null </proc/uptime
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
    if [ $c != t ]; then
      l=$(stat -f -c 'D %i %S %b %f %a %c %d %n' /var/lib/docker /var/lib/containerd "$HOME/.local/share/docker" \${rd:+"$rd"} 2>/dev/null)
      [ -n "$l" ] && o="$o\${nl}$l"
      [ "$wi" = 1 ] && idlecheck
    fi
    if [ $v = 2 ]; then
      set -- $C/system.slice/docker-*.scope $C/docker/* $C/user.slice/user-*.slice/user@*.service/user.slice/docker-*.scope
    else
      set -- $C/memory/system.slice/docker-*.scope $C/memory/docker/*
    fi
    ids=
    for d do
      [ -d "$d" ] || continue
      id=\${d##*/}; id=\${id#docker-}; id=\${id%.scope}
      case $id in *[!0-9a-f]*) continue;; esac
      [ \${#id} = 64 ] || continue
      ids="$ids $id"
      if [ $v = 2 ]; then ctr "$id" "\${d#"$C"/}"; else ctr "$id" "\${d#"$C"/memory/}"; fi
    done
    # The names: one \`docker ps\` when the set of containers changed (again after a failure), at most every 10 s, and
    # only while one runs. After the first names, one \`docker info\` in a later block (again after a failure) finds a
    # data folder of Docker that is not /var/lib/docker for the lines D. One Docker call per block at most.
    [ "$ids" = "$ids0" ] || { pend=1; ids0=$ids; }
    if [ $pend = 1 ] && [ -n "$ids" ] && [ $(( \${up%.*} - nt )) -ge 10 ]; then
      nt=\${up%.*}
      if n=$(tmz ${USAGE_DOCKER_SECONDS} docker ps --no-trunc --format '{{.ID}} {{.Names}}' 2>/dev/null); then
        pend=0; [ -n "$rq" ] || rq=0
        set -f; x=$IFS; IFS=$nl; for l in $n; do o="$o\${nl}N $l"; done; IFS=$x; set +f
        o="$o\${nl}N."
      else
        o="$o\${nl}N! $?"
      fi
    elif [ "$rq" = 0 ] && [ $(( \${up%.*} - nt )) -ge 10 ]; then
      nt=\${up%.*}
      if x=$(tmz ${USAGE_DOCKER_SECONDS} docker info --format '{{.DockerRootDir}}' 2>/dev/null); then
        rq=1
        case $x in *"$nl"*|/var/lib/docker) ;; /*) rd=$x;; esac
      fi
    fi
    [ $c = s ] && sizes
    read -r up x 2>/dev/null </proc/uptime
    printf '%s\\n#E %s %s\\n' "$o" "$seq" "$up" || return 0
  done
}

clock | sampler 3<&-
exit 0
}
`;

/** A new marker for USAGE_SCRIPT: 32 hexadecimal digits. */
export function newUsageMarker(): string {
  return randomBytes(16).toString('hex');
}

/**
 * USAGE_SCRIPT with its placeholders filled: `marker` (newUsageMarker), `heartbeatSeconds` (an integer from
 * MIN_USAGE_HEARTBEAT_SECONDS to MAX_USAGE_HEARTBEAT_SECONDS) and `wslIdle` (the idle check of the WSL distribution of
 * Devspaces). Throws for any other value, so that no other text reaches the shell.
 */
export function usageScript(marker: string, heartbeatSeconds: number = USAGE_HEARTBEAT_SECONDS, wslIdle = false): string {
  if (!/^[0-9a-f]{32}$/.test(marker)) throw new Error('The marker of the utilization stream must be 32 hexadecimal digits.');
  if (!Number.isInteger(heartbeatSeconds) || heartbeatSeconds < MIN_USAGE_HEARTBEAT_SECONDS || heartbeatSeconds > MAX_USAGE_HEARTBEAT_SECONDS) {
    throw new Error(`The time without a request of the utilization stream must be an integer from ${MIN_USAGE_HEARTBEAT_SECONDS} to ${MAX_USAGE_HEARTBEAT_SECONDS} seconds.`);
  }
  return USAGE_SCRIPT.replace('@MARK@', marker)
    .replace('@HB@', String(heartbeatSeconds))
    .replace('@WI@', wslIdle ? '1' : '0');
}
