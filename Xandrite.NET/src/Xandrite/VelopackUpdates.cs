using System.Reflection;
using System.Windows;
using Velopack;
using Velopack.Sources;
using Xandrite.Presentation;

namespace Xandrite.App;

/// <summary>Updates from the GitHub releases of the repository, through Velopack. Only an installed copy updates.</summary>
public sealed class VelopackUpdates : IAppUpdates
{
    public const string Repository = "https://github.com/amwales-888/xandrite";

    private readonly UpdateManager? _manager;
    private UpdateInfo? _found;

    public VelopackUpdates()
    {
        try
        {
            var manager = new UpdateManager(new GithubSource(Repository, accessToken: null, prerelease: false));
            if (manager.IsInstalled) _manager = manager;
        }
        catch (Exception)
        {
            _manager = null;   // not installed (run from a build folder): no updates
        }
    }

    public bool IsInstalled => _manager is not null;

    public string CurrentVersion =>
        _manager?.CurrentVersion?.ToNormalizedString()
        ?? Assembly.GetExecutingAssembly().GetName().Version?.ToString(3)
        ?? "?";

    public string? PendingVersion => _manager?.UpdatePendingRestart?.Version.ToNormalizedString();

    public async Task<string?> CheckAsync(CancellationToken cancellation)
    {
        if (_manager is null) return null;
        _found = await _manager.CheckForUpdatesAsync().WaitAsync(cancellation);
        return _found?.TargetFullRelease.Version.ToNormalizedString();
    }

    public Task DownloadAsync(Action<int> progress, CancellationToken cancellation) =>
        _manager is null || _found is null ? Task.CompletedTask : _manager.DownloadUpdatesAsync(_found, progress, cancellation);

    public void RestartToUpdate()
    {
        if (_manager is null) return;
        var asset = _found?.TargetFullRelease ?? _manager.UpdatePendingRestart;
        if (asset is null) return;
        // Velopack waits for this process to end, installs, and starts the new version; the app closes normally
        // meanwhile, so the thumbnail workers finish and the library is closed properly.
        _manager.WaitExitThenApplyUpdates(asset, silent: true, restart: true);
        Application.Current.Shutdown();
    }
}
