namespace Xandrite.Loading;

/// <summary>A model file that cannot be used. The message is written to be shown to the person as it is.</summary>
public sealed class ModelFormatException : Exception
{
    public ModelFormatException(string message) : base(message) { }

    public ModelFormatException(string message, Exception inner) : base(message, inner) { }
}
