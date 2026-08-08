using System.Net;
using System.Net.Sockets;

namespace MQFaker.IntegrationTests.Support;

// A port that accepts TCP and then says nothing, so a connect attempt stays in flight for as
// long as a test needs it to — the one shape of broker that cannot end the attempt on its own.
public sealed class SilentTcpListener : IDisposable
{
    private readonly TcpListener _listener;
    private readonly List<TcpClient> _accepted = [];
    private readonly CancellationTokenSource _stopping = new();

    public SilentTcpListener()
    {
        _listener = new TcpListener(IPAddress.Loopback, 0);
        _listener.Start();
        Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
        _ = AcceptQuietlyAsync();
    }

    public int Port { get; }

    public void Dispose()
    {
        _stopping.Cancel();
        _listener.Dispose();
        foreach (var client in _accepted) client.Dispose();
        _stopping.Dispose();
    }

    // Held, not answered: a closed socket would hand the attempt a reason to give up.
    private async Task AcceptQuietlyAsync()
    {
        try
        {
            while (!_stopping.IsCancellationRequested)
                _accepted.Add(await _listener.AcceptTcpClientAsync(_stopping.Token));
        }
        catch (Exception e) when (e is OperationCanceledException or SocketException or ObjectDisposedException)
        {
            // Disposed on the way out of the test.
        }
    }
}
