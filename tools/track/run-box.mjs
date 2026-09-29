#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const host = process.env.COZYFIT_HOST || "ubuntu-baremetal";
const sshBase = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3"];
const port = process.env.CCLAY_EXTRACT_SSH_PORT;
const sshFlags = port ? [...sshBase, "-p", port] : sshBase;
const scpFlags = port ? [...sshBase, "-P", port] : sshBase;

export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export const idleCheck = `python3 - <<'PY'
from pathlib import Path
import subprocess
busy = []
for p in Path('/proc').iterdir():
    if not p.name.isdigit(): continue
    try:
        argv = (p/'cmdline').read_bytes().split(b'\\0')
        executable = Path(argv[0].decode(errors='replace')).name
        cmd = b' '.join(argv).decode(errors='replace')
    except (FileNotFoundError, ProcessLookupError, PermissionError): continue
    if 'python' in executable and ('cclay_gvhmr' in cmd or 'cclay_bench' in cmd): busy.append(cmd)
usage = subprocess.check_output(['nvidia-smi','--query-compute-apps=used_memory','--format=csv,noheader,nounits'], text=True)
used = sum(int(v.strip()) for v in usage.splitlines() if v.strip())
if busy or used > 1600:
    raise SystemExit('gpu-busy: ' + repr(busy) + '; compute memory=' + str(used) + ' MiB')
print('GPU idle for GVHMR; compute memory=' + str(used) + ' MiB')
PY`;

export function gpuBusyDecision({ processes = [], usedMiB = 0 } = {}) {
  return processes.some(command => /(?:^|\s)python(?:\d(?:\.\d+)?)?(?:\s|$)/.test(command) && (command.includes("cclay_gvhmr") || command.includes("cclay_bench"))) || usedMiB > 1600;
}

export function buildRemoteCommand(remote, entry, args = []) {
  if (entry !== "pytest" && !/^[A-Za-z0-9_.-]+\.py$/.test(entry)) throw new Error(`invalid Python entry: ${entry}`);
  const executable = entry === "pytest" ? "$HOME/cclay-ingest/cozyfit/.venv/bin/pytest" : "$HOME/cclay-ingest/cozyfit/.venv/bin/python";
  const target = entry === "pytest" ? "" : ` ${quote(join(remote, entry))}`;
  return `set -e\n${idleCheck}\ncd ${quote(remote)}\nexec ${executable}${target}${args.length ? ` ${args.map(quote).join(" ")}` : ""}`;
}

function exec(program, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "", pending = "";
    const onData = chunk => {
      const text = String(chunk);
      process.stdout.write(text);
      output += text;
      pending += text;
      const lines = pending.split(/\\r?\\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line) onLine?.(line);
    };
    child.stdout.on("data", onData); child.stderr.on("data", onData);
    child.once("error", reject);
    child.once("close", code => {
      if (pending) onLine?.(pending);
      code === 0 ? resolve(output) : reject(new Error(`${program} exited ${code}: ${output.slice(-4000)}`));
    });
  });
}

function pyFiles(root) {
  return readdirSync(root).filter(name => name.endsWith(".py") && statSync(join(root, name)).isFile()).sort();
}

function transfer(item, kind) {
  if (typeof item === "string") {
    const separator = item.indexOf(":");
    if (separator < 1 || separator === item.length - 1) throw new Error(`${kind} must be ${kind === "upload" ? "localPath:remoteRelPath" : "remoteRelPath:localPath"}`);
    return kind === "upload"
      ? { localPath: item.slice(0, separator), remoteRelPath: item.slice(separator + 1) }
      : { remoteRelPath: item.slice(0, separator), localPath: item.slice(separator + 1) };
  }
  const localPath = item?.localPath ?? item?.path;
  const remoteRelPath = item?.remoteRelPath ?? item?.remotePath;
  if (typeof localPath !== "string" || typeof remoteRelPath !== "string") throw new Error(`${kind} requires localPath and remoteRelPath`);
  return { localPath, remoteRelPath };
}

function safeRemoteRelPath(path) {
  if (!path || path.startsWith("/") || path.split("/").includes("..")) throw new Error(`unsafe remote relative path: ${path}`);
  return path;
}

export function normalizeTransfers(items = [], kind) {
  return items.map(item => {
    const value = transfer(item, kind);
    return { ...value, remoteRelPath: safeRemoteRelPath(value.remoteRelPath) };
  });
}

export async function runBox({ entry, args = [], hostName = host, onLine, upload = [], fetch = [] } = {}) {
  if (!entry) throw new Error("usage: run-box.mjs <entry.py> [args...]");
  if (entry !== "pytest" && !/^[A-Za-z0-9_.-]+\.py$/.test(entry)) throw new Error(`invalid Python entry: ${entry}`);
  const uploads = normalizeTransfers(upload, "upload");
  const fetches = normalizeTransfers(fetch, "fetch");
  const remote = `/tmp/cozyfit-${Date.now()}-${randomBytes(5).toString("hex")}`;
  const ssh = (command, options = {}) => exec("ssh", [...sshFlags, hostName, command], options);
  const scp = (source, destination, options = {}) => exec("scp", [...scpFlags, source, destination], options);
  const stream = { onLine };
  let failure, output;
  try {
    await ssh(`umask 077 && mkdir -p ${quote(remote)}`, stream);
    for (const name of pyFiles(join(here, "py"))) await scp(join(here, "py", name), `${hostName}:${join(remote, name)}`);
    for (const item of uploads) {
      await ssh(`mkdir -p ${quote(join(remote, item.remoteRelPath, ".."))}`, stream);
      await scp(item.localPath, `${hostName}:${join(remote, item.remoteRelPath)}`);
    }
    output = await ssh(buildRemoteCommand(remote, entry, args), stream);
    for (const item of fetches) {
      mkdirSync(join(item.localPath, ".."), { recursive: true });
      await scp(`${hostName}:${join(remote, item.remoteRelPath)}`, item.localPath);
    }
    return fetches.length ? { output, fetched: fetches.map(item => item.localPath) } : output;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try { await ssh(`rm -rf ${quote(remote)}`); }
    catch (cleanupError) { if (failure) throw new AggregateError([failure, cleanupError], `box cleanup failed: ${remote}`); throw cleanupError; }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2), entry = argv.shift();
  const args = [], upload = [], fetch = [];
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--fetch" || flag === "--upload") {
      const value = argv[++i];
      if (!value) throw new Error(`${flag} requires a value`);
      (flag === "--fetch" ? fetch : upload).push(value);
    } else args.push(flag);
  }
  runBox({ entry, args, upload, fetch }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
