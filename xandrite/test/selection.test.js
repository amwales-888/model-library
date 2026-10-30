'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Selection } = require('../renderer/selection');
const { itemMenuTemplate, folderMenuTemplate } = require('../src/menus');

const picked = (s) => { const out = []; for (const { start, end } of s.blocks()) for (let i = start; i <= end; i++) out.push(i); return out; };

test('select one, toggle, and clicking the only selected item', () => {
  const s = new Selection();
  s.only(3);
  assert.deepEqual(picked(s), [3]);
  s.toggle(5);
  s.toggle(4);
  assert.deepEqual(s.blocks(), [{ start: 3, end: 5 }]);   // neighbours merge into one block
  s.toggle(4);
  assert.deepEqual(picked(s), [3, 5]);
  assert.equal(s.count, 2);
  assert.equal(s.has(4), false);
  s.only(9);
  assert.deepEqual(picked(s), [9]);
});

test('shift-click selects from the anchor to the clicked item, in either direction', () => {
  const s = new Selection();
  s.only(10);
  s.extendTo(14);
  assert.deepEqual(picked(s), [10, 11, 12, 13, 14]);
  s.extendTo(7);                                           // the anchor is still 10
  assert.deepEqual(picked(s), [7, 8, 9, 10]);
  s.extendTo(12, true);                                    // ctrl+shift keeps what was selected
  assert.deepEqual(picked(s), [7, 8, 9, 10, 11, 12]);
  const fresh = new Selection();
  fresh.extendTo(4);                                       // no anchor yet: acts as a plain click
  assert.deepEqual(picked(fresh), [4]);
});

test('select all, clear, and a list that becomes shorter', () => {
  const s = new Selection();
  s.all(50000);
  assert.equal(s.count, 50000);
  assert.equal(s.ranges.length, 1);                        // one range, however many items
  assert.equal(s.has(49999), true);
  s.clampTo(100);
  assert.equal(s.count, 100);
  s.toggle(40);
  assert.deepEqual(s.blocks(), [{ start: 0, end: 39 }, { start: 41, end: 99 }]);
  s.clear();
  assert.equal(s.count, 0);
  s.all(0);
  assert.equal(s.count, 0);
});

test('the item menu changes its wording for several models, and disables what cannot apply', () => {
  const acted = [];
  const act = (action, extra) => () => acted.push([action, extra]);
  const one = itemMenuTemplate({ count: 1, canRevert: false }, act);
  const labels = (t) => t.filter((i) => i.label).map((i) => i.label);
  assert.deepEqual(labels(one), ['Open in viewer', 'Show in folder', 'Download…', 'Copy path', 'Copy SHA-256', 'Rate', 'Find other copies of this model', 'Regenerate thumbnail', 'Revert to automatic view']);
  assert.equal(one.find((i) => i.label === 'Revert to automatic view').enabled, false);
  assert.equal(one.find((i) => i.label === 'Open in viewer').enabled, true);
  assert.equal(one.find((i) => i.label === 'Show in folder').enabled, true);
  const many = itemMenuTemplate({ count: 1200, canRevert: true }, act);
  assert.equal(many.find((i) => i.label === 'Open in viewer').enabled, false);                       // several files: no viewer
  assert.ok(labels(many).includes('Download 1,200 files…'));
  assert.ok(labels(many).includes('Copy 1,200 paths'));
  assert.equal(itemMenuTemplate({ count: 3, canReveal: false }, act).find((i) => i.label === 'Show in folder').enabled, false);   // different folders
  assert.equal(itemMenuTemplate({ count: 3, canReveal: true }, act).find((i) => i.label === 'Show in folder').enabled, true);
  assert.ok(labels(many).includes('Rate 1,200 models'));
  assert.ok(labels(many).includes('Regenerate 1,200 thumbnails'));
  assert.equal(many.find((i) => i.label === 'Revert to automatic view').enabled, true);
  const rate = many.find((i) => i.submenu).submenu;
  assert.deepEqual(rate.map((i) => i.label), ['Unrated', '0 stars', '★ 1 star', '★★ 2 stars', '★★★ 3 stars', '★★★★ 4 stars', '★★★★★ 5 stars']);
  rate[0].click(); rate[6].click();
  assert.deepEqual(acted, [['rate', { stars: null }], ['rate', { stars: 5 }]]);
});

test('the folder menu offers rescan and remove only for top folders, and not while a scan is running', () => {
  const act = () => () => {};
  const top = folderMenuTemplate({ isRoot: true, busy: false }, act);
  assert.deepEqual(top.filter((i) => i.label).map((i) => i.label), ['Rescan this folder', 'Show in folder', 'Copy path', 'Remove from library…']);
  const busy = folderMenuTemplate({ isRoot: true, busy: true }, act);
  assert.equal(busy.find((i) => i.label === 'Rescan this folder').enabled, false);
  assert.equal(busy.find((i) => i.label === 'Remove from library…').enabled, false);
  const sub = folderMenuTemplate({ isRoot: false, busy: false }, act);
  assert.deepEqual(sub.filter((i) => i.label).map((i) => i.label), ['Show in folder', 'Copy path']);
});
