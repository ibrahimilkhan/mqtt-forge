using System.Net;
using System.Net.Sockets;

namespace MqttForge.Desktop;

// Desktop can't assume 5169 is free (e.g. Docker image running too); avoids an
// unrecoverable port-in-use crash
public static class PortFinder
{
    public static int FirstFree(int candidate, int attempts = 50) =>
        FirstFree(candidate, IPAddress.Any, attempts);

    // Lets DesktopBind re-check against loopback alone after a 0.0.0.0 bind is refused
    public static int FirstFree(int candidate, IPAddress bindAddress, int attempts = 50)
    {
        for (var port = candidate; port < candidate + attempts; port++)
            if (IsFree(port, bindAddress)) return port;

        throw new IOException(
            $"No free port between {candidate} and {candidate + attempts - 1}.");
    }

    private static bool IsFree(int port, IPAddress bindAddress)
    {
        try
        {
            using var listener = new TcpListener(bindAddress, port);
            listener.Start();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }
}
