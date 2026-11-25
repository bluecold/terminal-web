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

// This runner already executes under tsx, so its Node flags (process.execArgv) load the tsx loader.
// Child suites reuse them with the same Node binary: no npx and no shell (spawning npx.cmd on Windows
// needs `shell: true`, which Node deprecates as DEP0190 because arguments are not escaped).
if (!process.execArgv.some(arg => arg.includes('tsx'))) {
  console.error('Run this script with tsx: npx tsx scripts/run-all-tests.ts');
  process.exit(1);
}
const tsxNodeArgs = process.execArgv;

console.log(`[Test Runner] Found ${files.length} test suites (${nodeTestFiles.length} node:test + 1 backtester harness)`);

// 1. Run backtester standalone harness
if (backtesterFile && (!extraArgs.length || extraArgs.some(a => a.includes('backtester')))) {
  console.log(`\n▶ Running ${backtesterFile}...`);
  const backtesterResult = spawnSync(process.execPath, [...tsxNodeArgs, backtesterFile], {
    stdio: 'inherit',
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
    ...tsxNodeArgs,
    '--test',
    ...extraArgs.filter(a => !a.includes('backtester')),
    ...nodeTestFiles,
  ];

  console.log(`\n▶ Running ${nodeTestFiles.length} node:test suites...`);
  const nodeTestResult = spawnSync(process.execPath, nodeTestArgs, {
    stdio: 'inherit',
    // Same effect as `tsx --tsconfig tsconfig.execution-tests.json`
    env: { ...process.env, TSX_TSCONFIG_PATH: 'tsconfig.execution-tests.json' },
  });

  if (nodeTestResult.error) {
    console.error('Failed to start node:test suites:', nodeTestResult.error);
  }

  if (nodeTestResult.status !== 0) {
    process.exit(nodeTestResult.status ?? 1);
  }
}

console.log('\n✔ All test suites passed successfully.');
