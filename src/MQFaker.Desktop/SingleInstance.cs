using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;

namespace MQFaker.Desktop;

// The lock and the doorbell are deliberately two different mechanisms now. They used to
// both be the named pipe: whoever created it held the lock, and whoever could not create it
// rang the existing one instead. That worked on Windows, where a second
// NamedPipeServerStream for the same name is genuinely refused - but on macOS/Linux a named
// pipe is backed by a Unix domain socket file, and bind() on an already-bound path silently
// unlinks and replaces it rather than failing. Two independent OS processes both "created"
// the pipe there; neither ever saw a conflict. A FileStream opened without sharing Read or
// Write access does not have that hole: .NET implements it over flock() on Unix, which
// conflicts across processes exactly like the sharing violation it produces on Windows. So
// the file is the lock, and the pipe goes back to doing only what it is actually good at:
// signalling.
public sealed class SingleInstance : IDisposable
{
    private const string Doorbell = "focus";

    private readonly string _name;
    private readonly object _gate = new();
    // Owned by this instance so Dispose() can end the signal loop on its own, instead of relying
    // on the caller to have cancelled its token first (that used to be the caller's job, and the
    // loop would happily build a brand-new server after Dispose() had already run).
    private readonly CancellationTokenSource _disposalCts = new();
    private readonly FileStream _lockFile;
    private NamedPipeServerStream _server;
    private bool _disposed;

    private SingleInstance(string name, FileStream lockFile, NamedPipeServerStream server)
    {
        _name = name;
        _lockFile = lockFile;
        _server = server;
    }

    public static SingleInstance? TryAcquire(string name)
    {
        FileStream lockFile;
        try
        {
            // FileShare.None is what actually makes this cross-process: .NET only takes the
            // real OS-level advisory lock on Unix (fcntl/flock) when the requested share
            // excludes Read and Write entirely. FileShare.Delete alone was tried first and
            // measured to NOT conflict across processes - two probes both reported ACQUIRED -
            // so unlinking our own file in Dispose() (see the comment there) has to work
            // around FileShare.None instead of leaning on FileShare.Delete for that.
            lockFile = new FileStream(LockFilePath(name), FileMode.OpenOrCreate,
                FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException)
        {
            // Another instance already holds the lock file.
            return null;
        }

        try
        {
            return new SingleInstance(name, lockFile, CreateServer(name));
        }
        catch (IOException)
        {
            // The lock file said we were alone, but the pipe disagreed (e.g. a stale pipe
            // file from a crash the OS has not reclaimed yet). Do not report success half way.
            lockFile.Dispose();
            return null;
        }
    }

    public static bool SignalExisting(string name, TimeSpan timeout)
    {
        try
        {
            using var client = new NamedPipeClientStream(".", PipeName(name), PipeDirection.Out);
            client.Connect((int)timeout.TotalMilliseconds);
            using var writer = new StreamWriter(client) { AutoFlush = true };
            writer.WriteLine(Doorbell);
            return true;
        }
        catch (TimeoutException)
        {
            return false;
        }
        catch (IOException)
        {
            return false;
        }
    }

    public void ListenForSignals(Action onSignal, CancellationToken ct)
    {
        _ = Task.Run(async () =>
        {
            // Linking means either the caller cancelling or Dispose() cancelling ends the loop;
            // previously only the caller's token was honoured, so Dispose() alone did nothing.
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct, _disposalCts.Token);
            var token = linked.Token;

            while (!token.IsCancellationRequested)
            {
                NamedPipeServerStream server;
                lock (_gate)
                {
                    if (_disposed) return;
                    server = _server;
                }

                try
                {
                    await server.WaitForConnectionAsync(token);
                    using (var reader = new StreamReader(server, leaveOpen: true))
                        if (await reader.ReadLineAsync(token) == Doorbell) onSignal();
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (ObjectDisposedException)
                {
                    // Dispose() tore down the server we were waiting on while we were waiting on it.
                    return;
                }
                catch (IOException)
                {
                    // A caller that hung up mid-message is not worth tearing the loop down for.
                }

                // A server stream serves one connection; the next caller needs a fresh one. Do the
                // swap under the same gate Dispose() uses, so a Dispose() that runs between the two
                // lines above and here can never be followed by a replacement server nothing owns.
                lock (_gate)
                {
                    if (_disposed) return;
                    server.Dispose();
                    _server = CreateServer(_name);
                }
            }
        }, ct);
    }

    private static NamedPipeServerStream CreateServer(string name) =>
        new(PipeName(name), PipeDirection.In, maxNumberOfServerInstances: 1,
            PipeTransmissionMode.Byte, PipeOptions.Asynchronous);

    // A caller-supplied name can be arbitrarily long (the tests use GUID-suffixed names).
    // macOS backs named pipes with Unix domain sockets, whose path is capped at 104 bytes,
    // and the OS temp directory alone can already eat half that budget. Hashing to a fixed,
    // short name keeps every pipe path well under the limit regardless of what is passed in
    // or how long the platform's temp path happens to be. The cost: a pipe file stuck in the
    // OS temp directory (e.g. after a crash) can no longer be matched back to its logical name
    // by inspection alone — recompute this hash from the candidate name to identify it.
    private static string PipeName(string name)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(name));
        return "mqf-" + Convert.ToHexString(hash)[..16];
    }

    // Same hashing, and the same reason: this is a per-user runtime lock, not a document, so
    // the OS temp directory (already used for the pipe) is the right home for it - no
    // permission setup, and it is on every platform's list of things safe to lose across a
    // reboot, which is exactly this file's lifetime.
    private static string LockFilePath(string name) =>
        Path.Combine(Path.GetTempPath(), PipeName(name) + ".lock");

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            // Cancel before disposing the server: a loop blocked in WaitForConnectionAsync then
            // sees a graceful OperationCanceledException rather than racing to observe the dispose
            // as an ObjectDisposedException instead (both are handled, but this is the tidier path).
            _disposalCts.Cancel();
            _server.Dispose();
        }

        _disposalCts.Dispose();

        // Unlink before releasing the lock, not after. Unix does not tie an advisory lock to a
        // path, only to the inode a handle points at, so if a racing TryAcquire opened a
        // recreated path first and then this delete ran, it would delete THEIR file while this
        // handle's lock (on the old, now-orphaned inode) would linger, unable to be reacquired.
        // Deleting first while we still hold the lock means nobody else can be looking at this
        // path yet, so there is nothing to accidentally delete out from under.
        try
        {
            File.Delete(LockFilePath(_name));
        }
        catch (IOException)
        {
            // Best effort: the file's only job was to hold the lock we already released via
            // the flock/sharing-violation mechanism itself, not to be reliably absent afterwards.
        }
        catch (UnauthorizedAccessException)
        {
        }

        _lockFile.Dispose();
    }
}
