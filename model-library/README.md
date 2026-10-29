# Model Library

A desktop app for organising a large collection of `.stl` and `.3mf` files. Every file is identified by its
SHA-256, so it can be found again after it is moved or renamed.

**New here? Read the [Getting started guide](docs/getting-started.md)** (with screenshots).

This is the first stage:

1. An Electron window that opens the viewer and the library.
2. Choose folders and list every `.stl` and `.3mf` file inside them, including subfolders.
3. Streaming SHA-256 hashing and a SQLite index, with a shortcut so a rescan only reads files that changed.

## Run it in WSL (Ubuntu)

Electron opens a normal window through WSLg, the built-in Linux GUI support in WSL2.

**One-time setup**

1. In Windows PowerShell, check WSLg is present: `wsl --version` should print a "WSLg version" line.
   If it does not, run `wsl --update`.
2. Install Node.js 22.13 or newer in Ubuntu. [nvm](https://github.com/nvm-sh/nvm) is the easiest way:
   `nvm install --lts`. (Electron brings its own Node. This one is for `npm install` and the tests.)
3. Electron needs a few system libraries. On a fresh Ubuntu this usually covers it:

   ```
   sudo apt update
   sudo apt install -y libnss3 libgbm1 libgtk-3-0t64 libasound2t64 libxss1 libxtst6 \
                       libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 xdg-utils
   ```

   Package names vary a little between Ubuntu releases (older ones have no `t64` suffix). If `npm start`
   complains about a missing `lib...so` file, install whichever package apt suggests for it.

**Run**

Keep the project in the Linux home folder (for example `~/model-library`), not under `/mnt/c`, so `npm` is fast.

```
npm install      # downloads Electron, about 100 MB
npm test         # unit tests for the scanner, hashing and index
npm start        # opens the app
```

If the window fails to open with a sandbox or GPU error, use `npm run start:safe`.

**Where your files should be.** Folders inside Linux (`~/...`) are read quickly. Windows drives (`/mnt/c/...`)
work but are noticeably slower to scan, because every read crosses from Linux to Windows.

## Using it

- The left side is the **folder tree** (counts include subfolders); the right side is a **thumbnail grid**. Choose
  "All files" or any folder. *Include subfolders* switches between everything below a folder and its own files only;
  *Show missing* includes files that have disappeared; the **Size** slider changes the thumbnail size. The grid only
  creates the cells that are on screen, so it stays fast with tens of thousands of files.
- **Ratings.** In the viewer, the File panel has a **Rating** dropdown: Unrated, 0, 1, 2, 3, 4 or 5 stars (0 stars is a
  rating, not the same as unrated). It is saved in the database against the file's hash, so it follows the file around, and
  the stars show on the thumbnail in the library straight away.
- **Filters** (the bar above the grid) narrow the list by **Size** (under 100 KB up to over 50 MB), **Age** (last 24 hours up
  to older than a year, counted from the date modified or the date added) and **Rating** (unrated, rated, 0 stars, or N stars
  and up). They combine with each other, with the folder you selected and with the search box. "Clear filters" resets them.
- **Order by** sorts the grid by *Name* (the file's own name), *Folder and name*, *Date modified* (when the file last
  changed on disk), *Date added* (when the library first saw that content), *File size* or *Rating* (unrated files count as lower than 0 stars). The button beside it reverses
  the order. Date orderings show the date on each thumbnail. Your choice is remembered.
- **Click a thumbnail** to open that file in the viewer window (the same window is reused for the next click).
- In the viewer, orbit, zoom or pan, then press **Update**: the library's thumbnail for that file is replaced with the
  current view (512 px, view settings embedded) and the library window refreshes it straight away. **Advanced** holds
  the size choice, the PNG download and **Revert to automatic view**.
- **Your views are remembered.** Pressing Update also stores the view (camera, zoom, Z-up) in the database, keyed by the
  file's hash. If that thumbnail is ever drawn again (the renderer is improved, or the image is deleted) it is drawn with
  your view, not the automatic one. Opening the file in the viewer starts from your saved view. The grid marks these
  files "custom view".
- **Preferences ▾ → Manage folders…** lists every folder the library searches, with its file count and last scan.
  Each can be removed. Add several folders in a row with **Add folder…**; the scan starts when the dialog is closed, and
  only if a new folder was added. Removing only takes the folder out of the library; your files are never touched, and
  by default their thumbnails and saved views are kept, so adding the folder back restores them. Tick the option in the
  confirmation to delete those thumbnails, views and ratings too (files that also exist in another folder keep theirs).
- **Add folder…** opens a folder picker and scans the folder straight away.
- The **Rescan** button at the bottom right of the grid rescans every folder in the library, to pick up files and folders
  added, moved or removed while the app was open. An individual folder can be rescanned from its right-click menu in the tree.
- **Rescan** (per folder) brings a folder up to date. Files whose path, size and modified time have not changed are not read again.
- A file whose content appears at a new path, with the old path gone, is counted as **moved**. It keeps its hash.
- Files that disappear are marked **missing**, not deleted, so you can see what went and the record is still there if it returns.
- **Thumbnails** are made automatically in the background after each scan (512 px, Z-up corner view). Use **Pause** /
  **Resume** as needed. They continue after a restart. Files that cannot be read are listed as *failed* with the
  reason (hover the cell); **Retry failed** tries them again. Deleting a PNG makes it be regenerated.

The index is stored in `~/.config/model-library/library.sqlite`. Set the `MODEL_LIBRARY_DB` environment variable
to use a different file. Thumbnails are the `<sha256>.png` files in a `thumbnails` folder next to it; each PNG has its
view settings embedded.

## Selecting and right-clicking

- **Click** a thumbnail to select it; click it again to deselect it. **Double-click** (or press Enter) opens the viewer.
- **Shift-click** selects everything from the last item you clicked to this one. **Ctrl-click** (Cmd on a Mac) adds or
  removes a single item, as does clicking the round tick in the corner of a thumbnail.
- **Ctrl+A** or **Select all** selects every file that matches the current search and filters; **Esc** or **Clear**
  empties the selection. Changing the search, filters, folder or order also clears it.
- **Right-click** a thumbnail: Open in viewer, Show in folder, Download…, Copy path, Copy SHA-256, Rate (Unrated or 0
  to 5 stars), Find other copies of this model, Regenerate thumbnail and Revert to automatic view. Copy, Rate,
  Download, Regenerate and Revert apply to the whole selection when you right-click inside it; right-clicking
  something outside the selection selects just that one first.
  - **Open in viewer** is only available when exactly one file is selected.
  - **Show in folder** is only available when every selected file is in the same folder. For a model inside an
    archive, the folder is the one that holds the archive, and that folder is opened.
  - **Download…** asks for a destination folder and copies the selected files into it. Files inside archives
    (.zip, .7z, .rar) are extracted straight into that folder. Nothing is overwritten: a name that is already taken
    becomes `name (2).stl`. Copies keep the file's modified date, a progress box with a Cancel button shows while it
    works, and each copy is checked against the hash the library holds (you are told if a file had changed since the
    last scan). A summary says how many files were copied and lists any that could not be.
- **Right-click a folder** in the tree: Rescan this folder, Show in folder, Copy path and Remove from library…
  (which opens the same confirmation as Manage folders).
- Showing a folder needs a file manager, so under WSL it may do nothing; the copy actions always work.

## Models inside archives (.zip, .7z, .rar)

Folders are searched for `.zip`, `.7z` and `.rar` files too (Preferences → **Search inside archives**, on by default).

- A model inside an archive is hashed from its decompressed bytes, so it has the same SHA-256 as the same file stored
  loose. Thumbnails, ratings and saved views are shared, and copies are reported as duplicates.
- An archive shows up as a folder in the tree; its models carry a **ZIP**, **7Z** or **RAR** badge and read
  "in <name>".
- Nothing is unpacked to disk. `.zip` files are read in the app; `.7z` and `.rar` files are read with the 7-Zip
  program that ships with the app (`vendor/7zip`, copied next to the app when you build it).
- An archive whose size and modified time have not changed is not opened again on a rescan.
- *Date modified* is the model's own date inside the archive; the archive's date only decides whether to look again.
- Archives inside archives are skipped (and counted in the scan message). Password-protected or damaged archives are
  reported as problems and their earlier results are kept. Each model is checked against its stored checksum.
  Limits guard against bombs (200,000 entries, 2 GB per model, suspiciously high compression ratios).
- `.7z` and `.rar` archives are often "solid" (compressed as one block). A scan reads such an archive in a single pass,
  but opening one model from a large solid archive later has to decompress what comes before it, so it can take a
  moment. Split archives are supported: `name.7z.001` (with `.002`, `.003`...), `name.part1.rar` (with `.part2.rar`...) and
  old-style `name.rar` with `name.r00`, `name.r01`... The set is opened through its first part and appears once, as
  that file. If any part's size or date changes, the set is read again; a missing part is reported as a problem and
  the earlier results are kept. Keep all the parts in the same folder.
- Switching the setting off and pressing **Rescan** marks models found only inside archives as missing; switching it
  on again and rescanning brings them back.
- 7-Zip is free software (mostly LGPL; its RAR code has the unRAR restriction, which allows reading only). Its licence
  is in `vendor/7zip/License.txt` and is copied into the installed app. `MODEL_LIBRARY_7Z` can point at a different
  7-Zip program.

## The log file

The app keeps a plain-text log, one event per line, each starting with a local timestamp and its UTC offset
(`2026-10-28T16:52:32.153+00:00 INFO  scan.start ...`). Open it from **Preferences → Show log file**; it lives in
`logs/model-library.log` next to the library database (`~/.config/model-library/logs` on Linux).

| Event | What it records |
| --- | --- |
| `app.start`, `app.quit` | version, platform, database and 7-Zip location |
| `rescan.start`, `rescan.end` | the Rescan button: when it began, how long it took (`duration_ms`), folders, errors |
| `scan.start`, `scan.end` | one folder: when, `duration_ms`, files found / hashed / unchanged / new / moved / missing, archives, errors |
| `hash` | every file or archive entry that was read: `path`, `sha256`, `size`, `ms` taken (plus `archive` for entries inside one) |
| `archive` | an archive that was read: models found, nested archives skipped, parts, `ms` |
| `thumbs.start`, `thumbs.end` | the thumbnail queue: how many were waiting, how long it took, how many were made or failed |
| `thumb.ok` | one thumbnail: `path`, `sha256`, `ms` in total, `read_ms` spent reading the model |
| `WARN problem`, `thumb.fail`, `thumb.skip` | files or archives that could not be read, models that would not draw, files that changed or vanished |
| `ERROR thumbs.blocked`, `renderer.failed`, `app.exception` | the thumbnail renderer could not start, or the app hit an unexpected error |

Files that have not changed since the last scan are counted (`unchanged=`) but not listed again. The log rolls over at
10 MB and keeps the last 5 files (`model-library.log.1` to `.5`), so it cannot fill the disk. It contains file names
and paths from your library and never leaves your computer.

## How it is organised

```
main.js          Electron main process: windows, folder picker, scan control
preload.js       The small set of functions the pages are allowed to call
src/scanner.js   Walks a folder tree and yields .stl / .3mf files
src/selection-actions.js  Looks up a selection, checks its folders, and copies or extracts it (Download)
src/menus.js         The right-click menus (as data)
src/logger.js        The log file writer (timestamps, rollover)
src/zip-reader.js   Streams model entries out of .zip files (yauzl), with safety limits
src/sevenzip-reader.js  The same for .7z and .rar, through the bundled 7-Zip program
src/archive-reader.js   Picks the right reader for an archive
src/model-source.js Reads a model's bytes whether it is loose or inside a zip
src/hasher.js    Streaming SHA-256 (constant memory, however big the file)
src/indexer.js   Scan, hash only what changed, detect moved and missing files
src/thumbnail-queue.js  Background queue: pause/resume, failures, atomic writes
src/render-host.js      Hidden window that renders thumbnails (WebGL)
src/db.js        SQLite schema and queries (Node's built-in SQLite, nothing to compile)
viewer-preload.js  Lets the viewer receive a file opened from the library
renderer/        index.html + app.js (library window: folder tree and virtual grid), viewer.html (thumbnail viewer)
test/            node:test unit tests
```

Two tables carry the idea: `models` has one row per distinct file content (its SHA-256), and `locations`
has one row per path where that content has been seen. Two copies of a file share a model and have two locations.

## Building an installable app (Linux)

```bash
npm install
npm run dist:linux        # writes dist/ModelLibrary-<version>-amd64.deb and ...-x86_64.AppImage
```

- **.deb** (recommended on Ubuntu): `sudo apt install ./dist/ModelLibrary-0.1.0-amd64.deb`, then start "Model Library"
  from the app menu or run `model-library`. The package sets up the Chromium sandbox for your system, including
  Ubuntu's AppArmor rules.
- **AppImage**: `chmod +x ModelLibrary-0.1.0-x86_64.AppImage && ./ModelLibrary-0.1.0-x86_64.AppImage`. It needs FUSE
  (`sudo apt install libfuse2t64` on Ubuntu 24 and later), or run it with `--appimage-extract-and-run`. If it stops with
  a sandbox error, start it with `--no-sandbox`.
- Under WSL2 the window appears through WSLg, the same as `npm start`.
- The installed app and `npm start` share the same library (`~/.config/model-library`).
- The three.js files the app uses are copied into `renderer/vendor/three` (`npm run vendor` refreshes them), so the
  installer does not need `node_modules` at run time.

**Windows** (built from WSL, no Wine needed): `npx electron-builder --win portable` writes a single
`dist/ModelLibrary-<version>-x64.exe`; `--win nsis` writes an installer instead. The build downloads the Windows
copy of Electron the first time. It is unsigned, so Windows SmartScreen shows a warning ("More info", then "Run anyway").

`npm run pack` makes an unpacked build in `dist/linux-unpacked` for quick checks.

## Building a Windows installer

Build on Windows (PowerShell, not WSL), from a plain local folder such as `C:\dev\model-library`:

```powershell
npm install
npm run dist:win        # writes dist\ModelLibrary-Setup-<version>.exe
```

The installer lets the user choose the install folder and adds Start menu and desktop shortcuts. The library itself
lives in `%APPDATA%\model-library`, so updating or uninstalling does not delete it. Without a code-signing certificate
Windows SmartScreen shows "Windows protected your PC" (More info, then Run anyway).

`.github/workflows/windows-installer.yml` builds the same installer on GitHub: push a tag such as `v0.1.0` (or run the
workflow by hand) and the `.exe` is attached to the run, and to the release for a tag.

## What comes next

1. Windows and macOS installers (best built on those systems, or in GitHub Actions). Unsigned installers show a security warning.
