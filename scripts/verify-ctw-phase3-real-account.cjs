// EXPLICITLY OPT-IN: creates real study progress and four real test results.
// No route mocks, SQL writes, service keys, score injection or local state edits.
// Authenticates only through the normal localhost UI. Use after Next says Ready.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.CTW_BROWSER_PLAYWRIGHT || 'playwright');

const origin = process.env.CTW_BROWSER_ORIGIN;
const account = process.env.CTW_REAL_ACCOUNT_ACCEPTANCE;
if (!origin || new URL(origin).hostname !== 'localhost' || account !== 'jiangzhuocheng2') {
  throw new Error('Explicit real-account acceptance required: localhost origin and CTW_REAL_ACCOUNT_ACCEPTANCE=jiangzhuocheng2.');
}
const ROOT = '/student/ctw-vocabulary';
const API = '/api/student/ctw-vocabulary';
const output = path.resolve(process.env.CTW_REAL_ACCEPTANCE_OUTPUT || 'outputs/ctw-vocabulary-phase3/real-account-acceptance');
const credentials = Object.fromEntries(fs.readFileSync('.codex/tps-test-accounts.local', 'utf8')
  .split(/\r?\n/).filter(line => line.includes('=')).map(line => {
    const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
  }));
assert.equal(credentials.STUDENT_EMAIL, account, 'Use only the explicitly authorized test account.');
const report = {
  startedAt: new Date().toISOString(), origin, account,
  integration: 'real localhost Next API -> production Supabase; normal login and UI inputs only; no route mocks',
  checks: [], rounds: [], snapshots: {}, httpErrors: [], pageErrors: []
};
const saveReport = () => fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(report, null, 2));
function pass(name) { report.checks.push({ name, passed: true }); saveReport(); console.log('PASS', name); }
function sameLists(actual, expected) {
  assert.deepEqual(actual, expected, 'Other edition changed unexpectedly.');
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  // A second invocation must not silently manufacture more real test records.
  if (fs.existsSync(path.join(output, 'acceptance.json'))) {
    throw new Error('A real-account acceptance artifact already exists. Inspect it before explicitly selecting a new output directory.');
  }
  saveReport();
  const browser = await chromium.launch({ headless: true });
  let page;
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    page = await context.newPage(); page.setDefaultTimeout(30000);
    page.on('pageerror', error => { report.pageErrors.push(error.message); });
    page.on('response', response => {
      const url = new URL(response.url());
      if (url.origin === origin && url.pathname.startsWith(API) && response.status() >= 400) {
        report.httpErrors.push({ path: url.pathname + url.search, status: response.status() });
      }
    });
    const screenshot = async name => {
      await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
    };
    async function catalog(edition, shot) {
      const responsePromise = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.origin === origin && url.pathname === `${API}/lists` && url.searchParams.get('edition') === edition;
      });
      await page.goto(origin + ROOT + (edition === 'cefr' ? '?tab=cefr' : ''));
      const response = await responsePromise;
      assert.equal(response.status(), 200, `Real ${edition} directory failed.`);
      const data = await response.json();
      const buttons = page.getByRole('tabpanel').getByRole('button');
      await buttons.nth(data.lists.length - 1).waitFor();
      assert.equal(await buttons.count(), data.lists.length);
      const rendered = await buttons.allTextContents();
      for (let i = 0; i < data.lists.length; i++) {
        const list = data.lists[i];
        const status = list.status === 'completed' ? '已完成' : list.status === 'in_progress' ? '进行中' : '未开始';
        assert.ok(rendered[i].includes(status), 'Rendered status Badge disagrees with the real directory response.');
        const best = list.bestAccuracy === null ? '—' : `${Number(list.bestAccuracy.toFixed(2))}%`;
        assert.ok(rendered[i].replace(/\s/g, '').includes(`历史最高正确率：${best}`), 'Rendered highest accuracy disagrees with the saved value.');
      }
      if (shot) await screenshot(shot);
      return data.lists;
    }
    const find = (lists, target) => {
      const item = lists.find(list => list.edition === target.edition && list.group === target.group && list.listNumber === target.listNumber);
      assert.ok(item, 'Expected List is missing.'); return item;
    };
    const local = () => page.evaluate(() => {
      const id = location.pathname.split('/').at(-1);
      const key = Object.keys(localStorage).find(name => name.startsWith('tps:ctw-vocabulary:v1:') && name.endsWith(':' + id));
      return key ? JSON.parse(localStorage.getItem(key)) : null;
    });
    async function begin(target, label) {
      const lists = await catalog(target.edition);
      const index = lists.findIndex(list => list.group === target.group && list.listNumber === target.listNumber);
      assert.ok(index >= 0);
      await page.getByRole('tabpanel').getByRole('button').nth(index).click();
      const dialog = page.getByRole('dialog'); await dialog.waitFor();
      if (target.edition === 'cefr') assert.ok((await dialog.innerText()).includes(target.group === 'C1-C2' ? 'C1–C2' : target.group));
      const started = page.waitForResponse(response => new URL(response.url()).pathname === `${API}/lists/start` && response.request().method() === 'POST');
      await page.getByRole('button', { name: '确认', exact: true }).click();
      const response = await started; assert.equal(response.status(), 200, 'Real List start failed.');
      const data = await response.json();
      await page.waitForURL('**/session/**');
      await page.getByRole('button', { name: '跳过复习', exact: true }).waitFor();
      const state = await local();
      assert.equal(state.entries.length, target.count);
      assert.deepEqual(state.entries, data.items);
      report.owner = state.owner;
      report.rounds.push({ label, attemptId: state.attemptId, source: state.source, count: state.entries.length, state: 'started' });
      saveReport();
      return state;
    }
    async function studyAll(state, shot) {
      for (let i = 0; i < state.entries.length; i++) {
        await page.getByRole('heading', { name: state.entries[i].word, exact: true }).waitFor();
        if (i === 0) await screenshot(shot);
        await page.getByRole('button', { name: i === state.entries.length - 1 ? '开始测试' : '下一个', exact: true }).click();
      }
      assert.deepEqual((await local()).entries.map(entry => entry.entry_id), state.entries.map(entry => entry.entry_id));
    }
    async function finish(state, wrongFirst, shot) {
      // Only native field inputs and existing confirm/next/save buttons are used.
      // Expected spellings are the real List study payload, not injected scores.
      for (let i = 0; i < state.entries.length; i++) {
        const entry = state.entries[i];
        const base = page.getByRole('group', { name: '原形拼写', exact: true }).getByRole('textbox');
        await base.waitFor();
        await base.fill(wrongFirst && i === 0 ? 'x' : entry.word);
        const fields = page.getByRole('textbox', { name: '英文拼写', exact: true });
        assert.equal(await fields.count(), entry.irregular_forms.length + 1);
        for (let n = 0; n < entry.irregular_forms.length; n++) await fields.nth(n + 1).fill(entry.irregular_forms[n].answers.at(-1));
        await page.getByRole('button', { name: '确定', exact: true }).click();
        await page.getByRole('status').filter({ hasText: wrongFirst && i === 0 ? '请查看各项' : '全部拼写正确' }).waitFor();
        if (i === state.entries.length - 1) {
          const saved = page.waitForResponse(response => new URL(response.url()).pathname === `${API}/attempts` && response.request().method() === 'POST');
          await page.getByRole('button', { name: '保存并查看结果', exact: true }).click();
          const response = await saved;
          assert.equal(response.status(), 200, 'Real whole-round save failed.');
          const result = await response.json();
          assert.equal(result.attempt_id, state.attemptId);
          assert.equal(result.answer_count, state.entries.length);
          assert.equal(result.correct_count, state.entries.length - (wrongFirst ? 1 : 0));
          assert.deepEqual(result.answers[0].source, state.source);
          const item = report.rounds.find(round => round.attemptId === state.attemptId);
          Object.assign(item, { state: 'saved', correct: result.correct_count, submittedAt: result.submitted_at,
            accuracy: 100 * result.correct_count / result.answer_count });
          saveReport();
          await page.waitForURL(`**/results/${state.attemptId}`);
          await page.locator('[data-vocabulary-persistence="saved"]').waitFor();
          await page.getByText(`${Math.round(100 * result.correct_count / result.answer_count)}%`, { exact: true }).waitFor();
          await screenshot(shot);
          // Refresh forces a fresh real GET: the result is not a local completion illusion.
          const reload = page.waitForResponse(response => new URL(response.url()).pathname === `${API}/attempts/${state.attemptId}`);
          await page.reload(); assert.equal((await reload).status(), 200);
          await page.locator('[data-vocabulary-persistence="saved"]').waitFor();
        } else await page.getByRole('button', { name: '下一个', exact: true }).click();
      }
    }
    async function repeat(target, label, shot) {
      const state = await begin(target, label);
      await page.getByRole('button', { name: '跳过复习', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: '确定', exact: true }).click();
      await finish(state, true, shot);
    }

    await page.goto(origin + '/login');
    await page.locator('#account').fill(credentials.STUDENT_EMAIL);
    await page.locator('#password').fill(credentials.STUDENT_PASSWORD);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/student/**', { timeout: 60000 });
    pass('Normal localhost login for the explicitly authorized test account');
    const mixedBefore = await catalog('mixed', '01-mixed-baseline');
    const cefrBefore = await catalog('cefr', '02-cefr-baseline');
    assert.equal(mixedBefore.length, 21); assert.equal(cefrBefore.length, 23);
    report.snapshots.baseline = { mixed: mixedBefore, cefr: cefrBefore }; saveReport();
    // Minimize real test data: one not-yet-started List per edition, shortest first.
    const choose = lists => lists.filter(list => list.status === 'not_started' && list.bestAccuracy === null)
      .sort((a, b) => a.count - b.count || a.listNumber - b.listNumber)[0];
    const mixed = choose(mixedBefore), cefr = choose(cefrBefore);
    assert.ok(mixed && cefr, 'First-entry acceptance needs untouched Lists; never reset real progress to fake a baseline.');
    report.targets = { mixed, cefr }; saveReport();

    const mixedRound = await begin(mixed, 'mixed-perfect');
    const mixedSessionUrl = page.url();
    await page.getByRole('link', { name: '暂停', exact: true }).click();
    let currentMixed = await catalog('mixed', '03-mixed-in-progress');
    assert.equal(find(currentMixed, mixed).status, 'in_progress');
    assert.equal(find(currentMixed, mixed).bestAccuracy, null);
    sameLists(await catalog('cefr'), cefrBefore);
    pass('Mixed first entry persists in_progress immediately, before any test; CEFR stays untouched');
    await page.goto(mixedSessionUrl); await page.getByRole('button', { name: '跳过复习', exact: true }).waitFor();
    await studyAll(mixedRound, '04-mixed-study');
    await finish(mixedRound, false, '05-mixed-perfect-result');
    currentMixed = await catalog('mixed', '06-mixed-completed');
    assert.equal(find(currentMixed, mixed).status, 'completed'); assert.equal(find(currentMixed, mixed).bestAccuracy, 100);
    sameLists(await catalog('cefr'), cefrBefore);
    pass('Mixed full List 100% is really saved and completed; CEFR statuses and highest scores unchanged');
    await repeat(mixed, 'mixed-lower-repeat', '07-mixed-lower-result');
    currentMixed = await catalog('mixed', '08-mixed-best-retained');
    assert.equal(find(currentMixed, mixed).status, 'completed'); assert.equal(find(currentMixed, mixed).bestAccuracy, 100);
    sameLists(await catalog('cefr'), cefrBefore);
    pass('Mixed lower-score repeat keeps completed and best 100%, without changing CEFR');
    report.snapshots.afterMixed = { mixed: currentMixed, cefr: cefrBefore }; saveReport();

    const cefrRound = await begin(cefr, 'cefr-perfect');
    const cefrSessionUrl = page.url();
    await page.getByRole('link', { name: '暂停', exact: true }).click();
    let currentCefr = await catalog('cefr', '09-cefr-in-progress');
    assert.equal(find(currentCefr, cefr).status, 'in_progress'); assert.equal(find(currentCefr, cefr).bestAccuracy, null);
    sameLists(await catalog('mixed'), currentMixed);
    pass('CEFR first entry persists in_progress with no score; mixed state stays unchanged');
    await page.goto(cefrSessionUrl); await page.getByRole('button', { name: '跳过复习', exact: true }).waitFor();
    await studyAll(cefrRound, '10-cefr-study');
    await finish(cefrRound, false, '11-cefr-perfect-result');
    currentCefr = await catalog('cefr', '12-cefr-completed');
    assert.equal(find(currentCefr, cefr).status, 'completed'); assert.equal(find(currentCefr, cefr).bestAccuracy, 100);
    sameLists(await catalog('mixed'), currentMixed);
    pass('CEFR full List 100% is really saved and completed; mixed records remain independent');
    await repeat(cefr, 'cefr-lower-repeat', '13-cefr-lower-result');
    currentCefr = await catalog('cefr', '14-cefr-best-retained');
    assert.equal(find(currentCefr, cefr).status, 'completed'); assert.equal(find(currentCefr, cefr).bestAccuracy, 100);
    sameLists(await catalog('mixed'), currentMixed);
    pass('CEFR lower-score repeat keeps best 100% and completed; mixed states and scores unchanged');
    report.snapshots.final = { mixed: currentMixed, cefr: currentCefr }; saveReport();

    const historyResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${API}/attempts` && response.request().method() === 'GET');
    await page.goto(origin + ROOT + '/history');
    const history = await historyResponse; assert.equal(history.status(), 200);
    const historyData = await history.json();
    for (const round of report.rounds) assert.ok(historyData.items.some(item => item.attempt_id === round.attemptId));
    await page.getByRole('link').filter({ hasText: '查看结果' }).first().waitFor();
    await screenshot('15-real-history');
    assert.equal(report.rounds.length, 4); assert.ok(report.rounds.every(round => round.state === 'saved'));
    assert.deepEqual(report.httpErrors, []); assert.deepEqual(report.pageErrors, []);
    pass('All four real saved attempts are visible in account history; no CTW HTTP/page errors');
    report.completedAt = new Date().toISOString(); report.outcome = 'passed'; saveReport();
  } catch (error) {
    report.outcome = 'failed'; report.error = error.message; saveReport();
    if (page) await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
