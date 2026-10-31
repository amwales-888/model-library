using System.Diagnostics;
using System.IO;   // WPF projects leave System.IO out of the implicit usings (it clashes with System.Windows.Shapes.Path)
using System.Security.Cryptography;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media.Imaging;
using Microsoft.Win32;
using Xandrite.Geometry;
using Xandrite.Loading;
using Xandrite.Rendering;
using Xandrite.Rendering.Direct3D11;
using Xandrite.Thumbnails;

namespace Xandrite.App;

/// <summary>
/// Thumbnail preview: loads a model once, then draws it again whenever the size or an option changes.
/// Until the interactive viewer exists, the library opens models here too.
/// Loading and drawing run on a background thread; the gate makes sure only one draw uses the renderer at a time.
/// </summary>
public partial class PreviewWindow : Window
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private D3D11Renderer? _renderer;
    private bool _rendererIsSoftware;

    private Mesh? _mesh;
    private string? _name;
    private ThumbnailFileInfo? _fileInfo;
    private TimeSpan _loadTime;
    private byte[]? _png;

    public PreviewWindow()
    {
        InitializeComponent();
        SizeBox.ItemsSource = new[] { 256, 512, 1024, 2048 };
        SizeBox.SelectedItem = Look.ThumbnailSize;
    }

    /* ---------- choosing a file ---------- */

    private async void OnOpen(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFileDialog
        {
            Title = "Open a 3D model",
            Filter = "3D models (*.stl;*.3mf)|*.stl;*.3mf|All files (*.*)|*.*",
        };
        if (dialog.ShowDialog(this) == true) await LoadFileAsync(dialog.FileName);
    }

    private void OnDragOver(object sender, DragEventArgs e)
    {
        e.Effects = e.Data.GetDataPresent(DataFormats.FileDrop) ? DragDropEffects.Copy : DragDropEffects.None;
        e.Handled = true;
    }

    private async void OnDrop(object sender, DragEventArgs e)
    {
        if (e.Data.GetData(DataFormats.FileDrop) is string[] { Length: > 0 } files) await LoadFileAsync(files[0]);
    }

    /* ---------- options ---------- */

    private async void OnSizeChanged(object sender, SelectionChangedEventArgs e) => await RedrawIfReady();

    private async void OnOptionChanged(object sender, RoutedEventArgs e) => await RedrawIfReady();

    private async Task RedrawIfReady()
    {
        if (IsLoaded && _mesh is not null) await RenderAsync();
    }

    private void OnSave(object sender, RoutedEventArgs e)
    {
        if (_png is null || _name is null) return;
        var dialog = new SaveFileDialog
        {
            Title = "Save thumbnail",
            Filter = "PNG image (*.png)|*.png",
            FileName = Path.GetFileNameWithoutExtension(_name) + ".png",
        };
        if (dialog.ShowDialog(this) != true) return;
        try
        {
            File.WriteAllBytes(dialog.FileName, _png);
            StatusText.Text = "Saved " + dialog.FileName;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            StatusText.Text = "Could not save the image: " + ex.Message;
        }
    }

    /* ---------- loading and drawing ---------- */

    public async Task LoadFileAsync(string path)
    {
        string name = Path.GetFileName(path);
        StatusText.Text = "Reading " + name + "…";
        byte[] data;
        try
        {
            data = await File.ReadAllBytesAsync(path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            StatusText.Text = name + ": " + ex.Message;
            return;
        }
        await ShowModelAsync(name, Path.GetExtension(path), data);
    }

    /// <summary>Shows a model from its bytes (a file inside an archive has no path of its own).</summary>
    public async Task ShowModelAsync(string name, string format, byte[] data)
    {
        StatusText.Text = "Reading " + name + "…";
        try
        {
            var (mesh, info, loadTime) = await Task.Run(() =>
            {
                var clock = Stopwatch.StartNew();
                var loaded = ModelLoader.Load(data, format);
                var elapsed = clock.Elapsed;
                string sha = Convert.ToHexStringLower(SHA256.HashData(data));
                return (loaded, new ThumbnailFileInfo(name, format.TrimStart('.'), data.Length, sha), elapsed);
            });
            _mesh = mesh;
            _name = name;
            _fileInfo = info;
            _loadTime = loadTime;
            Title = name + " – Xandrite";
            await RenderAsync();
        }
        catch (ModelFormatException ex)
        {
            StatusText.Text = name + ": " + ex.Message;
        }
    }

    private async Task RenderAsync()
    {
        if (_mesh is not { } mesh) return;
        int size = SizeBox.SelectedItem is int s ? s : Look.ThumbnailSize;
        bool zUp = ZUpBox.IsChecked == true;
        bool software = SoftwareBox.IsChecked == true;
        var info = _fileInfo;

        await _gate.WaitAsync();
        try
        {
            StatusText.Text = "Drawing…";
            var (png, json, renderTime, encodeTime) = await Task.Run(() =>
            {
                var renderer = EnsureRenderer(software);
                return new ThumbnailGenerator(renderer).Draw(mesh, null, size, info, defaultZUp: zUp);
            });

            _png = png;
            Preview.Source = ToBitmap(png);
            HintText.Visibility = Visibility.Collapsed;
            SaveButton.IsEnabled = true;
            ViewStateText.Text = json;
            AdapterText.Text = _renderer is { } r
                ? $"{r.AdapterDescription}{(r.IsSoftware ? " (software)" : "")} · {r.SampleCount}x MSAA"
                : "";
            StatusText.Text = $"{info?.Name}: {mesh.TriangleCount:N0} triangles · read {Ms(_loadTime)} · " +
                              $"draw {Ms(renderTime)} · PNG {Ms(encodeTime)} ({png.Length / 1024.0:0.0} KB)";
        }
        catch (RendererException ex)
        {
            // A lost or unusable device: drop the renderer so the next attempt starts a fresh one.
            _renderer?.Dispose();
            _renderer = null;
            StatusText.Text = "The renderer failed: " + ex.Message;
        }
        finally
        {
            _gate.Release();
        }
    }

    private D3D11Renderer EnsureRenderer(bool software)
    {
        if (_renderer is null || _rendererIsSoftware != software)
        {
            _renderer?.Dispose();
            _renderer = D3D11Renderer.Create(new D3D11RendererOptions(ForceSoftware: software));
            _rendererIsSoftware = software;
        }
        return _renderer;
    }

    private static BitmapImage ToBitmap(byte[] png)
    {
        using var stream = new MemoryStream(png);
        var bitmap = new BitmapImage();
        bitmap.BeginInit();
        bitmap.CacheOption = BitmapCacheOption.OnLoad;
        bitmap.StreamSource = stream;
        bitmap.EndInit();
        bitmap.Freeze();
        return bitmap;
    }

    private static string Ms(TimeSpan t) => $"{t.TotalMilliseconds:0} ms";

    protected override void OnClosed(EventArgs e)
    {
        _renderer?.Dispose();
        _renderer = null;
        base.OnClosed(e);
    }
}
