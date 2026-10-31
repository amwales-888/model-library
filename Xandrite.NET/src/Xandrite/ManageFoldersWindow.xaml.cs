using System.IO;
using System.Windows;
using System.Windows.Controls;
using Xandrite.Presentation;

namespace Xandrite.App;

/// <summary>
/// Preferences → Manage folders: every folder in the library, with its file count and last scan. Folders can be removed
/// at once; added folders are collected and scanned when the window closes, so several can be added in a row.
/// </summary>
public partial class ManageFoldersWindow : Window
{
    private readonly LibraryViewModel _vm;

    public sealed record FolderItem(string Path, string FilesText, string ScannedText, bool IsNew);

    public ManageFoldersWindow(LibraryViewModel vm)
    {
        _vm = vm;
        InitializeComponent();
        Refresh();
    }

    /// <summary>Folders added in this window, to be scanned once it closes.</summary>
    public List<string> Added { get; } = [];

    private void Refresh()
    {
        var items = _vm.Roots.Select(r => new FolderItem(
            r.Path,
            r.Files.ToString("N0"),
            r.LastScannedAt is { } t ? DateTimeOffset.FromUnixTimeMilliseconds(t).LocalDateTime.ToString("g") : "never",
            IsNew: false)).ToList();
        items.AddRange(Added.Select(p => new FolderItem(p, "", "when this window closes", IsNew: true)));
        FolderList.ItemsSource = items;
    }

    private void OnAdd(object sender, RoutedEventArgs e)
    {
        var dialog = new Microsoft.Win32.OpenFolderDialog { Title = "Choose a folder of 3D models", Multiselect = true };
        if (dialog.ShowDialog(this) != true) return;
        foreach (var folder in dialog.FolderNames.Select(Path.GetFullPath))
        {
            if (!Added.Contains(folder, StringComparer.OrdinalIgnoreCase) && !_vm.Roots.Any(r => string.Equals(r.Path, folder, StringComparison.OrdinalIgnoreCase)))
                Added.Add(folder);
        }
        Refresh();
    }

    private void OnRemove(object sender, RoutedEventArgs e)
    {
        if ((sender as FrameworkElement)?.Tag is not FolderItem item) return;
        if (item.IsNew)
            Added.Remove(item.Path);
        else
            _vm.RemoveFolder(item.Path);
        Refresh();
    }
}
