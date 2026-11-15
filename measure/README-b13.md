# B13: the old-Node measurement attempt

Status: **attempted 2026-11-12 (UTC); cannot run on this host; nothing measured.** The record, with every command
and its real output, is `measure/results/2026-11-12-b13-attempt.txt`.

## What was tried

The three knowledge-base entries `node-headers-trap-10x`, `node-headers-trap-12x` and `node-headers-trap-13x` say
that on Node 10.15.2 and later 10.x, 12.x before 12.19.0 and 13.x before 13.13.0 the idle close of an explicit
`keepAliveTimeout` K is the smaller of K and `headersTimeout` (40 s on 10.x, 60 s on 12.x and 13.x). That comes from the
changelogs and the issue thread, not from a measurement. B13 asked whether the B3 scripts can run against those
releases on this machine (macOS on Apple silicon, arm64):

1. Can an x64 program run here? `arch -x86_64 /usr/bin/true` failed with `Bad CPU type in executable`;
   `/usr/bin/pgrep oahd` found no Rosetta daemon; `sysctl -n sysctl.proc_translated` printed `0`;
   `/Library/Apple/usr/share/rosetta` does not exist. Rosetta 2 is not installed.
2. Which builds exist? nodejs.org `dist/index.json` and the `/dist/v10.15.3/`, `/dist/v12.18.4/` and
   `/dist/v13.12.0/` folders list `osx-x64` and `darwin-x64` builds and `linux-arm64` builds for these releases. No
   release up to Node 15 has an `osx-arm64` build; the oldest release with one is v16.0.0.

## Why it cannot run here

The only macOS build of these releases is x64, and this host cannot run x64 programs. The `linux-arm64` builds need a
Linux kernel, and this host has none (no container or virtual machine was set up: that would be a new system
component, and bolt rules forbid scratch hosts). No tarball was downloaded: a binary that cannot run proves nothing
that the failed `arch` command does not already show.

## What would make it run

Either of these, both the maintainer's decision:

- Rosetta 2 installed by the maintainer on this host (`softwareupdate --install-rosetta --agree-to-license`; this bolt did
  not run it), then the B3 scripts run against Node 10.15.x, 12.18.x and 13.12.x from checksum-verified official
  tarballs in `.cache/`;
- an x64 macOS or Linux host (or an arm64 Linux host, using the `linux-arm64` builds), with the same scripts.

## What did not change

The three entries keep basis `from-changelogs`, which prints as `from changelogs, not measured`. Their value, subject
and range are unchanged, and none of them supports a "measured" claim. Only the text of `deferredTo.reason` is more
exact: it names this attempt and the record file. `deferredTo.bolt` stays `B13`, because no later bolt in the plan
measures these entries; the open path is the maintainer's go on Rosetta 2 or an x64 host. The lanes still print
`DEFERRED (B13)` for them, count them apart, and never as a pass.
