using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Xandrite.Presentation;
using Xandrite.Rendering;

namespace Xandrite.App;

/// <summary>
/// The viewer window. Frames are drawn by <see cref="ViewerViewModel"/> at the view's size in device pixels and shown
/// one to one; this file turns mouse input into orbit, pan and zoom, and copies each frame into a WriteableBitmap.
/// </summary>
public partial class ViewerWindow : Window
{
    private readonly ViewerViewModel _vm;
    private WriteableBitmap? _bitmap;
    private MouseButton? _dragging;
    private bool _panning;
    private Point _last;

    public ViewerWindow(ViewerViewModel vm)
    {
        _vm = vm;
        DataContext = vm;
        InitializeComponent();
        _vm.FrameReady += OnFrame;
    }

    private DpiScale Dpi => VisualTreeHelper.GetDpi(this);

    /* ---------- frames ---------- */

    private void OnViewportSizeChanged(object sender, SizeChangedEventArgs e)
    {
        var dpi = Dpi;
        _vm.SetViewport((int)Math.Round(Viewport.ActualWidth * dpi.DpiScaleX), (int)Math.Round(Viewport.ActualHeight * dpi.DpiScaleY));
    }

    private void OnFrame(RenderedImage image)
    {
        int w = image.Width, h = image.Height;
        // The renderer gives RGBA; WPF wants BGRA. Swap red and blue in place (the buffer is ours until the next frame).
        var pixels = MemoryMarshal.Cast<byte, uint>(image.Rgba.AsSpan(0, w * h * 4));
        for (int i = 0; i < pixels.Length; i++)
        {
            uint v = pixels[i];
            pixels[i] = (v & 0xFF00FF00u) | ((v & 0xFFu) << 16) | ((v >> 16) & 0xFFu);
        }

        if (_bitmap is null || _bitmap.PixelWidth != w || _bitmap.PixelHeight != h)
        {
            var dpi = Dpi;
            _bitmap = new WriteableBitmap(w, h, 96 * dpi.DpiScaleX, 96 * dpi.DpiScaleY, PixelFormats.Bgra32, null);
            FrameImage.Source = _bitmap;
        }
        _bitmap.WritePixels(new Int32Rect(0, 0, w, h), image.Rgba, w * 4, 0);
    }

    /* ---------- mouse: left-drag turns, right-drag (or Shift + left) pans, the wheel zooms ---------- */

    private void OnViewportMouseDown(object sender, MouseButtonEventArgs e)
    {
        if (_dragging is not null) return;
        _dragging = e.ChangedButton;
        _panning = e.ChangedButton is MouseButton.Right or MouseButton.Middle || Keyboard.Modifiers.HasFlag(ModifierKeys.Shift);
        _last = e.GetPosition(Viewport);
        Viewport.Focus();
        Viewport.CaptureMouse();
        e.Handled = true;
    }

    private void OnViewportMouseMove(object sender, MouseEventArgs e)
    {
        if (_dragging is null) return;
        var position = e.GetPosition(Viewport);
        var dpi = Dpi;
        double dx = (position.X - _last.X) * dpi.DpiScaleX, dy = (position.Y - _last.Y) * dpi.DpiScaleY;
        _last = position;
        if (dx == 0 && dy == 0) return;
        if (_panning) _vm.Pan(dx, dy);
        else _vm.Rotate(dx, dy);
    }

    private void OnViewportMouseUp(object sender, MouseButtonEventArgs e)
    {
        if (e.ChangedButton != _dragging) return;
        _dragging = null;
        Viewport.ReleaseMouseCapture();
        e.Handled = true;   // no context menu after a right-drag
    }

    private void OnViewportLostCapture(object sender, MouseEventArgs e) => _dragging = null;

    private void OnViewportMouseWheel(object sender, MouseWheelEventArgs e)
    {
        _vm.Zoom(e.Delta);
        e.Handled = true;
    }

    private void OnKeyDown(object sender, KeyEventArgs e)
    {
        if (e.OriginalSource is System.Windows.Controls.TextBox or System.Windows.Controls.ComboBox) return;
        if (e.Key == Key.R)
        {
            _vm.ResetView();
            e.Handled = true;
        }
    }

    /* ---------- dropping a file ---------- */

    private void OnDragOver(object sender, DragEventArgs e)
    {
        e.Effects = e.Data.GetData(DataFormats.FileDrop) is string[] { Length: > 0 } files && File.Exists(files[0])
            ? DragDropEffects.Copy
            : DragDropEffects.None;
        e.Handled = true;
    }

    private async void OnDrop(object sender, DragEventArgs e)
    {
        if (e.Data.GetData(DataFormats.FileDrop) is string[] { Length: > 0 } files && File.Exists(files[0]))
            await _vm.OpenPathAsync(files[0]);
    }

    protected override void OnClosed(EventArgs e)
    {
        _vm.FrameReady -= OnFrame;
        _vm.Close();   // frees the model and the graphics device; the next open starts fresh
        base.OnClosed(e);
    }
}
