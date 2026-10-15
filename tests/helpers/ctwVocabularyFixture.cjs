// Offline database + tiny PostgREST-compatible adapter. No env file or network.
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const { PGlite } = require(process.env.CTW_VOCAB_PGLITE_MODULE || '@electric-sql/pglite');
const U = '00000000-0000-4000-8000-000000000001';
const V = '00000000-0000-4000-8000-000000000002';
const T = '00000000-0000-4000-8000-000000000003';
const A = '00000000-0000-4000-8000-000000000004';
const X = '00000000-0000-4000-8000-000000000005';
const sourcePath = process.env.CTW_VOCAB_REVIEWED_INPUT || path.join(root, 'data/ctw-vocabulary/ctw-vocabulary-cefr-reviewed.json');
const { loadVocabularySource, buildVocabularyImportSql } = require('../../lib/ctw-vocabulary/import.ts');
function source() {
  if (!fs.existsSync(sourcePath)) throw Error('Missing versioned reviewed fixture in data/ctw-vocabulary. Restore it or set CTW_VOCAB_REVIEWED_INPUT; no old-file fallback.');
  return loadVocabularySource(fs.readFileSync(sourcePath), 'initial');
}
function currentSource() {
  const original=source(),review=JSON.parse(read('data/ctw-vocabulary/irregular-spelling-adjustments.json'));
  const {applyVocabularySpellingReview}=require('../../lib/ctw-vocabulary/spelling-review.ts');
  return {...original,rows:applyVocabularySpellingReview(original.rows,review.changes)};
}
async function fixture({ seed = true } = {}) {
  const db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to anon,authenticated,service_role;
    grant execute on function auth.uid() to anon,authenticated,service_role;
    create table public.profiles(id uuid primary key references auth.users(id),role text not null,is_active boolean not null,
      owner_id uuid references public.profiles(id));
    alter table profiles enable row level security;
    create policy self_profile on profiles for select to authenticated using(id=(select auth.uid()));
    grant select on profiles to authenticated;
    insert into auth.users values('${U}'),('${V}'),('${T}'),('${A}'),('${X}');
    insert into profiles(id,role,is_active) values('${U}','student',true),('${V}','student',true),('${T}','teacher',true),('${A}','admin',true),('${X}','student',false);
    create table lexical_entries(id integer primary key,content jsonb);
    create table reading_ctw_canonical(id integer primary key,content jsonb);
    create table student_wordbook_entries(id integer primary key,content jsonb);
    insert into lexical_entries values(1,'{"unchanged":"lexical"}');
    insert into reading_ctw_canonical values(1,'{"unchanged":"ctw"}');
    insert into student_wordbook_entries values(1,'{"unchanged":"wordbook"}');`);
  try {
    await db.exec(read('supabase/ctw_vocabulary_v1_preflight.sql'));
    await db.exec(read('supabase/ctw_vocabulary_v1_migration.sql'));
    if (seed) { const { rows, sha256 } = source(); await db.exec(buildVocabularyImportSql(rows, sha256, 'initial')); }
    return db;
  } catch (e) { await db.close(); throw e; }
}
const roles = new Set(['postgres','anon','authenticated','service_role']);
function client(db, role = 'postgres', user = U, calls = []) {
  if (!roles.has(role)) throw Error('Invalid offline role');
  async function run(sql, params, operation) {
    calls.push({ sql, params, operation, role });
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [user]);
    await db.exec(`set role ${role}`);
    try { return { data: (await db.query(sql, params)).rows, error: null }; }
    catch (e) { return { data: null, error: { message: e.message, code: e.code } }; }
    finally { await db.exec('reset role'); }
  }
  return {
    rpc: async (name, args = {}) => {
      const definitions = {read_ctw_vocabulary_catalog_v1: [], read_ctw_vocabulary_lists_v1: ['p_edition'],
        start_ctw_vocabulary_list_v1: ['p_edition','p_group','p_list'],
        create_ctw_vocabulary_review_v1: ['p_student','p_session','p_source','p_state','p_parent'],
        sync_ctw_vocabulary_review_v1: ['p_student','p_session','p_revision','p_command','p_state','p_attempt'],
        read_ctw_vocabulary_review_history_v1: ['p_page','p_size']};
      const keys = definitions[name];
      if (!keys) throw Error('Unexpected RPC');
      const r = await run(`select public.${name}(${keys.map((_,i)=>'$'+(i+1)).join(',')}) value`, keys.map(k=>['p_source','p_state','p_command','p_attempt'].includes(k) && args[k] !== null ? JSON.stringify(args[k]) : args[k]), 'rpc');
      return { ...r, data: r.data?.[0]?.value ?? null };
    },
    from: table => {
      if (!['ctw_vocabulary_entries','student_ctw_vocabulary_attempts','ctw_vocabulary_cefr_memberships','student_ctw_vocabulary_list_progress','student_ctw_vocabulary_review_sessions'].includes(table)) throw Error('Unexpected table');
      let fields = '*', filters = [], orders = [], range = null, inserted = null, single = false;
      const builder = {
        select: value => { fields = value; return builder; },
        eq: (name,value) => { filters.push({ name, values: [value] }); return builder; },
        in: (name,values) => { filters.push({ name, values }); return builder; },
        order: (name,opts) => { orders.push(`${name} ${opts?.ascending === false ? 'desc' : 'asc'}`); return builder; },
        range: (start,end) => { range = [start,end]; return builder; },
        limit: count => { range = [0,count-1]; return builder; },
        insert: row => { inserted = row; return builder; },
        single: () => { single = true; return builder; },
        maybeSingle: () => { single = true; return builder; },
        then: (resolve,reject) => {
          const params = [], param = value => { params.push(value); return `$${params.length}`; };
          let sql;
          if (inserted) {
            const names = Object.keys(inserted);
            sql = `insert into public.${table}(${names.join(',')}) values(${names.map(name =>
              param(['answers','request_answers'].includes(name) ? JSON.stringify(inserted[name]) : inserted[name])).join(',')}) returning ${fields}`;
          } else {
            sql = `select ${fields} from public.${table}`;
            if (filters.length) sql += ' where ' + filters.map(f => `${f.name} in (${f.values.map(param).join(',')})`).join(' and ');
            if (orders.length) sql += ` order by ${orders.join(',')}`;
            if (range) sql += ` limit ${range[1] - range[0] + 1} offset ${range[0]}`;
          }
          return run(sql, params, inserted ? 'insert' : 'select').then(r => ({ ...r, data: single ? r.data?.[0] ?? null : r.data })).then(resolve,reject);
        }
      };
      return builder;
    }
  };
}
module.exports = { fixture, client, source, currentSource, read, sourcePath, U, V, T, A, X };
