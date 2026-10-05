using System.Reflection;
using MqttForge.Desktop;

namespace MqttForge.UnitTests.Desktop;

// Windows builds a WebView2 out of COM, and COM hands a browser only to an STA thread. Photino
// reports nothing when the environment fails to build — the window opens, sizes itself, accepts a
// URL and stays black — so the only cheap warning anyone gets is this one. It runs on every
// platform on purpose: macOS and Linux draw with WebKit and have no apartments, which means a
// developer who never boots Windows would otherwise not learn about the regression until a user did.
public sealed class DesktopEntryPointTests
{
    // Program is internal and sits in the global namespace, and nothing in the repo grants
    // InternalsVisibleTo, so reflection through a public type in the same assembly is the only door.
    // LanAddress is the safest one to knock on: its signature touches nothing but the BCL, so
    // reaching it loads no Photino and no ASP.NET Core. The assembly is called MQTTForge rather than
    // MqttForge.Desktop — the csproj overrides AssemblyName.
    private static readonly Assembly Desktop = typeof(LanAddress).Assembly;

    [Fact]
    public void Asks_for_an_sta_apartment()
    {
        var entryPoint = Desktop.EntryPoint;

        Assert.NotNull(entryPoint);
        // The attribute has to sit on Assembly.EntryPoint itself, not merely somewhere in the file:
        // an async Main keeps [STAThread] on a method the runtime never calls.
        Assert.True(entryPoint.IsDefined(typeof(STAThreadAttribute), inherit: false),
            "the entry point no longer asks for STA - WebView2 will not initialise and the window opens black");
    }

    // Narrower than it sounds, and deliberately so: this catches somebody writing [MTAThread] out
    // loud, nothing more. A process can and does run MTA with no such attribute anywhere - that is
    // precisely what an async Main does - so this is not the guard for that; the one above is.
    [Fact]
    public void Never_declares_the_mta_apartment()
    {
        var entryPoint = Desktop.EntryPoint;

        Assert.NotNull(entryPoint);
        Assert.False(entryPoint.IsDefined(typeof(MTAThreadAttribute), inherit: false));
    }

    [Fact]
    public void Stays_synchronous_so_the_apartment_survives()
    {
        var entryPoint = Desktop.EntryPoint;

        Assert.NotNull(entryPoint);

        // Awaiting undoes [STAThread] as quietly as omitting it: with no synchronization context the
        // continuation resumes on a thread-pool thread, which is MTA again, and the window is then
        // touched from the wrong apartment.
        //
        // The name is the whole test, and it is worth knowing why nothing else here would do. For an
        // async Main the compiler emits a synchronous shim and points the entry point at the shim, so
        // the return type reads int and carries no AsyncStateMachineAttribute either way — asserting
        // on those looks like corroboration and is in fact unconditionally true, which is worse than
        // no assertion at all. Only the shim's name gives it away: <Main> or <Main>$, and angle
        // brackets are illegal in an identifier anyone could have typed.
        //
        // This still cannot see an entry point that stays sync and hands its body to an async helper.
        // Nothing in metadata can. Program.cs asserts its own apartment for that one.
        Assert.Equal("Main", entryPoint.Name);
    }
}
