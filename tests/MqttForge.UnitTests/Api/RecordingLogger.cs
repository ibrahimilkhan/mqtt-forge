using Microsoft.Extensions.Logging;

namespace MqttForge.UnitTests.Api;

/// <summary>An <see cref="ILogger{T}"/> that keeps what it was told, so a test can read the
/// sentence a person would read.</summary>
// A substitute cannot do this job. ILogger.Log is generic in TState and the message does not
// exist until the formatter has run, which a Received() call never does — so an NSubstitute
// version can assert that logging happened and nothing about what was said. Twenty lines here
// buy assertions on the line itself, which is the whole point of a notifier whose only output
// is a log line.
//
// There is a second recorder in this suite, in AlertEngineFakes.cs, and the duplication is
// deliberate rather than an oversight. That one keeps (level, message) pairs, which is all the
// engine's tests ever ask for; this one also keeps the Exception a line was given, because the
// Api-side tests that come after this task read it. Merging them would mean the engine's fakes
// growing a field nothing in that file uses, across a project boundary, to save twenty lines.
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
