namespace MqttForge.Desktop;

/// <summary>Keeps the launch on the one thread that is allowed to own the window.</summary>
// Photino builds its window on the platform's UI thread, and on macOS that is the thread the
// process started on and no other: WaitForClose() called from anywhere else marshals the window's
// construction onto the main dispatch queue with dispatch_sync and waits for it. If the first
// thread is meanwhile parked inside the async entry point's wait — which is exactly what it does
// while `await` is outstanding in a top-level program — nothing ever drains that queue and the two
// wait on each other for good.
//
// The failure has no error in it, which is the reason this class exists rather than a comment.
// The host is up and answering on its port, the log ends on a cheerful "Now listening on", and the
// only missing thing is the window. Nothing in that picture says "thread".
public static class WindowThread
{
    /// <summary>Waits for start-up work without letting the launch leave this thread.</summary>
    // `await` would put everything after it — Load, the signal listener, WaitForClose — on a
    // thread-pool thread, because a genuinely suspending start-up resumes wherever the pool says.
    // AlertEngineHost.StartAsync made start-up genuinely suspending; before it, the same await
    // happened to complete synchronously and the window opened on the strength of that accident.
    //
    // GetAwaiter().GetResult() and not .Result: a start-up that fails throws what it threw, which
    // is what an await here would have done and what a caller reading the exception expects. .Result
    // would hand back an AggregateException with the real one buried inside it.
    public static T Wait<T>(Task<T> startUp) => startUp.GetAwaiter().GetResult();

    /// <summary>Refuses the window loop to a thread that cannot serve it.</summary>
    // Cheap, and it turns the hang above into a line of text naming both threads. Called with the
    // id read before any start-up work, so an await sneaking in ahead of the window is caught at
    // the point where it would otherwise cost an afternoon.
    public static void EnsureStillOn(int launchThreadId)
    {
        var current = Environment.CurrentManagedThreadId;
        if (current == launchThreadId) return;

        throw new InvalidOperationException(
            $"The window must be opened on the thread the process started on ({launchThreadId}), " +
            $"but the launch reached it on thread {current}. Something before this point awaited " +
            "work that suspended; use WindowThread.Wait() for it instead of await.");
    }
}
