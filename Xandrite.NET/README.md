# Xandrite.NET

*Every model has a side worth seeing.*

Xandrite for Windows, in .NET 10 and WPF. This is the port of the Electron app
([amwales-888/xandrite](https://github.com/amwales-888/xandrite)) to a Windows-only native application.
There is no browser engine: thumbnails are drawn with Direct3D 11, called directly through COM.

**Status:** the app is usable. It has the library window (folder tree, virtualised thumbnail grid, search, filters,
sorting, ratings, right-click actions, Manage folders), scanning, the thumbnail queue drawing with Direct3D, and a
one-time import of the Electron app's library, and the interactive viewer. Not yet done: .7z/.rar support and the
installer.

## What is in the solution

| Project | What it does |
|---|---|
| `src/Xandrite` | The WPF app (`Xandrite.exe`): the library window, the viewer, Manage folders, the thumbnail preview, and the image loader. Thin: the logic is in `Xandrite.Presentation`. |
| `src/Xandrite.Presentation` | The windows' logic as plain view models (no WPF types). `LibraryViewModel` covers filters, sorting, the tree, tiles in rows, selection, ratings, scanning and thumbnail status. `ViewerViewModel` covers frames, orbiting, Update, Revert, rating and export. Tested on any OS. |
| `src/Xandrite.Core` | Everything that needs no GPU: STL and 3MF readers, camera framing, lighting and material values, the view settings stored in each PNG, the PNG writer. No Windows dependencies, so it builds and tests anywhere. |
| `src/Xandrite.Rendering.Direct3D11` | The renderer. Hand-written COM interop to `d3d11.dll`, `dxgi.dll` and `d3dcompiler_47.dll` (all part of Windows), plus the HLSL shader. No NuGet packages. |
| `src/Xandrite.ThumbTool` | `xandrite-thumb`, a command-line thumbnail maker for trying real files, timing, scripts and CI. |
| `src/Xandrite.Library` | The library. `LibraryDatabase` (a port of `db.js`, same schema), `FolderWalker` (`scanner.js`), `LibraryScanner` (`indexer.js`), `ThumbnailQueue` (`thumbnail-queue.js`), `Downloads`, zip reading, `ModelSource`, and `ElectronImport`. SQLite is called through its C API: Windows' own `winsqlite3.dll`. No NuGet packages. |
| `src/Xandrite.LibraryTool` | `xandrite-lib`, which inspects a library (on a copy) or scans folders into a test library. |
| `tests/Xandrite.Core.Tests` | xUnit tests for the readers, framing, view settings and PNG output. |
| `tests/Xandrite.Library.Tests` | The Electron app's explorer, indexer, zip and thumbnail-queue tests, ported, plus compatibility tests against `Fixtures/electron-library.sqlite`, a library written by the Electron app's own `db.js`. |
| `tests/Xandrite.Presentation.Tests` | The library window's behaviour: selection, filters, settings, scanning and thumbnails reaching the tiles. |
| `samples/` | Small test models: a binary STL, an ASCII STL, and a 3MF with colours and a component stored in a separate model file. |

## How a thumbnail is made

`ThumbnailGenerator` does what the JS app's `renderer/thumbnail-worker.js` did:

1. **Read** the file into a flat list of triangles (`ModelLoader` → `StlReader` / `ThreeMfReader`). 3MF build-item and
   component transforms are applied here, including components in other model files (Bambu Studio, Orca Slicer,
   PrusaSlicer), and colours from `<basematerials>` and `<m:colorgroup>` are kept.
2. **Frame** it (`ViewMath`, ported from `view.js`): turn Z up, centre the bounding box, and place the camera on the
   default corner view, or on the view the person saved.
3. **Draw** it (`D3D11Renderer`): an off-screen 512 px sRGB image with 4× MSAA. The shader (`Shaders/Standard.hlsl`)
   is a port of three.js's `MeshStandardMaterial` with the same hemisphere light and two directional lights.
   If there is no usable GPU, it falls back to WARP, Microsoft's software Direct3D, which replaces the old SwiftShader fallback.
4. **Write** the PNG with the view settings as JSON in an iTXt chunk named `ModelThumbnailer`, exactly as before.

`Look.cs` holds every value that affects the picture. Change any of them, or the shader, and bump `Look.RenderVersion`
so existing thumbnails are redrawn.

### Compatibility with the Electron app

- The view-settings JSON is the same, field for field. A test compares it with the output of the original `view.js`.
- Camera framing matches `view.js` (tests pin the numbers it produced under Node).
- `RenderVersion` is 2. STL thumbnails come out almost pixel-identical to three.js's (see
  `samples/three-vs-direct3d.png`). The visible change is that 3MF files now keep their colours.
  three.js's 3MF loader couldn't read component files, and the JS app's fallback reader dropped colours.

## Where the app keeps its data

`%APPDATA%\Xandrite.NET`: `library.sqlite` and a `thumbnails` folder (one `<sha256>.png` per model). Set
`XANDRITE_NET_DATA` to use another folder, for example a test library.

**The first start** copies the Electron app's library across, if there is one (`%APPDATA%\xandrite`). The
database is copied before the window opens; the thumbnail images follow in the background (see the status bar).
The Electron app's folder is only read, never written, so both apps can be kept side by side. Its thumbnails were
drawn by three.js, so the queue redraws them with Direct3D one by one; until it reaches each, the old image is shown.
If the app is closed during the image copy, it carries on at the next start.

## Using the library window

It works like the Electron app's window:
- **Folder tree** on the left, with "All files" at the top. Right-click a folder to rescan it, show it in Explorer, or
  remove it from the library.
- **Search** matches part of a path or of a SHA-256. **Filters** narrow by size, age (date modified or date added) and
  rating. **Order by** has name, folder and name, date modified, date added, size and rating; the ⇅ button reverses it.
- **Selecting:** click selects (click again to deselect); Ctrl-click or the round tick adds or removes one;
  Shift-click selects a range; Ctrl+A selects all; Esc clears.
- **Keys:** the arrow keys move the selection; Enter opens the viewer; 1 to 5 rate the selection and 0 clears the rating;
  Ctrl+F goes to the search box; F5 rescans everything.
- **Right-click** a thumbnail: Open, Show in folder, Download… (copies, or extracts from zips, never overwriting),
  Copy path, Copy SHA-256, Rate, Find other copies of this model, Regenerate thumbnail, Revert to automatic view.
- **Status bar:** library counts, scan progress (with Cancel), thumbnail progress (with Pause, Resume and Retry failed),
  and Rescan All.
- **Preferences ▾:** Manage folders… (add several, then they are scanned when the window closes), Search inside
  archives, Thumbnail preview…, Open data folder.
- Drop folders on the window to add them.

The grid is a virtualised list of rows, so it stays fast with very large libraries. Thumbnails are decoded on
background threads at the size they are shown, with a small cache.

## The viewer

Double-click a thumbnail (or select it and press Enter, or choose Open) to open the model in the viewer. It is a port
of the Electron app's viewer:
- **Left-drag** turns the model, **right-drag** (or Shift + left-drag) pans, the **wheel** zooms, and **R** resets the
  view. The camera behaves like three.js's OrbitControls: it never rolls or flips over the top.
- **File** shows the name, format, size, triangles, dimensions, SHA-256 and the **rating**, which can be changed
  here for models opened from the library.
- **Update thumbnail** replaces the model's library thumbnail with what you see (512 px) and stores the view, so a
  later redraw uses it. The grid shows the new image straight away. **Revert to automatic view** forgets it.
- **Z up** turns the file's Z axis upwards (on by default, as STL and 3MF files are normally Z-up).
- **Advanced** saves the view as a PNG at 256 to 2048 px and shows the view settings stored inside it.
- Open file… or drop a file onto the viewer to look at models outside the library.

Frames are drawn with the same Direct3D 11 renderer as the thumbnails, off screen on a background thread, then
shown in the window. While one frame is drawn, further mouse movement is gathered into a single next frame, so the
view never lags behind the mouse. (If very large models ever feel slow, a direct swap chain can replace this later.)

## The library

`LibraryDatabase` uses the Electron app's schema unchanged, so the .NET app can open an existing
`%APPDATA%\xandrite\library.sqlite` and its `thumbnails` folder as they are. It works the other way too: the
Electron app can read a library written here. Both directions are covered by tests.

- **SQLite** is called directly through its C API (`Sqlite/SqliteNative.cs`). On Windows that is `winsqlite3.dll`,
  part of Windows 10 and 11, so nothing is shipped. If you ever want a newer SQLite, build `sqlite3.dll` from the
  amalgamation and put it next to the exe; it is picked up automatically. The minimum version is 3.24 (from 2018).
- **Scanning** follows `indexer.js`. Unchanged files (same path, size and modified time) are not read again. Moved
  files keep their hash, thumbnail, rating and view. Deleted files are marked missing. Nothing is marked missing
  after a cancelled scan or when a folder can't be read. Modified times are computed exactly as Node.js does, so
  files the Electron app indexed count as unchanged and aren't re-hashed on the first .NET scan.
- **Zip files** are read with `System.IO.Compression`. Entries are matched on size and CRC-32. The Electron app also
  compared entry dates, which .NET reads slightly differently, so dates no longer count. Existing zips are not re-read.
- **.7z and .rar** need 7-Zip's `7z.dll` loaded in-process. That's the next interop job. Until then these archives
  are reported once per scan, and the models already recorded inside them are kept as they are, never marked missing.
- Two small improvements over the JS app: scan IDs always increase, even for two scans in the same millisecond, and
  cloud placeholder files (OneDrive) are scanned, while links to folders are still not followed.

Try it on your real library:

```
dotnet run --project src/Xandrite.LibraryTool -- info
dotnet run --project src/Xandrite.LibraryTool -- scan "C:\path\to\models" --db test-library.sqlite
```

`info` reads a temporary copy of `%APPDATA%\xandrite\library.sqlite`, so the Electron app's library is never changed.
`scan` refuses to write into that file.

## What you need to build it

**Recommended: Visual Studio 2026 Community** (free for individuals and open-source work).

In the Visual Studio Installer, select:

- **.NET desktop development** (required). It brings the .NET 10 SDK, the WPF designer, the test runner and the debugger.
- **Desktop development with C++** (optional, for later). Add it when you start bringing in C libraries
  (lib3mf, 7-Zip's `7z.dll` source, anything built from C or C++), or if you want C++/CLI wrappers.

Also worth having:

- **Graphics Tools**, a Windows optional feature (Settings → System → Optional features → Add a feature →
  "Graphics Tools"). It installs the Direct3D debug layer. Then `xandrite-thumb --debug` reports any Direct3D misuse in
  Visual Studio's Output window.
- **RenderDoc** (free), for frame captures if a thumbnail ever looks wrong.
- **Git for Windows**, if you don't use Visual Studio's built-in Git.

Without Visual Studio, the **.NET 10 SDK** alone is enough to build and test from a terminal. VS Code with the
C# Dev Kit extension, or JetBrains Rider, also work.

## Build and run

In Visual Studio: open `Xandrite.slnx`, right-click **Xandrite** → *Set as Startup Project*, press F5.
Use *Test → Run All Tests* for the tests.

From a terminal (in this folder):

```
dotnet build Xandrite.slnx
dotnet test Xandrite.slnx
dotnet run --project src/Xandrite
dotnet run --project src/Xandrite.ThumbTool -- samples -o thumbnails
```

`xandrite-thumb` options: `--size 1024`, `--software` (WARP), `--by-hash` (name files `<sha256>.png` like the
library), `--view some-thumbnail.png` (reuse a stored view), `--no-z-up`, `--debug`.

The GitHub Actions workflow (`.github/workflows/build.yml`) builds, tests, and draws the samples with WARP on
`windows-latest`, then uploads the PNGs as an artifact.

## What has been verified, and what has not yet

This was put together on Linux, where NuGet and Windows weren't available:

- `Xandrite.Core`, the renderer library and `xandrite-thumb` compile. The 39 tests pass (run through a stand-in for xUnit).
  On Windows: the tests, `xandrite-thumb`, the WPF preview and GPU rendering all confirmed working.
- `Xandrite.Library` and `xandrite-lib`: on Windows, the tests, `info` and `scan` were confirmed working.
- The library window, thumbnail queue and import were confirmed working on Windows.
- New in this round: the orbit camera, the viewer view model and its tests (46 core, 56 library and 22 view-model
  tests in all) pass here. **Not yet compiled:** `ViewerWindow` and the changes to `WpfShell` and `App`, because WPF
  can't be built on Linux. Paste any build errors and they'll be fixed.
- The shader and the exact Direct3D pipeline settings were run under Wine's Direct3D 11 to produce the comparison image.
  The COM vtable slot numbers were taken mechanically from the Windows SDK headers.
- **Not yet run on real Windows:** the C# COM calls themselves, the WPF app (it needs the Windows Desktop SDK to
  compile), and the xUnit packages restoring. The first `dotnet build` and `xandrite-thumb samples --software` on your
  machine are the real test. Please report anything that fails.

## Next steps

1. `7z.dll` loaded in-process for .7z and .rar. Until then, models inside them keep their imported thumbnails and stay
   "waiting" in the thumbnail count.
2. The log file (`logger.js`).
3. Installer and updates (Velopack or MSIX).
4. Windows integration: thumbnails in Explorer itself (a shell thumbnail provider), the NTFS change journal for
   instant rescans.
