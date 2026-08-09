using MqttForge.Desktop;

namespace MqttForge.UnitTests.Desktop;

public sealed class SingleInstanceTests
{
    // A unique name per test; the pipe name is process-global on every platform.
    private static string UniqueName() => $"mqttforge-test-{Guid.NewGuid():N}";

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
        // Named pipes are Unix-socket-file-backed only on macOS/Linux; this leak check doesn't apply on Windows
        if (OperatingSystem.IsWindows()) return;

        var tempDir = Path.GetTempPath();
        var before = Directory.GetFiles(tempDir, "CoreFxPipe_mqf-*");

        var name = UniqueName();
        var holder = SingleInstance.TryAcquire(name)!;
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        // Keeps the test's await from hijacking the background loop's thread
        var signalled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        // Disposing inside the callback pins the race on the loop's own thread, reproducing it
        // deterministically instead of relying on scheduler luck
        holder.ListenForSignals(() =>
        {
            holder.Dispose();
            signalled.TrySetResult();
        }, cts.Token);

        Assert.True(SingleInstance.SignalExisting(name, TimeSpan.FromSeconds(5)));
        await signalled.Task.WaitAsync(TimeSpan.FromSeconds(5));

        // Lets the loop finish its post-callback work before checking; a leaked file never disappears on its own
        await Task.Delay(300);

        var leaked = Directory.GetFiles(tempDir, "CoreFxPipe_mqf-*").Except(before).ToArray();
        Assert.Empty(leaked);
    }
}
