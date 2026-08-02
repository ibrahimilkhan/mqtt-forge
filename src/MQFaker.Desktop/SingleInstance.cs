using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;

namespace MQFaker.Desktop;

// File lock, not the pipe: on macOS/Linux a second named-pipe bind silently replaces rather
// than failing, so FileShare.None's flock() is the real cross-process lock
public sealed class SingleInstance : IDisposable
{
    private const string Doorbell = "focus";

    private readonly string _name;
    private readonly object _gate = new();
    // Owned here so Dispose() can end the signal loop without relying on the caller's token
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
            // FileShare.None triggers the real flock() on Unix; FileShare.Delete alone was
            // tested and does not conflict across processes
            lockFile = new FileStream(LockFilePath(name), FileMode.OpenOrCreate,
                FileAccess.ReadWrite, FileShare.None);
        }
        catch (IOException)
        {
            // Another instance holds the lock
            return null;
        }

        try
        {
            return new SingleInstance(name, lockFile, CreateServer(name));
        }
        catch (IOException)
        {
            // Lock succeeded but pipe creation failed (e.g. stale pipe from a crash); don't report partial success
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
            // Links both tokens so Dispose() alone can end the loop, not just caller cancellation
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
                    // Dispose() tore down the server mid-wait
                    return;
                }
                catch (IOException)
                {
                    // Caller hung up mid-message; not worth ending the loop
                }

                // Swap under the same gate as Dispose(), so a race can't leave an orphaned replacement server
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

    // macOS caps Unix-socket paths at 104 bytes; hashed to a fixed short name regardless of
    // input length (a stray pipe file can't be reverse-mapped to its name by inspection)
    private static string PipeName(string name)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(name));
        return "mqf-" + Convert.ToHexString(hash)[..16];
    }

    // Temp dir: a per-user runtime lock, not a document — no permission setup, safe to lose on reboot
    private static string LockFilePath(string name) =>
        Path.Combine(Path.GetTempPath(), PipeName(name) + ".lock");

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
            // Cancel before dispose: yields a graceful OperationCanceledException rather than
            // racing an ObjectDisposedException (both handled, but this is tidier)
            _disposalCts.Cancel();
            _server.Dispose();
        }

        _disposalCts.Dispose();

        // Deletes before releasing the lock: Unix locks bind to the inode, not the path, so
        // deleting after a racing TryAcquire recreates the path would delete their file instead
        try
        {
            File.Delete(LockFilePath(_name));
        }
        catch (IOException)
        {
            // Best effort: FileShare.None means our own still-open handle can block this delete
        }
        catch (UnauthorizedAccessException)
        {
        }

        _lockFile.Dispose();
    }
}
