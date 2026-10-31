using System.IO;
using System.Windows;
using Xandrite.Library;
using Xandrite.Library.Sqlite;
using Xandrite.Library.Thumbnails;
using Xandrite.Presentation;
using Xandrite.Rendering.Direct3D11;

namespace Xandrite.App;

/// <summary>
/// Start-up: one copy of the app at a time; the library in %APPDATA%\Xandrite.NET (brought across from the Electron
/// app the first time); the library window; then the thumbnail queue.
/// </summary>
public partial class App : Application
{
    private Mutex? _singleInstance;
    private LibraryDatabase? _db;
    private LibraryViewModel? _library;
    private ViewerViewModel? _viewer;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        _singleInstance = new Mutex(initiallyOwned: true, "Xandrite.NET.Library", out bool first);
        if (!first)
        {
            // A second copy would fight over the database file.
            MessageBox.Show("Xandrite is already running.", "Xandrite", MessageBoxButton.OK, MessageBoxImage.Information);
            Shutdown();
            return;
        }

        var location = LibraryLocation.Default();
        string? electron = ElectronImport.FindElectronDataFolder();
        try
        {
            ElectronImport.CopyDatabaseIfNew(location, electron);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or SqliteException)
        {
            MessageBox.Show("The library of the Electron app could not be copied, so Xandrite starts with an empty library.\n\n" + ex.Message,
                "Xandrite", MessageBoxButton.OK, MessageBoxImage.Warning);
        }

        try
        {
            _db = new LibraryDatabase(location.DatabaseFile);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or SqliteException or DllNotFoundException)
        {
            MessageBox.Show("The library could not be opened:\n\n" + ex.Message, "Xandrite", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(1);
            return;
        }

        // A few workers draw at once, each with its own Direct3D renderer.
        int workers = Math.Clamp(Environment.ProcessorCount / 4, 1, 4);
        var queue = new ThumbnailQueue(_db, location, () => D3D11Renderer.Create(), workers: workers);

        var shell = new WpfShell();
        var dispatcher = new WpfDispatcher(Dispatcher);
        _library = new LibraryViewModel(_db, location, queue, shell, dispatcher);

        // The viewer: what it changes (thumbnail, view, rating) shows in the library grid straight away.
        _viewer = new ViewerViewModel(_db, location, queue, () => D3D11Renderer.Create(), shell, dispatcher);
        _viewer.ThumbnailReplaced += _library.ApplyThumbnailReplaced;
        _viewer.ViewReverted += _library.ApplyViewReverted;
        _viewer.RatingChanged += _library.ApplyRating;
        shell.Viewer = _viewer;

        var window = new LibraryWindow(_library);
        shell.Owner = window;
        MainWindow = window;
        window.Show();
        _library.Initialize();

        _ = FinishImportThenDrawAsync(location, electron);
    }

    /// <summary>Copies the Electron app's thumbnail images (if an import is under way), then starts drawing.</summary>
    private async Task FinishImportThenDrawAsync(LibraryLocation location, string? electron)
    {
        if (_db is null || _library is null) return;
        if (electron is not null && ElectronImport.ThumbnailsPending(_db))
        {
            var library = _library;
            var progress = new Progress<(int Done, int Total)>(p =>
                library.ImportText = $"Bringing thumbnails across from the Electron app: {p.Done:N0} of {p.Total:N0}");
            try
            {
                await Task.Run(() => ElectronImport.CopyThumbnailsAsync(_db, location, electron, progress));
                library.ImportText = "";
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                library.ImportText = "Some thumbnails could not be copied from the Electron app: " + ex.Message;
            }
            library.RefreshAll();   // show the copied images
        }
        _library.StartThumbnails();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _viewer?.Close();
        // Let the thumbnail workers finish the model in hand (a few seconds at most), then close the database.
        if (_library is not null)
        {
            var library = _library;
            Task.Run(() => library.DisposeAsync().AsTask()).Wait(TimeSpan.FromSeconds(5));
        }
        _db?.Dispose();
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}
