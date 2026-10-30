'use strict';
// The right-click menus, as plain data that main.js hands to Electron. `act(action, extra)` returns the function to
// run when an item is chosen. Kept separate from Electron so the labels and rules can be tested.

const plural = (n, one, many) => (n === 1 ? one : many);

/**
 * info: { count, canRevert, canReveal } where count is how many thumbnails the menu applies to.
 * Open in viewer needs exactly one; Show in folder needs them all to be in one folder (the page works that out).
 */
function itemMenuTemplate(info, act) {
  const n = Math.max(1, Math.floor(info.count) || 1);
  const stars = [{ label: 'Unrated', click: act('rate', { stars: null }) }];
  for (let k = 1; k <= 5; k++) stars.push({ label: '★'.repeat(k) + ' ' + k + ' ' + plural(k, 'star', 'stars'), click: act('rate', { stars: k }) });
  return [
    { label: 'Open in viewer', enabled: n === 1, click: act('open') },
    { label: 'Show in folder', enabled: info.canReveal !== false, click: act('reveal') },
    { label: n > 1 ? 'Download ' + n.toLocaleString('en') + ' files…' : 'Download…', click: act('download') },
    { type: 'separator' },
    { label: n > 1 ? 'Copy ' + n.toLocaleString('en') + ' paths' : 'Copy path', click: act('copyPaths') },
    { label: n > 1 ? 'Copy ' + n.toLocaleString('en') + ' SHA-256 hashes' : 'Copy SHA-256', click: act('copyHashes') },
    { type: 'separator' },
    { label: n > 1 ? 'Rate ' + n.toLocaleString('en') + ' models' : 'Rate', submenu: stars },
    { type: 'separator' },
    { label: 'Find other copies of this model', click: act('copies') },
    { label: n > 1 ? 'Regenerate ' + n.toLocaleString('en') + ' thumbnails' : 'Regenerate thumbnail', click: act('regenerate') },
    { label: 'Revert to automatic view', enabled: !!info.canRevert, click: act('revert') },
  ];
}

/** info: { isRoot, busy } for a folder in the tree. */
function folderMenuTemplate(info, act) {
  const items = [];
  if (info.isRoot) items.push({ label: 'Rescan this folder', enabled: !info.busy, click: act('rescanFolder') });
  items.push({ label: 'Show in folder', click: act('revealFolder') });
  items.push({ label: 'Copy path', click: act('copyFolderPath') });
  if (info.isRoot) {
    items.push({ type: 'separator' });
    items.push({ label: 'Remove from library…', enabled: !info.busy, click: act('removeFolder') });
  }
  return items;
}

module.exports = { itemMenuTemplate, folderMenuTemplate };
