using System.Runtime.InteropServices;
using System.Text;
using static Xandrite.Library.Sqlite.SqliteNative;

namespace Xandrite.Library.Sqlite;

public sealed class SqliteException(string message, int code) : Exception(message)
{
    /// <summary>The SQLite (extended) result code.</summary>
    public int Code { get; } = code;
}

/// <summary>
/// One SQLite database connection, with a cache of prepared statements.
///
/// Not thread-safe on its own: <see cref="LibraryDatabase"/> takes a lock around every use. (The connection is also
/// opened in SQLite's serialised mode as a second line of defence.)
/// </summary>
public sealed unsafe class SqliteConnection : IDisposable
{
    private nint _db;
    private readonly Dictionary<string, SqliteStatement> _statements = new(StringComparer.Ordinal);

    /// <summary>SQLite 3.24 (2018) brought "INSERT ... ON CONFLICT DO UPDATE", which the library's SQL uses.</summary>
    public const int MinimumVersion = 3_024_000;

    public SqliteConnection(string path)
    {
        SqliteNative.EnsureLoaded();
        int version = sqlite3_libversion_number();
        if (version < MinimumVersion)
            throw new SqliteException($"SQLite {Version} is too old; Xandrite needs 3.24 or newer.", 0);

        byte[] name = Utf8(path == ":memory:" ? ":memory:" : path);
        nint db;
        int rc;
        fixed (byte* p = name)
            rc = sqlite3_open_v2(p, &db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, null);
        if (rc != SQLITE_OK)
        {
            string message = db != 0 ? Message(db) : "out of memory";
            if (db != 0) sqlite3_close_v2(db);
            throw new SqliteException($"Could not open the library database {path}: {message}", rc);
        }
        _db = db;
        sqlite3_busy_timeout(_db, 5000);   // another process holding a lock: wait instead of failing at once
    }

    /// <summary>The SQLite version in use, for example "3.45.1".</summary>
    public static string Version
    {
        get
        {
            SqliteNative.EnsureLoaded();
            return Marshal.PtrToStringUTF8((nint)sqlite3_libversion()) ?? "?";
        }
    }

    private nint Handle => _db != 0 ? _db : throw new ObjectDisposedException(nameof(SqliteConnection));

    /// <summary>Runs one or more statements that return nothing (schema, pragmas, BEGIN/COMMIT).</summary>
    public void Exec(string sql)
    {
        byte[] text = Utf8(sql);
        byte* error = null;
        int rc;
        fixed (byte* p = text) rc = sqlite3_exec(Handle, p, 0, 0, &error);
        if (rc != SQLITE_OK)
        {
            string message = error != null ? Marshal.PtrToStringUTF8((nint)error) ?? "" : Message(_db);
            if (error != null) sqlite3_free(error);
            throw new SqliteException(message, rc);
        }
    }

    /// <summary>A prepared statement for the SQL, made once and reused.</summary>
    public SqliteStatement Prepare(string sql)
    {
        if (_statements.TryGetValue(sql, out var cached)) return cached;
        byte[] text = Utf8(sql);
        nint stmt;
        int rc;
        fixed (byte* p = text) rc = sqlite3_prepare_v2(Handle, p, text.Length, &stmt, null);
        if (rc != SQLITE_OK) throw new SqliteException(Message(_db) + " in: " + sql.Trim(), rc);
        var statement = new SqliteStatement(this, stmt);
        _statements[sql] = statement;
        return statement;
    }

    /// <summary>Runs a statement and returns how many rows it changed.</summary>
    public int Execute(string sql, params ReadOnlySpan<object?> args)
    {
        var statement = Prepare(sql);
        try
        {
            statement.Bind(args);
            statement.StepToEnd();
            return sqlite3_changes(_db);
        }
        finally
        {
            statement.Reset();
        }
    }

    /// <summary>Runs a query and maps every row.</summary>
    public List<T> Query<T>(string sql, Func<SqliteRow, T> map, params ReadOnlySpan<object?> args)
    {
        var statement = Prepare(sql);
        var results = new List<T>();
        try
        {
            statement.Bind(args);
            while (statement.Step()) results.Add(map(new SqliteRow(statement)));
            return results;
        }
        finally
        {
            statement.Reset();
        }
    }

    /// <summary>The first row mapped, or default if there is none.</summary>
    public T? QueryFirst<T>(string sql, Func<SqliteRow, T> map, params ReadOnlySpan<object?> args)
    {
        var statement = Prepare(sql);
        try
        {
            statement.Bind(args);
            return statement.Step() ? map(new SqliteRow(statement)) : default;
        }
        finally
        {
            statement.Reset();
        }
    }

    /// <summary>The first column of the first row as a number (0 if there is no row or it is NULL).</summary>
    public long Scalar(string sql, params ReadOnlySpan<object?> args) => QueryFirst(sql, r => r.GetInt64(0), args);

    internal string LastError => Message(_db);

    private static string Message(nint db) => Marshal.PtrToStringUTF8((nint)sqlite3_errmsg(db)) ?? "unknown error";

    internal static byte[] Utf8(string s)
    {
        var bytes = new byte[Encoding.UTF8.GetByteCount(s) + 1];   // zero-terminated
        Encoding.UTF8.GetBytes(s, bytes);
        return bytes;
    }

    public void Dispose()
    {
        foreach (var statement in _statements.Values) statement.Finalise();
        _statements.Clear();
        if (_db != 0)
        {
            sqlite3_close_v2(_db);
            _db = 0;
        }
    }
}

/// <summary>A prepared statement. Bind, step, read, reset.</summary>
public sealed unsafe class SqliteStatement
{
    private readonly SqliteConnection _connection;
    private nint _stmt;

    internal SqliteStatement(SqliteConnection connection, nint stmt)
    {
        _connection = connection;
        _stmt = stmt;
    }

    internal nint Handle => _stmt;

    public void Bind(ReadOnlySpan<object?> args)
    {
        sqlite3_clear_bindings(_stmt);
        int expected = sqlite3_bind_parameter_count(_stmt);
        if (args.Length != expected) throw new ArgumentException($"The statement takes {expected} values, {args.Length} were given.");
        for (int i = 0; i < args.Length; i++)
        {
            int index = i + 1;
            int rc = args[i] switch
            {
                null => sqlite3_bind_null(_stmt, index),
                string s => BindText(index, s),
                bool b => sqlite3_bind_int64(_stmt, index, b ? 1 : 0),
                int n => sqlite3_bind_int64(_stmt, index, n),
                long n => sqlite3_bind_int64(_stmt, index, n),
                uint n => sqlite3_bind_int64(_stmt, index, n),
                double d => sqlite3_bind_double(_stmt, index, d),
                float f => sqlite3_bind_double(_stmt, index, f),
                var other => throw new ArgumentException("Cannot store a " + other.GetType().Name + " in SQLite."),
            };
            if (rc != SQLITE_OK) throw new SqliteException(_connection.LastError, rc);
        }
    }

    private int BindText(int index, string value)
    {
        byte[] bytes = SqliteConnection.Utf8(value);
        fixed (byte* p = bytes) return sqlite3_bind_text(_stmt, index, p, bytes.Length - 1, SqliteNative.Transient);
    }

    /// <summary>Moves to the next row. False when there are no more.</summary>
    public bool Step()
    {
        int rc = sqlite3_step(_stmt);
        if (rc == SQLITE_ROW) return true;
        if (rc == SQLITE_DONE) return false;
        throw new SqliteException(_connection.LastError, rc);
    }

    public void StepToEnd()
    {
        while (Step()) { }
    }

    public void Reset() => sqlite3_reset(_stmt);

    internal void Finalise()
    {
        if (_stmt != 0) sqlite3_finalize(_stmt);
        _stmt = 0;
    }
}

/// <summary>The current row of a statement. Only valid until the statement moves on.</summary>
public readonly unsafe struct SqliteRow
{
    private readonly nint _stmt;

    internal SqliteRow(SqliteStatement statement) => _stmt = statement.Handle;

    public bool IsNull(int column) => sqlite3_column_type(_stmt, column) == SQLITE_NULL;

    public long GetInt64(int column) => sqlite3_column_int64(_stmt, column);

    public int GetInt32(int column) => (int)sqlite3_column_int64(_stmt, column);

    public double GetDouble(int column) => sqlite3_column_double(_stmt, column);

    public bool GetBoolean(int column) => sqlite3_column_int64(_stmt, column) != 0;

    public string GetString(int column) => GetStringOrNull(column) ?? "";

    public string? GetStringOrNull(int column)
    {
        byte* text = sqlite3_column_text(_stmt, column);
        if (text == null) return null;
        int length = sqlite3_column_bytes(_stmt, column);
        return Encoding.UTF8.GetString(text, length);
    }

    public long? GetInt64OrNull(int column) => IsNull(column) ? null : GetInt64(column);

    public int? GetInt32OrNull(int column) => IsNull(column) ? null : GetInt32(column);

    public double? GetDoubleOrNull(int column) => IsNull(column) ? null : GetDouble(column);
}
