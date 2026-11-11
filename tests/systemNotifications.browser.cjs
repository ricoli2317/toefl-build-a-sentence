// Opt-in local browser regression. Auth uses ONLY the normal localhost UI.
// Every notification/image request is intercepted: no production notification,
// read-confirmation, upload, delete, or practice writes are allowed.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const origin = process.env.TPS_NOTIFICATION_BROWSER_ORIGIN;
if (!origin || new URL(origin).hostname !== 'localhost' || !process.env.TPS_PLAYWRIGHT_RUNTIME || !process.env.TPS_TEST_ACCOUNTS_FILE) {
  throw Error('Explicit Ready localhost, existing Playwright runtime and private account file are required');
}
const { chromium } = require(process.env.TPS_PLAYWRIGHT_RUNTIME);
const legacy = process.env.TPS_NOTIFICATION_EXPECT_LEGACY === '1';
const accountFile = () => Object.fromEntries(fs.readFileSync(process.env.TPS_TEST_ACCOUNTS_FILE, 'utf8').split(/\r?\n/)
  .filter(line => line.includes('=') && !line.trim().startsWith('#')).map(line => { const i = line.indexOf('='); return [line.slice(0, i).trim(), line.slice(i + 1).trim()]; }));
const notices = [1, 2].map(n => ({ id: `20000000-0000-4000-8000-00000000000${n}`, title: `通知测试 ${n}`, content: `完整正文 ${n}`,
  type: 'announcement', target_role: 'all', published_at: '2026-11-01T00:00:00Z', read_at: null, content_document: null }));
if(!legacy)notices[0].content_document={type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'完整正文 1',marks:[{type:'bold'}]}]},
  {type:'image',attrs:{imageId:'40000000-0000-4000-8000-000000000001'}},{type:'paragraph',content:[{type:'text',text:'图片之后正文继续显示'}]}]};
const report = { scope: 'localhost real React; synthetic notification APIs only', legacy, checks: [], requests: [] };
let browser;
(async () => {
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  let delayList = false;
  await context.route(origin + '/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (!url.pathname.includes('/notifications')) {
      // Normal login/account reads are real. Never exercise unrelated writes.
      if (req.method() !== 'GET' && !url.pathname.startsWith('/api/supabase/auth/')) return route.abort();
      return route.continue();
    }
    report.requests.push({ path: url.pathname + url.search, method: req.method() });
    let data;
    if(url.pathname.includes('/images/'))return route.fulfill({status:410,contentType:'application/json',body:JSON.stringify({message:'图片已过期'})});
    if (url.pathname.endsWith('/read')) {
      const item = notices.find(row => url.pathname.includes(row.id));
      item.read_at = '2026-11-11T12:00:00Z';
      data = { id: item.id, read_at: item.read_at };
    } else if (url.searchParams.get('view') === 'summary') data = { unreadCount: notices.filter(row => !row.read_at).length };
    else if (/\/notifications\/[0-9a-f-]+$/.test(url.pathname)) data = { notification: notices.find(row => url.pathname.endsWith(row.id)) };
    else {
      if (delayList) await new Promise(resolve => setTimeout(resolve, 250));
      data = { notifications: notices.filter(row => url.searchParams.get('unread') !== 'true' || !row.read_at), nextCursor: null };
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.addInitScript(() => {
    window.__notificationProbe = { documentId: Math.random(), events: [], articleRemovals: 0 };
    for (const name of ['focus', 'blur', 'visibilitychange', 'pageshow', 'beforeunload']) {
      (name === 'visibilitychange' ? document : window).addEventListener(name, () => window.__notificationProbe.events.push(name));
    }
    new MutationObserver(records => {
      for (const record of records) for (const node of record.removedNodes) {
        if (node.nodeType === 1 && (node.matches?.('article[aria-label="通知详情"]') || node.querySelector?.('article[aria-label="通知详情"]'))) window.__notificationProbe.articleRemovals++;
      }
    }).observe(document, { childList: true, subtree: true });
  });
  const accounts = accountFile();
  await page.goto(origin + '/login');
  await page.locator('#account').fill(accounts.STUDENT_EMAIL);
  await page.locator('#password').fill(accounts.STUDENT_PASSWORD);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(origin + '/student/sets', { timeout: 60000 });
  const dialog = page.getByRole('dialog', { name: '通知中心', exact: true });
  await dialog.waitFor({ timeout: 60000 });
  if (!legacy) {
    assert.equal(await dialog.locator('article').count(), 0);
    assert.equal(await dialog.getByText('完整正文 1', { exact: true }).count(), 0);
    assert.equal(await dialog.getByText('逐条打开查看并确认；关闭仅确认当前展示的通知，不会将其他通知标为已读。').count(), 0);
    await dialog.getByRole('button', { name: /通知测试 1/ }).click();
    await dialog.getByRole('article', { name: '通知详情' }).waitFor();
    report.checks.push('automatic popup starts with title-only list, then explicit detail');
  }
  await dialog.getByText('完整正文 1', { exact: true }).waitFor();
  if(!legacy){await dialog.getByText('图片已过期',{exact:true}).waitFor();await dialog.getByText('图片之后正文继续显示',{exact:true}).waitFor();assert.equal(await dialog.locator('img').count(),0);report.checks.push('expired image shows placeholder without broken img; rich text before/after remains readable');}
  await page.evaluate(() => { window.__notificationHeader = document.querySelector('header'); window.__notificationProbe.articleRemovals = 0; });
  const documentId = await page.evaluate(() => window.__notificationProbe.documentId);
  const before = report.requests.length;
  const navigation = [];
  page.on('request', req => { if (req.isNavigationRequest() && req.frame() === page.mainFrame()) navigation.push(req.resourceType()); });
  delayList = true;
  await page.evaluate(() => { window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
  await page.waitForTimeout(900);
  if(!legacy){const other=await context.newPage();await other.goto('about:blank');await other.bringToFront();await page.bringToFront();await other.close();await page.waitForTimeout(150);}
  const probe = await page.evaluate(() => ({ ...window.__notificationProbe, sameHeader: window.__notificationHeader === document.querySelector('header') }));
  report.focusEvidence = { extraRequests: report.requests.slice(before), navigation, probe, sameDocument: documentId === probe.documentId };
  assert.equal(report.focusEvidence.sameDocument, true);
  assert.equal(probe.sameHeader, true);
  assert.equal(navigation.length, 0);
  if (legacy) {
    assert.ok(report.requests.length > before);
    assert.ok(probe.articleRemovals > 0);
    report.checks.push('baseline reproduced: focus -> inbox GET -> detail removed while loading; document/header survive');
  } else {
    assert.equal(report.requests.length, before);
    assert.equal(probe.articleRemovals, 0);
    report.checks.push('focus/visibility do not reload document, request APIs or remove mounted detail');
    await dialog.getByRole('button', { name: '返回通知列表', exact: true }).click();
    assert.equal(await dialog.locator('article').count(), 0);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(report.requests.filter(row => row.method === 'POST').length, 0, 'closing does not mark any item read');
    await page.getByRole('button', { name: /通知中心/ }).click();
    await dialog.getByRole('button', { name: /通知测试 1/ }).click();
    await dialog.getByRole('button', { name: '确认已读', exact: true }).click();
    assert.equal(report.requests.filter(row => row.method === 'POST').length, 1);
    assert.equal(notices[1].read_at, null);
    await dialog.getByRole('button', { name: '返回通知列表', exact: true }).click();
    await dialog.getByRole('button', { name: /通知测试 1/ }).click();
    await dialog.getByText('完整正文 1', { exact: true }).waitFor();
    assert.equal(await dialog.getByText('已确认阅读，可随时重复查看。').count(), 0);
    report.checks.push('close never acknowledges; explicit confirmation affects only one; read detail can be reopened');
    await dialog.getByRole('button', { name: '返回通知列表', exact: true }).click();
    const manualResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/notifications'&&!new URL(response.url()).searchParams.has('view'));
    await dialog.getByRole('button',{name:'刷新',exact:true}).click();await manualResponse;
    assert.equal(report.requests.filter(row=>row.method==='POST').length,1);
    report.checks.push('explicit manual list refresh still sends a targeted GET without extra acknowledgements');
  }
  console.log(JSON.stringify(report, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
