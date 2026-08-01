using System.Net;
using System.Net.Sockets;

namespace MQFaker.Desktop;

// The desktop app cannot assume 5169 is free: the user may be running the Docker image
// at the same time. Insisting on a fixed port would surface an "address already in use"
// crash the user has no way to act on.
public static class PortFinder
{
    public static int FirstFree(int candidate, int attempts = 50)
    {
        for (var port = candidate; port < candidate + attempts; port++)
            if (IsFree(port)) return port;

        throw new IOException(
            $"No free port between {candidate} and {candidate + attempts - 1}.");
    }

    private static bool IsFree(int port)
    {
        try
        {
            using var listener = new TcpListener(IPAddress.Any, port);
            listener.Start();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }
}
