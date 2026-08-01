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
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    await _server.WaitForConnectionAsync(ct);
                    using (var reader = new StreamReader(_server, leaveOpen: true))
                        if (await reader.ReadLineAsync(ct) == Doorbell) onSignal();
                }
                catch (OperationCanceledException)
                {
                    return;
                }
                catch (IOException)
                {
                    // A caller that hung up mid-message is not worth tearing the loop down for.
                }

                // A server stream serves one connection; the next caller needs a fresh one.
                _server.Dispose();
                if (ct.IsCancellationRequested) return;
                _server = CreateServer(_name);
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
    // or how long the platform's temp path happens to be.
    private static string PipeName(string name)
    {
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(name));
        return "mqf-" + Convert.ToHexString(hash)[..16];
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _server.Dispose();
    }
}
