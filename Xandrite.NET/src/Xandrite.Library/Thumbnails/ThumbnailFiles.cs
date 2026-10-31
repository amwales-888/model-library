namespace Xandrite.Library.Thumbnails;

/// <summary>Writing thumbnail images safely: the queue and the viewer can both write the same model's image.</summary>
public static class ThumbnailFiles
{
    /// <summary>
    /// Writes the PNG to a temporary file of its own, then puts it in place under the real name, so no one ever sees
    /// half an image. Each write has its own temporary name (the queue and the viewer may write the same model at
    /// once), and the final rename is tried a few times, because on Windows it fails while someone is reading the old
    /// image (the grid loading it, for example).
    /// </summary>
    public static async Task WriteAsync(string final, byte[] png)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(final)!);
        string temporary = final + "." + Guid.NewGuid().ToString("N")[..8] + ".tmp";
        await File.WriteAllBytesAsync(temporary, png);
        try
        {
            for (int attempt = 1; ; attempt++)
            {
                try
                {
                    File.Move(temporary, final, overwrite: true);
                    return;
                }
                catch (Exception e) when (attempt < 10 && e is IOException or UnauthorizedAccessException)
                {
                    await Task.Delay(25 * attempt);
                }
            }
        }
        finally
        {
            try { File.Delete(temporary); } catch (IOException) { }   // only left over if every attempt failed
        }
    }
}
