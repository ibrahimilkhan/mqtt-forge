using MQFaker.Desktop;

namespace MQFaker.UnitTests.Desktop;

public sealed class SingleInstanceTests
{
    // A unique name per test; the pipe name is process-global on every platform.
    private static string UniqueName() => $"mqfaker-test-{Guid.NewGuid():N}";

    [Fact]
    public void First_caller_acquires_the_lock()
    {
        var name = UniqueName();

        using var first = SingleInstance.TryAcquire(name);

        Assert.NotNull(first);
    }

    [Fact]
    public void Second_caller_is_refused_while_the_first_holds_it()
    {
        var name = UniqueName();
        using var first = SingleInstance.TryAcquire(name);

        using var second = SingleInstance.TryAcquire(name);

        Assert.Null(second);
    }

    [Fact]
    public void Lock_is_released_when_the_holder_is_disposed()
    {
        var name = UniqueName();
        SingleInstance.TryAcquire(name)!.Dispose();

        using var again = SingleInstance.TryAcquire(name);

        Assert.NotNull(again);
    }

    [Fact]
    public async Task Signal_reaches_the_holder()
    {
        var name = UniqueName();
        using var holder = SingleInstance.TryAcquire(name)!;
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var signalled = new TaskCompletionSource();
        holder.ListenForSignals(() => signalled.TrySetResult(), cts.Token);

        var delivered = SingleInstance.SignalExisting(name, TimeSpan.FromSeconds(5));

        Assert.True(delivered);
        await signalled.Task.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public void Signalling_nobody_reports_failure()
    {
        Assert.False(SingleInstance.SignalExisting(UniqueName(), TimeSpan.FromMilliseconds(500)));
    }

    [Fact]
    public async Task Dispose_leaves_no_stray_pipe_file_after_a_signal_was_serviced()
    {
        // NamedPipeServerStream is backed by a Unix domain socket file on macOS/Linux; on Windows
        // a named pipe is a kernel object with nothing on disk to check, so this regression check
        // (which inspects the temp directory for a leaked socket file) only applies on Unix.
        if (OperatingSystem.IsWindows()) return;

        var tempDir = Path.GetTempPath();
        var before = Directory.GetFiles(tempDir, "CoreFxPipe_mqf-*");

        var name = UniqueName();
        var holder = SingleInstance.TryAcquire(name)!;
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        // RunContinuationsAsynchronously keeps the test's own await from being hijacked onto the
        // background loop's thread ahead of the loop's own remaining statements below.
        var signalled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        // Dispose from inside the signal callback: this runs synchronously on the background
        // loop's own thread, exactly where the loop is about to tear down the just-used server
        // and build a replacement. Pinning Dispose() there reproduces the reported race every
        // time, instead of hoping the scheduler happens to interleave it at just the wrong moment
        // (the caller's own token, cts above, is deliberately never cancelled first, mirroring the
        // ordinary `using var holder = SingleInstance.TryAcquire(...)` pattern from the report).
        holder.ListenForSignals(() =>
        {
            holder.Dispose();
            signalled.TrySetResult();
        }, cts.Token);

        Assert.True(SingleInstance.SignalExisting(name, TimeSpan.FromSeconds(5)));
        await signalled.Task.WaitAsync(TimeSpan.FromSeconds(5));

        // Give the loop's own thread time to finish whatever runs right after the signal callback
        // returns (disposing the just-used server and, on the buggy code path, constructing an
        // unguarded replacement) before inspecting the temp directory. A leaked file never goes
        // away on its own, so once this window has passed, a single check is enough.
        await Task.Delay(300);

        var leaked = Directory.GetFiles(tempDir, "CoreFxPipe_mqf-*").Except(before).ToArray();
        Assert.Empty(leaked);
    }
}
