import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileAnnotation } from '../run.mjs';

test('maps project-relative migration lines into the checkout and encodes runner delimiters', t => {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), 'rattlecheck-annotation-')));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const project = path.join(workspace, 'app');
  const dir = path.join(project, 'supabase', 'migrations');
  mkdirSync(dir, { recursive: true });
  const file = 'supabase/migrations/a%,b:c.sql';
  writeFileSync(path.join(project, file), '');
  const finding = { file, line: 8, rule: 'RC006', severity: 'high', title: 'Data: 40%\r\ncomplete' };
  assert.equal(fileAnnotation(workspace, project, finding),
    '::error file=app/supabase/migrations/a%25%2Cb%3Ac.sql,line=8,title=RattleCheck RC006::Data: 40%25%0D%0Acomplete');

  const other = path.join(workspace, 'outside-project.sql');
  writeFileSync(other, '');
  symlinkSync(other, path.join(dir, 'link.sql'));
  for (const invalid of [other, '../outside-project.sql', 'supabase/migrations/link.sql', 'missing.sql']) {
    assert.equal(fileAnnotation(workspace, project, { ...finding, file: invalid }), undefined);
  }
  assert.equal(fileAnnotation(workspace, project, { ...finding, line: 0 }), undefined);
  assert.equal(fileAnnotation(workspace, project, { ...finding, severity: 'warning' }), undefined);
});
