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
}
