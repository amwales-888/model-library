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
        VelopackApp.Build().SetArgs(args).Run();

        var app = new App();
        app.InitializeComponent();
        app.Run();
    }
}
