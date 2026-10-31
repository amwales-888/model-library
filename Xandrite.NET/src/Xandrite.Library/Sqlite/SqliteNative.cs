using System.Reflection;
using System.Runtime.InteropServices;

namespace Xandrite.Library.Sqlite;

/// <summary>
/// The part of the SQLite C API the library uses (https://sqlite.org/c3ref/intro.html).
///
/// Which SQLite is loaded:
///  - Windows: a sqlite3.dll placed next to the app, if there is one (for shipping a newer SQLite built from the
///    amalgamation), otherwise winsqlite3.dll, the copy that is part of Windows 10 and 11.
///  - Linux / macOS (tests only): the system libsqlite3.
/// All strings are UTF-8.
/// </summary>
internal static unsafe partial class SqliteNative
{
    private const string Lib = "xandrite-sqlite3";   // a placeholder name; the resolver below picks the real library

    public const int SQLITE_OK = 0;
    public const int SQLITE_BUSY = 5;
    public const int SQLITE_ROW = 100;
    public const int SQLITE_DONE = 101;

    public const int SQLITE_OPEN_READWRITE = 0x2;
    public const int SQLITE_OPEN_CREATE = 0x4;
    public const int SQLITE_OPEN_URI = 0x40;
    public const int SQLITE_OPEN_MEMORY = 0x80;
    public const int SQLITE_OPEN_FULLMUTEX = 0x10000;

    public const int SQLITE_INTEGER = 1;
    public const int SQLITE_FLOAT = 2;
    public const int SQLITE_TEXT = 3;
    public const int SQLITE_BLOB = 4;
    public const int SQLITE_NULL = 5;

    /// <summary>SQLITE_TRANSIENT: SQLite copies bound text before the call returns.</summary>
    public static readonly nint Transient = -1;

    static SqliteNative() => NativeLibrary.SetDllImportResolver(typeof(SqliteNative).Assembly, Resolve);

    /// <summary>Makes sure the resolver is registered before the first call.</summary>
    public static void EnsureLoaded() { }

    private static nint Resolve(string name, Assembly assembly, DllImportSearchPath? searchPath)
    {
        if (name != Lib) return 0;
        string[] candidates = OperatingSystem.IsWindows()
            ? [Path.Combine(AppContext.BaseDirectory, "sqlite3.dll"), "winsqlite3.dll"]
            : OperatingSystem.IsMacOS()
                ? ["libsqlite3.dylib"]
                : ["libsqlite3.so.0", "libsqlite3.so"];
        foreach (var candidate in candidates)
        {
            if (Path.IsPathRooted(candidate) && !File.Exists(candidate)) continue;
            if (NativeLibrary.TryLoad(candidate, assembly, DllImportSearchPath.System32 | DllImportSearchPath.SafeDirectories, out nint handle)
                || NativeLibrary.TryLoad(candidate, out handle))
                return handle;
        }
        throw new DllNotFoundException("SQLite was not found (tried " + string.Join(", ", candidates) + ").");
    }

    [LibraryImport(Lib)] public static partial int sqlite3_libversion_number();
    [LibraryImport(Lib)] public static partial byte* sqlite3_libversion();
    [LibraryImport(Lib)] public static partial int sqlite3_open_v2(byte* filename, nint* db, int flags, byte* vfs);
    [LibraryImport(Lib)] public static partial int sqlite3_close_v2(nint db);
    [LibraryImport(Lib)] public static partial byte* sqlite3_errmsg(nint db);
    [LibraryImport(Lib)] public static partial int sqlite3_extended_errcode(nint db);
    [LibraryImport(Lib)] public static partial int sqlite3_busy_timeout(nint db, int ms);
    [LibraryImport(Lib)] public static partial int sqlite3_exec(nint db, byte* sql, nint callback, nint arg, byte** errmsg);
    [LibraryImport(Lib)] public static partial void sqlite3_free(void* p);
    [LibraryImport(Lib)] public static partial int sqlite3_changes(nint db);

    [LibraryImport(Lib)] public static partial int sqlite3_prepare_v2(nint db, byte* sql, int bytes, nint* stmt, byte** tail);
    [LibraryImport(Lib)] public static partial int sqlite3_finalize(nint stmt);
    [LibraryImport(Lib)] public static partial int sqlite3_reset(nint stmt);
    [LibraryImport(Lib)] public static partial int sqlite3_clear_bindings(nint stmt);
    [LibraryImport(Lib)] public static partial int sqlite3_step(nint stmt);

    [LibraryImport(Lib)] public static partial int sqlite3_bind_null(nint stmt, int index);
    [LibraryImport(Lib)] public static partial int sqlite3_bind_int64(nint stmt, int index, long value);
    [LibraryImport(Lib)] public static partial int sqlite3_bind_double(nint stmt, int index, double value);
    [LibraryImport(Lib)] public static partial int sqlite3_bind_text(nint stmt, int index, byte* text, int bytes, nint destructor);
    [LibraryImport(Lib)] public static partial int sqlite3_bind_parameter_count(nint stmt);

    [LibraryImport(Lib)] public static partial int sqlite3_column_count(nint stmt);
    [LibraryImport(Lib)] public static partial int sqlite3_column_type(nint stmt, int column);
    [LibraryImport(Lib)] public static partial long sqlite3_column_int64(nint stmt, int column);
    [LibraryImport(Lib)] public static partial double sqlite3_column_double(nint stmt, int column);
    [LibraryImport(Lib)] public static partial byte* sqlite3_column_text(nint stmt, int column);
    [LibraryImport(Lib)] public static partial int sqlite3_column_bytes(nint stmt, int column);
    [LibraryImport(Lib)] public static partial byte* sqlite3_column_name(nint stmt, int column);
}
