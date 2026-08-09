using MqttForge.Desktop;

// Separate OS process so tests can observe cross-process locking; an in-process test can't,
// since .NET already refuses a second in-process pipe server regardless of the lock itself
if (args.Length != 1)
{
    Console.Error.WriteLine("usage: MqttForge.SingleInstanceProbe <lock-name>");
    return 2;
}

var instance = SingleInstance.TryAcquire(args[0]);
if (instance is null)
{
    Console.WriteLine("REFUSED");
    Console.Out.Flush();
    return 1;
}

using (instance)
{
    Console.WriteLine("ACQUIRED");
    Console.Out.Flush();

    // Holds the lock until the test signals via stdin (a closed pipe also unblocks, with null)
    Console.In.ReadLine();
}

return 0;
