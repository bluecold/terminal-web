import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const testsDir = path.resolve(process.cwd(), 'src/utils/__tests__');
const files = fs.readdirSync(testsDir)
  .filter(f => f.endsWith('.test.ts'))
  .map(f => path.join('src/utils/__tests__', f).replace(/\\/g, '/'));

const backtesterFile = files.find(f => f.endsWith('backtester.test.ts'));
const nodeTestFiles = files.filter(f => !f.endsWith('backtester.test.ts'));

// Forward any additional CLI flags (e.g. --test-name-pattern)
const extraArgs = process.argv.slice(2);
const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';

console.log(`[Test Runner] Found ${files.length} test suites (${nodeTestFiles.length} node:test + 1 backtester harness)`);

// 1. Run backtester standalone harness
if (backtesterFile && (!extraArgs.length || extraArgs.some(a => a.includes('backtester')))) {
  console.log(`\n▶ Running ${backtesterFile}...`);
  const backtesterResult = spawnSync(npxCmd, ['tsx', backtesterFile], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (backtesterResult.error) {
    console.error('Failed to start backtester:', backtesterResult.error);
  }

  if (backtesterResult.status !== 0) {
    process.exit(backtesterResult.status ?? 1);
  }
}

// 2. Run all node:test suites dynamically
if (nodeTestFiles.length > 0) {
  const nodeTestArgs = [
    'tsx',
    '--tsconfig',
    'tsconfig.execution-tests.json',
    '--test',
    ...nodeTestFiles,
    ...extraArgs.filter(a => !a.includes('backtester')),
  ];

  console.log(`\n▶ Running ${nodeTestFiles.length} node:test suites...`);
  const nodeTestResult = spawnSync(npxCmd, nodeTestArgs, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (nodeTestResult.status !== 0) {
    process.exit(nodeTestResult.status ?? 1);
  }
}

console.log('\n✔ All test suites passed successfully.');
