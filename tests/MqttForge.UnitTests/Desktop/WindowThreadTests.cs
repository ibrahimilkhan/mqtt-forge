using MqttForge.Desktop;

namespace MqttForge.UnitTests.Desktop;

public sealed class WindowThreadTests
{
    // The bug this guards against: start-up grew a hosted service that really suspends
    // (AlertEngineHost.StartAsync reads the rules and the saved alarms), so `await`ing it
    // resumed the launch on a thread-pool thread and the window was never built.
    [Fact]
    public void Stays_on_the_launching_thread_while_start_up_suspends()
    {
        var launching = Environment.CurrentManagedThreadId;

        WindowThread.Wait(SuspendsBeforeReturning());

        Assert.Equal(launching, Environment.CurrentManagedThreadId);

        // A Delay rather than a completed Task: an await that finishes synchronously never
        // hops threads, which is exactly why the old shape worked until this branch.
        static async Task<int> SuspendsBeforeReturning()
        {
            await Task.Delay(20);
            return 7;
        }
    }

    [Fact]
    public void Hands_back_what_the_start_up_produced()
    {
        var result = WindowThread.Wait(Task.FromResult(7));

        Assert.Equal(7, result);
    }

    [Fact]
    public void Throws_a_start_up_failure_as_itself_rather_than_in_an_aggregate()
    {
        // .Result would hand back an AggregateException here, and DesktopBind's callers catch
        // SocketException/IOException by type.
        var failed = Task.FromException<int>(new IOException("no port"));

        var ex = Assert.Throws<IOException>(() => WindowThread.Wait(failed));

        Assert.Equal("no port", ex.Message);
    }

    [Fact]
    public void Lets_the_launching_thread_run_the_window()
    {
        WindowThread.EnsureStillOn(Environment.CurrentManagedThreadId);
    }

    [Fact]
    public void Refuses_to_run_the_window_on_any_other_thread()
    {
        // The failure the guard replaces is silent: the process stays up, the HTTP server keeps
        // answering, and only the window is missing. A throw says which thread took it.
        var somebodyElse = Environment.CurrentManagedThreadId + 1;

        var ex = Assert.Throws<InvalidOperationException>(() => WindowThread.EnsureStillOn(somebodyElse));

        Assert.Contains(somebodyElse.ToString(), ex.Message);
        Assert.Contains(Environment.CurrentManagedThreadId.ToString(), ex.Message);
    }
}
