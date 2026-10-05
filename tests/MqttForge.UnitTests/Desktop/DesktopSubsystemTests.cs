using MqttForge.Desktop;

namespace MqttForge.UnitTests.Desktop;

/// <summary>Proves the shipped executable asks Windows for a GUI, not a console.</summary>
// A console-subsystem executable makes Windows allocate and show a console window before a single
// line of managed code runs, so the app opens as two windows: the console first, the real one
// seconds later. Nothing in the program can close that console without it having been seen —
// FreeConsole runs far too late, and the flash is the whole complaint.
//
// The subsystem is decided entirely at build time by OutputType, which is why this reads the built
// file rather than anything at runtime: there is no API that reports "I would have been a console
// app", and the property itself is invisible to the running process.
public sealed class DesktopSubsystemTests
{
    // Built next to the tests by the existing ProjectReference to MqttForge.Desktop.
    private static readonly string AppPath = Path.Combine(AppContext.BaseDirectory, "MQTTForge.exe");

    private const ushort ImageSubsystemWindowsGui = 2;
    private const ushort ImageSubsystemWindowsCui = 3;

    [Fact]
    public void The_apphost_asks_for_the_windows_gui_subsystem()
    {
        // The apphost is only produced when building for Windows; elsewhere there is no PE file to
        // read and no console to open either, so there is nothing for this to say.
        if (!OperatingSystem.IsWindows()) return;

        Assert.True(File.Exists(AppPath), $"app not found at {AppPath} - build MqttForge.Desktop first");

        var subsystem = ReadSubsystem(AppPath);

        Assert.False(subsystem == ImageSubsystemWindowsCui,
            "MQTTForge.exe is a console-subsystem app - Windows will open a console window beside " +
            "the real one. Set <OutputType>WinExe</OutputType> in MqttForge.Desktop.csproj.");
        Assert.Equal(ImageSubsystemWindowsGui, subsystem);
    }

    /// <summary>Reads the Subsystem field out of a PE file's optional header.</summary>
    // Walked by hand rather than with System.Reflection.Metadata's PEReader, because the apphost
    // is a native executable: PEReader opens it, but its managed-metadata surface is the part
    // every example uses and none of it applies here. The offsets below are the PE spec's own and
    // are the same for PE32 and PE32+ — Subsystem sits ahead of the field whose width differs.
    private static ushort ReadSubsystem(string path)
    {
        using var file = File.OpenRead(path);
        using var reader = new BinaryReader(file);

        // e_lfanew: the DOS stub's pointer to the PE signature
        file.Seek(0x3C, SeekOrigin.Begin);
        var peHeader = reader.ReadUInt32();

        // 4 bytes of "PE\0\0" + the 20-byte COFF header, then 68 into the optional header
        file.Seek(peHeader + 4 + 20 + 68, SeekOrigin.Begin);
        return reader.ReadUInt16();
    }
}
