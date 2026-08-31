using Microsoft.Extensions.Logging;

namespace MqttForge.IntegrationTests.Support;

/// <summary>An <see cref="ILogger{T}"/> that keeps what it was told, so a test can read the
/// sentence a person would read.</summary>
// The third of these in the repository, and the duplication is deliberate rather than an
// oversight: the unit project's copy and the engine fakes' copy are both in the other assembly,
// and a shared one would mean a test-support project existing to save twenty lines.
//
// A substitute cannot do this job. ILogger.Log is generic in TState and the message does not
// exist until the formatter has run, which a Received() call never does — so an NSubstitute
// version can assert that logging happened and nothing about what was said.
internal sealed class RecordingLogger<T> : ILogger<T>
{
    public sealed record Entry(LogLevel Level, string Message, Exception? Exception);

    public List<Entry> Entries { get; } = [];

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    // Everything, always: a test that had to configure a level before it could read a line would
    // be testing the filter rather than the notifier.
    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
        LogLevel logLevel, EventId eventId, TState state, Exception? exception,
        Func<TState, Exception?, string> formatter) =>
        Entries.Add(new Entry(logLevel, formatter(state, exception), exception));
}
