#!/usr/bin/env node

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const minimumNode = [20, 18, 1];

function compareVersions(actual, expected) {
  const a = actual.split('.').map(Number);
  for (let index = 0; index < expected.length; index += 1) {
    if ((a[index] || 0) !== expected[index]) return (a[index] || 0) > expected[index];
  }
  return true;
}

function findExecutable(name) {
  if (existsSync(name)) return name;
  const bundledPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', `${name}.mjs`);
  if (existsSync(bundledPath)) return bundledPath;
  const localName = process.platform === 'win32' ? `${name}.cmd` : name;
  const localPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '.bin', localName);
  if (existsSync(localPath)) return localPath;
  try {
    const command = process.platform === 'win32' ? 'where.exe' : 'which';
    return execFileSync(command, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\r?\n/)[0] || null;
  } catch {
    return null;
  }
}

function checkPackage(name) {
  try {
    return require.resolve(name);
  } catch {
    return null;
  }
}

const nodeVersion = process.versions.node;
const nodeReady = compareVersions(nodeVersion, minimumNode);
const justBashPath = checkPackage('just-bash');
const runtimePath = findExecutable('agent-tools');
const requestedCommand = process.env.AGENT_TOOLS_COMMAND || null;
const cliAllowlist = new Set((process.env.AGENT_CLI_ALLOWLIST || '').split(',').map((value) => value.trim()).filter(Boolean));
const requestedCliPath = requestedCommand ? findExecutable(requestedCommand) : null;
const requestedCliAllowlisted = requestedCommand ? cliAllowlist.has(requestedCommand) : null;

const missing = [];
if (!nodeReady) missing.push(`Node.js >= ${minimumNode.join('.')}`);
if (!justBashPath) missing.push('paquete just-bash');
if (!runtimePath) missing.push('runtime agent-tools');
if (requestedCommand && !requestedCliPath) missing.push(`CLI ${requestedCommand} (no disponible en PATH)`);
if (requestedCommand && cliAllowlist.size > 0 && !requestedCliAllowlisted) missing.push(`CLI ${requestedCommand} (no incluida en AGENT_CLI_ALLOWLIST)`);

const status = missing.length === 0 ? 'READY' : (nodeReady ? 'IMPLEMENTABLE' : 'BLOCKED');
const report = {
  status,
  checks: {
    node: { available: true, version: nodeVersion, minimum: minimumNode.join('.'), passed: nodeReady },
    justBash: { available: Boolean(justBashPath), resolvedPath: justBashPath },
    runtime: { available: Boolean(runtimePath), resolvedPath: runtimePath },
    requestedCommand: requestedCommand ? {
      name: requestedCommand,
      available: Boolean(requestedCliPath),
      resolvedPath: requestedCliPath,
      allowlisted: requestedCliAllowlisted,
      executed: false,
    } : null,
  },
  missing,
};

if (status !== 'READY') {
  report.implementationContext = {
    install: 'npm install just-bash',
    runtimeContract: 'Implementar agent-tools runtime status|command list|load|exec fuera del sandbox.',
    registration: 'Registrar comandos mediante Bash.registerCommand() o defineCommand().',
    security: 'Mantener tokens y llamadas MCP/API en el host; aplicar allowlists, confirmación y límites.',
    nextStep: 'Pedir autorización antes de instalar dependencias, crear el runtime o cargar un plugin.',
  };
}

console.log(JSON.stringify(report, null, 2));
process.exitCode = status === 'BLOCKED' ? 2 : (status === 'IMPLEMENTABLE' ? 1 : 0);
