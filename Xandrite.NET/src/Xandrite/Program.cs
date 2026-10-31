using System.Windows;
using Velopack;

namespace Xandrite.App;

/// <summary>
/// The entry point. Velopack runs first: when Setup, an update or the uninstaller starts the app to do their part,
/// it does it and exits before any window appears. A downloaded update that was not installed yet is installed here.
/// </summary>
public static class Program
{
    [STAThread]
    public static void Main(string[] args)
    {
        bool justInstalled = false;
        VelopackApp.Build()
            .SetArgs(args)
            .OnFirstRun(_ => justInstalled = true)
            .Run();

        // Setup always starts the app when it finishes; ask rather than open the library unannounced.
        if (justInstalled && !StartAfterInstall()) return;

        var app = new App();
        app.InitializeComponent();
        app.Run();
    }

    private static bool StartAfterInstall() =>
        MessageBox.Show(
            "Xandrite has been installed. You can start it any time from the Start menu or the desktop shortcut.\n\nStart Xandrite now?",
            "Xandrite",
            MessageBoxButton.YesNo,
            MessageBoxImage.Information,
            MessageBoxResult.Yes) == MessageBoxResult.Yes;
}
