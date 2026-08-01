using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;

namespace MQFaker.Desktop;

// The pipe is both the lock and the doorbell: whoever creates it is the running instance,
// and whoever cannot create it rings to ask that the existing window be brought forward.
// One mechanism instead of a lock file plus a separate channel.
public sealed class SingleInstance : IDisposable
{
    private const string Doorbell = "focus";

    private readonly string _name;
    private readonly object _gate = new();
    // Owned by this instance so Dispose() can end the signal loop on its own, instead of relying
    // on the caller to have cancelled its token first (that used to be the caller's job, and the
    // loop would happily build a brand-new server after Dispose() had already run).
    private readonly CancellationTokenSource _disposalCts = new();
    private NamedPipeServerStream _server;
    private bool _disposed;

    private SingleInstance(string name, NamedPipeServerStream server)
    {
        _name = name;
        _server = server;
    }

    public static SingleInstance? TryAcquire(string name)
    {
        try
        {
            return new SingleInstance(name, CreateServer(name));
        }
        catch (IOException)
        {
            // Another instance already holds the single allowed server slot.
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
    }
}
