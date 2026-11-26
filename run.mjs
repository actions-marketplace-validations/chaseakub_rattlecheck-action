import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function within(root, target) {
  const rel = path.relative(root, target);
  return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

// Indented code blocks keep checkout-controlled text inert in the job summary.
function plain(value) {
  return String(value).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').slice(0, 450);
}

// The runner decodes these workflow-command escapes after parsing properties.
function commandData(text) {
  return String(text).replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
}

function commandProperty(text) {
  return commandData(text).replaceAll(':', '%3A').replaceAll(',', '%2C');
}

export function fileAnnotation(workspace, project, finding) {
  const { file, line, severity, rule, title } = finding;
  if (!['critical', 'high'].includes(severity) || !Number.isSafeInteger(line) || line < 1) return;
  if (typeof file !== 'string' || !file.endsWith('.sql') || path.isAbsolute(file)) return;

  let target;
  try {
    // The CLI returns finding.file relative to the project, e.g.
    // supabase/migrations/001_directory.sql. The runner expects checkout-relative paths.
    target = realpathSync(path.resolve(project, file));
    if (!within(project, target) || !within(workspace, target) || !statSync(target).isFile()) return;
  } catch {
    return;
  }
  const relative = path.relative(workspace, target).split(path.sep).join('/');
  return '::error file=' + commandProperty(relative) + ',line=' + line +
    ',title=' + commandProperty('RattleCheck ' + rule) + '::' + commandData(title);
}

function summary(title, details) {
  const lines = details.map(line => '    ' + plain(line));
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['## RattleCheck', '', title, '', ...lines, '', ''].join('\n'));
  console.log(title);
}

function scan(workspace, project, temp) {
  // Run npm outside the checkout, without its .npmrc, lifecycle scripts, local
  // binaries or caller tokens. Invoke the installed CLI with this Node runtime.
  const systemPath = process.env.PATH.split(path.delimiter)
    .filter(dir => path.isAbsolute(dir) && !within(workspace, dir))
    .join(path.delimiter);
  const options = { cwd: temp, env: { PATH: systemPath }, encoding: 'utf8' };
  const install = spawnSync('npm', [
    'install', '--prefix', temp, '--registry=https://registry.npmjs.org/',
    '--userconfig', path.join(temp, 'user.npmrc'), '--globalconfig', path.join(temp, 'global.npmrc'),
    '--cache', path.join(temp, 'cache'), '--ignore-scripts', '--no-package-lock',
    '--no-audit', '--no-fund', '--no-save', 'rattlecheck@latest',
  ], options);
  if (install.status !== 0) {
    summary('Could not install the latest RattleCheck release from npm.', [install.error?.message ?? install.stderr]);
    return 2;
  }

  const reportFile = path.join(temp, 'report.json');
  const cli = path.join(temp, 'node_modules', 'rattlecheck', 'bin', 'rattlecheck.js');
  const run = spawnSync(process.execPath, [cli, project, '--json', '--out', reportFile], options);
  if (![0, 1, 3].includes(run.status)) {
    summary('RattleCheck could not complete the scan.', [run.error?.message ?? run.stderr]);
    return run.status ?? 2;
  }

  const report = JSON.parse(readFileSync(reportFile, 'utf8'));
  if (report.schema !== 'rattlecheck.report/v1') throw new Error('Unsupported RattleCheck report format.');
  const checked = report.doors.checked;
  const { critical, high } = report.counts;
  const version = report.tool.version;
  if (!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(version) ||
      ![checked, critical, high].every(n => Number.isSafeInteger(n) && n >= 0)) {
    throw new Error('Unexpected release version or counts in the RattleCheck report.');
  }
  console.log('RattleCheck ' + version + ', ' + checked + ' checked objects, ' + high + ' high, ' + critical + ' critical.');
  const lines = [
    'CLI version: ' + report.tool.version,
    'Grade: ' + report.grade.letter,
    'Objects checked: ' + checked + ' | Tables: ' + report.coverage.tables + ' | Functions: ' + report.coverage.functions,
    'Critical: ' + report.counts.critical + ' | High: ' + report.counts.high + ' | Warnings: ' + report.counts.warning,
  ];
  const shown = report.findings.slice(0, 50);
  let annotations = 0;
  for (const finding of shown) {
    const location = finding.file ? finding.file + (finding.line ? ':' + finding.line : '') : '(no file)';
    lines.push(finding.severity + ' ' + finding.rule + '  ' + finding.name + '  ' + location);
    lines.push('  ' + finding.plain);
    if (annotations < 10) {
      const annotation = fileAnnotation(workspace, project, finding);
      if (annotation) {
        console.log(annotation);
        annotations++;
      }
    }
  }
  if (shown.length < report.findings.length) {
    lines.push('Showing 50 of ' + report.findings.length + ' findings. Run npx rattlecheck@latest locally for the full report.');
  }

  if (checked === 0 || run.status === 3) {
    summary('Incomplete coverage. Check the working directory and migration files.', lines);
    return 3;
  }
  summary(run.status === 1 ? 'High or critical findings require review.' : 'No high or critical findings.', lines);
  return run.status;
}

function main() {
  const workspace = realpathSync(process.env.GITHUB_WORKSPACE);
  const subdir = process.env['INPUT_WORKING-DIRECTORY'] || '.';
  if (path.isAbsolute(subdir)) throw new Error('working-directory must be relative to the checkout.');
  const project = realpathSync(path.resolve(workspace, subdir));
  if (!within(workspace, project)) throw new Error('working-directory resolves outside the checkout.');

  const temp = mkdtempSync(path.join(process.env.RUNNER_TEMP || tmpdir(), 'rattlecheck-'));
  try {
    return scan(workspace, project, temp);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || '')) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error('RattleCheck could not run. See the job summary for details.');
    if (process.env.GITHUB_STEP_SUMMARY) summary('RattleCheck configuration or runner error.', [error.message]);
    process.exitCode = 2;
  }
}
