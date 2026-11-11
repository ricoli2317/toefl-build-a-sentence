const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {notificationEntryView,firstUnreadNotification,nextUnreadNotification}=require('../lib/notificationPresentation.ts');
const {NotificationCache}=require('../lib/notificationCache.ts');
const items=[3,2,1].map(id=>({id:String(id),title:`Notice ${id}`,type:'announcement',published_at:`2026-11-0${id}T00:00:00Z`,read_at:null}));

test('automatic and bell entries have different explicit initial views',()=>{
 assert.equal(notificationEntryView('automatic'),'detail');assert.equal(notificationEntryView('manual'),'list');
});
test('automatic entry chooses latest eligible unread, never an already confirmed item',()=>{
 const rows=structuredClone(items);rows[0].read_at='confirmed';assert.equal(firstUnreadNotification(rows).id,'2');
 rows.forEach(row=>{row.read_at='confirmed';});assert.equal(firstUnreadNotification(rows),null);assert.equal(firstUnreadNotification([]),null);
});
test('next unread excludes current and read notices, without marking skipped notices',()=>{
 const rows=structuredClone(items),before=JSON.stringify(rows);
 assert.equal(nextUnreadNotification(rows,'3').id,'2');assert.equal(nextUnreadNotification(rows,'1').id,'3');
 assert.equal(JSON.stringify(rows),before);rows[1].read_at='confirmed';assert.equal(nextUnreadNotification(rows,'3').id,'1');
 rows[2].read_at='confirmed';assert.equal(nextUnreadNotification(rows,'3'),null);
});
test('late unread cache response cannot select a locally confirmed notice for automatic detail',()=>{
 const cache=new NotificationCache(async()=>0);cache.confirm('3','confirmed',true);
 assert.equal(firstUnreadNotification(cache.overlay(items)).id,'2');assert.equal(items[0].read_at,null);
});
test('recipient/Admin reuse one responsive dialog; existing non-notification dialog limits stay unchanged',()=>{
 const shell=fs.readFileSync('components/shared/ConfirmDialog.tsx','utf8'),modal=fs.readFileSync('components/notifications/NotificationModal.tsx','utf8');
 assert.match(shell,/w-\[80vw\]/);assert.match(shell,/max-h-\[90dvh\]/);assert.match(shell,/max-w-none/);
 assert.match(shell,/max-w-\[560px\]/);assert.match(shell,/max-w-\[420px\]/);
 assert.match(modal,/min-h-0[\s\S]*overflow-y-auto/);assert.match(modal,/data-notification-scroll/);
 for(const file of ['components/notifications/NotificationCenter.tsx','components/admin/NotificationsAdmin.tsx'])assert.match(fs.readFileSync(file,'utf8'),/<NotificationModal/);
});
test('preview reuses authenticated blob and modal stack owns Escape, preserving expiry and parent dialog',()=>{
 const body=fs.readFileSync('components/notifications/NotificationBody.tsx','utf8'),shell=fs.readFileSync('components/shared/ConfirmDialog.tsx','utf8');
 assert.match(body,/label="通知图片预览"/);assert.match(body,/aria-label="放大通知图片"/);assert.match(body,/图片已过期/);
 assert.match(body,/setPreview\(false\); if \(objectUrl\) URL\.revokeObjectURL/);assert.match(shell,/modalStack\[modalStack\.length - 1\] === layer\.current/);
 assert.doesNotMatch(body,/object-cover/);
});
