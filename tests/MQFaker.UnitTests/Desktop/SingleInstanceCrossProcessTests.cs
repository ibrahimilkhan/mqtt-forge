using System.Diagnostics;
using MQFaker.Desktop;

namespace MQFaker.UnitTests.Desktop;

// The regression this class exists to catch cannot be reproduced inside one process: .NET's own
// in-process bookkeeping already refuses a second NamedPipeServerStream for a name a live one in
// the same process is using, regardless of whether SingleInstance's actual cross-process locking
// primitive works at all. That is exactly how the original pipe-only implementation passed every
// test in SingleInstanceTests.cs while still letting two real, independent processes both
// acquire the "lock". Only two genuinely separate OS processes exercise what TryAcquire has to
// guarantee, so this class launches a real second process (MQFaker.SingleInstanceProbe) rather
// than a second SingleInstance in-process.
public sealed class SingleInstanceCrossProcessTests
{
    private static string UniqueName() => $"mqfaker-xproc-test-{Guid.NewGuid():N}";

    private static readonly string ProbePath = Path.Combine(AppContext.BaseDirectory,
        "MQFaker.SingleInstanceProbe.dll");

    [Fact]
    public async Task Second_process_is_refused_while_a_real_first_process_holds_the_lock()
    {
        Assert.True(File.Exists(ProbePath),
            $"probe not found at {ProbePath} - build MQFaker.SingleInstanceProbe first");

        var name = UniqueName();
        using var first = StartProbe(name);
        try
        {
            Assert.Equal("ACQUIRED", await ReadLineAsync(first, TimeSpan.FromSeconds(10)));

            using var second = StartProbe(name);
            try
            {
                Assert.Equal("REFUSED", await ReadLineAsync(second, TimeSpan.FromSeconds(10)));

                // A refused instance must exit promptly on its own - it must not be left
                // running (e.g. holding a second listener) just because it lost the race.
                Assert.True(second.WaitForExit((int)TimeSpan.FromSeconds(10).TotalMilliseconds));
                Assert.Equal(1, second.ExitCode);
            }
            finally
            {
                await StopProbe(second);
            }
        }
        finally
        {
            await StopProbe(first);
        }
    }

    [Fact]
    public async Task A_second_process_can_acquire_it_once_the_first_releases_it()
    {
        var name = UniqueName();
        using var first = StartProbe(name);
        try
        {
            Assert.Equal("ACQUIRED", await ReadLineAsync(first, TimeSpan.FromSeconds(10)));
        }
        finally
        {
            await StopProbe(first);
        }

        using var second = StartProbe(name);
        try
        {
            // Proves the fix is a real lock, not a one-shot flag: releasing genuinely frees the
            // name for the next real process, the same way a relaunch after quitting must work.
            Assert.Equal("ACQUIRED", await ReadLineAsync(second, TimeSpan.FromSeconds(10)));
        }
        finally
        {
            await StopProbe(second);
        }
    }

    private static Process StartProbe(string name)
    {
        var psi = new ProcessStartInfo
        {
            FileName = "dotnet",
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };
        psi.ArgumentList.Add(ProbePath);
        psi.ArgumentList.Add(name);

        var process = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start the probe process.");
        return process;
    }

    private static async Task<string?> ReadLineAsync(Process process, TimeSpan timeout) =>
        await process.StandardOutput.ReadLineAsync().WaitAsync(timeout);

    // Cleans up regardless of what the test above asserted: a failed assertion must not leave a
    // probe process (and the lock/listener it holds) running behind it.
    private static async Task StopProbe(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                // Politely ask it to let go of the lock first - it is blocked on Console.ReadLine().
                try
                {
                    await process.StandardInput.WriteLineAsync("release");
                    process.StandardInput.Close();
                }
                catch (IOException)
                {
                    // Already gone.
                }

                if (!process.WaitForExit((int)TimeSpan.FromSeconds(5).TotalMilliseconds))
                    process.Kill(entireProcessTree: true);
            }
        }
        finally
        {
            process.Dispose();
        }
    }
}
