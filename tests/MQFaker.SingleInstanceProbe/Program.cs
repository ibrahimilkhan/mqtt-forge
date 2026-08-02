using MQFaker.Desktop;

// Minimal by design: this process exists only so SingleInstanceCrossProcessTests can launch a
// genuinely separate OS process and observe whether SingleInstance.TryAcquire refuses it while
// another real process holds the lock - something no in-process test can exercise, since .NET's
// own bookkeeping already refuses a second in-process pipe server regardless of what the
// cross-process locking primitive actually does.
if (args.Length != 1)
{
    Console.Error.WriteLine("usage: MQFaker.SingleInstanceProbe <lock-name>");
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

    // Hold the lock until the test says to let go, so the second process has a real window in
    // which the first is still holding it. Console.In.ReadLine() blocks until the test writes a
    // line to this process's redirected stdin (or closes it, which also unblocks with null).
    Console.In.ReadLine();
}

return 0;
