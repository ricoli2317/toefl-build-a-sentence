/* Static ONLY: no database client, environment, SQL execution or network.
 * Checks lexical completeness and security/atomicity contracts. This is NOT
 * a PostgreSQL execution/locking/RLS acceptance test; humans still run the SQL.
 */
const fs = require('node:fs');
const assert = require('node:assert/strict');
function statements(sql) {
  const result=[];let current='',i=0,depth=0;
  while(i<sql.length){
    if(sql.startsWith('--',i)){while(i<sql.length&&sql[i]!=='\n')i++;continue;}
    if(sql.startsWith('/*',i)){const end=sql.indexOf('*/',i+2);assert.ok(end>=0,'closed comment');i=end+2;continue;}
    const dollar=/^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
    if(dollar){const end=sql.indexOf(dollar[0],i+dollar[0].length);assert.ok(end>=0,'closed function body');current+=sql.slice(i,end+dollar[0].length);i=end+dollar[0].length;continue;}
    if(sql[i]==="'"){
      current+=sql[i++];let closed=false;
      while(i<sql.length){const c=sql[i++];current+=c;if(c==="'"){if(sql[i]==="'"){current+=sql[i++];continue;}closed=true;break;}}
      assert.ok(closed,'closed string literal');continue;
    }
    const c=sql[i++];if(c==='(')depth++;if(c===')')depth--;assert.ok(depth>=0,'parenthesis balance');
    if(c===';'&&depth===0){if(current.trim())result.push(current.trim());current='';}else current+=c;
  }
  assert.equal(depth,0);assert.equal(current.trim(),'','terminated final statement');return result;
}
const sql=fs.readFileSync('supabase/writing_correction_revisions/10_writing_correction_revisions.sql','utf8');
const migration=statements(sql);
assert.equal(migration[0],'BEGIN');assert.equal(migration.at(-1),'COMMIT');
const functions=migration.filter(s=>s.startsWith('CREATE FUNCTION'));
assert.equal(functions.length,7);assert.ok(functions.every(s=>s.includes('SET search_path=pg_catalog')));
assert.equal(migration.filter(s=>s.startsWith('CREATE TABLE')).length,1);
assert.equal(migration.filter(s=>/^CREATE (CONSTRAINT )?TRIGGER/.test(s)).length,4);
assert.doesNotMatch(sql,/\b(?:DISABLE TRIGGER|DROP TRIGGER|CREATE OR REPLACE|TRUNCATE|ALTER TABLE public\.writing_attempts)\b/i);
assert.match(sql,/writing_attempts_correction_closed_gate.*tgenabled='O'/s);
assert.match(sql,/ENABLE ROW LEVEL SECURITY/);assert.doesNotMatch(sql,/CREATE POLICY/i);
assert.match(sql,/REVOKE ALL ON public\.writing_correction_revision_states FROM PUBLIC,anon,authenticated,service_role/);
assert.match(sql,/GRANT SELECT ON public\.writing_correction_revision_states TO service_role/);
assert.doesNotMatch(sql,/GRANT (?:INSERT|UPDATE|DELETE|ALL)/i);
const save=functions.find(s=>s.startsWith('CREATE FUNCTION public.save_writing_correction_revision('));
assert.match(save,/FOR SHARE[\s\S]*FOR UPDATE[\s\S]*a\.draft_version <> p_expected_version/);
assert.match(save,/result := public\.save_writing_correction\([\s\S]*INSERT INTO public\.writing_correction_revision_states/);
assert.doesNotMatch(save,/EXCEPTION WHEN|SET draft_version/i);
assert.match(sql,/DEFERRABLE INITIALLY DEFERRED/);
console.log(JSON.stringify({staticOnly:true,migrationStatements:migration.length,functions:functions.length,triggers:4,passed:true}));
