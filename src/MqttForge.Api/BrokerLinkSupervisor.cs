using MqttForge.Application.Alerts;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;

namespace MqttForge.Api;

/// <summary>Brings the broker link up when rules need it, and brings it back when it drops.</summary>
// Before this class there was no reconnection in the repository at all: nothing connected at
// start-up, MqttnetClientProvider hands out a plain IMqttClient rather than a managed one, and
// OnDisconnectedAsync only clears the filter set and announces. With those three facts standing,
// "a headless MQTTForge in Docker evaluates rules" is not true of anything.
//
// It goes through ConnectionService and never through the manager, so the gate and the
// one-active-connection rule apply to it exactly as they apply to a person pressing Connect.
//
// The two steps below are public because they are the class; ExecuteAsync only spaces them out.
// Written the other way, testing the ladder means starting a BackgroundService and racing a fake
// clock against a thread-pool continuation for the right to decide what second it is. This is the
// same trade AlertEngineCore made by taking 'now' as a parameter, and for the same reason.
//
// It used to do all of this silently, which was the whole of what was wrong with it: the only
// trace of a ladder being walked was the rail's lamp flickering Faulted → Connecting → Faulted
// once a rung, and there was no way to stop it or to know it had started. So the class now also
// says what it is doing (Status, published on every change), takes an answer to it (CancelAsync,
// RetryNowAsync) and can be turned off altogether (SetEnabledAsync). None of that changed the
// ladder, which was never the part anybody objected to.
public sealed class BrokerLinkSupervisor : BackgroundService
{
    /// <summary>Seconds to wait before each successive retry, flattening at the last rung.</summary>
    public static readonly IReadOnlyList<int> Backoff = [1, 2, 4, 8, 16, 30];

    /// <summary>How often the link is looked at. One second, which is also the bottom rung, so
    /// the ladder and the poll never disagree about when an attempt was due.</summary>
    public static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(1);

    /// <summary>Supervised unless somebody has said otherwise.</summary>
    // On, because the supervisor exists so that a headless MQTTForge goes on evaluating rules
    // across a broker restart, and a default of off would turn that back off without anyone
    // asking for it. What was missing was never the behaviour — it was the reader's sight of it
    // and their hand on it, and both of those are now here.
    public const bool EnabledByDefault = true;

    private readonly ConnectionService _connection;
    private readonly IAlertRuleStore _rules;
    private readonly ILogger<BrokerLinkSupervisor> _log;
    private readonly TimeProvider _time;
    private readonly IReconnectOptionStore _option;
    private readonly IReconnectStatusNotifier _notifier;

    // When the ladder next allows an attempt. Null means no outage is being worked on — either
    // the link is fine, or it is down for a reason that is none of this class's business.
    private DateTimeOffset? _dueAt;

    // How many waits this outage has already spent, which is where on the ladder the next one is.
    private int _rung;

    // How many attempts this outage has actually cost. Kept apart from the rung, which is a
    // position in a table and reads as one off: the rung is incremented when the *next* wait is
    // scheduled, so at the moment the first attempt is made the rung already says two. What a
    // reader is shown is "attempt 3 failed", and this is the only field that can say it.
    private int _attempts;

    // Whether an outage is being worked on, as opposed to merely present. False when the option
    // is off, when nobody wanted this link, and when somebody called this outage off.
    private bool _active;

    // This outage, given up on by hand. Cleared the moment the link is anything but Faulted, so
    // it cannot outlive the outage it was about — see SuperviseAsync.
    private bool _gaveUp;

    // The option, cached. Read from the store once at start-up and written through by
    // SetEnabledAsync, so the loop never touches a file.
    private bool _enabled = EnabledByDefault;

    // Whether that read has happened. StartAsync does it and StartUpAsync does it, and only the
    // first of the two is allowed to count — see StartAsync.
    private bool _optionRead;

    // Whether anything ever asked for this link. Set when the rules wanted one at start-up, and
    // set again the moment the state is seen Connected — because a link somebody opened by hand
    // is a link worth keeping up. Without it, a host with no alert rules at all would answer a
    // fault by dialling a broker its own start-up had just decided not to dial: this supervisor
    // runs in every host this product builds, including the ones that have no rules file at all.
    private bool _wanted;

    // The last status anybody was told about, so that a poll that changed nothing says nothing.
    // Without it the console would be sent an identical payload every second for the whole of an
    // outage, and the countdown it draws does not need one: it has an instant to subtract from.
    private ReconnectStatus? _announced;

    // One dial at a time. The loop cannot overlap itself — its attempt is awaited inside
    // SuperviseAsync — but RetryNowAsync runs on a request thread and can land in the middle of
    // one, and two CONNECTs racing through ConnectionService would fight over the field it keeps
    // the abortable attempt in. Whoever arrives second has nothing to add: something is already
    // dialling, which is what they asked for.
    private readonly SemaphoreSlim _dialling = new(1, 1);

    /// Where the blind clock is kept, so that the endpoint reading it does not have to hold a
    /// BackgroundService. See AlertPanelCounters.
    private readonly AlertPanelCounters _panel;

    // The panel goes last, after the clock, and both are optional. Every existing caller —
    // BrokerLinkSupervisorTests' CreateSut, which passes four positional arguments ending with a
    // FakeTimeProvider — goes on compiling and goes on meaning what it meant. The container fills
    // this one from the registered singleton, because a registered service beats a default value.
    //
    // The store and the notifier are optional for the same reason and stand in the same way: a
    // supervisor built without them supervises exactly as before and tells nobody, which is what
    // a test that is only asking about the ladder wants.
    public BrokerLinkSupervisor(
        ConnectionService connection, IAlertRuleStore rules, ILogger<BrokerLinkSupervisor> log,
        TimeProvider? timeProvider = null, AlertPanelCounters? panel = null,
        IReconnectOptionStore? option = null, IReconnectStatusNotifier? notifier = null)
    {
        _connection = connection;
        _rules = rules;
        _log = log;
        _time = timeProvider ?? TimeProvider.System;

        // A throwaway rather than a null check at every use, exactly as the clock above does it.
        // A supervisor built without one writes its blindness where nobody reads it, which is
        // what a test that never asked for the number wants.
        _panel = panel ?? new AlertPanelCounters(_time);
        _option = option ?? new UnsavedOption();
        _notifier = notifier ?? new SilentStatus();
    }

    /// <summary>What is being done about the link, and whether anything is allowed to be.</summary>
    public ReconnectStatus Status => new(_enabled, _active, _attempts, _dueAt, _gaveUp);

    /// <summary>The clock NextAttemptAt is an instant on.</summary>
    // Exposed so that whatever serialises a status can send the two together — see
    // IReconnectStatusNotifier. One clock, read in one place, rather than an endpoint reaching
    // for DateTimeOffset.UtcNow beside a supervisor running on an injected one.
    public DateTimeOffset Now => _time.GetUtcNow();

    /// <summary>The one decision made at start-up: whether there is anything to be connected for.</summary>
    // No enabled rule means no connection, which is today's behaviour kept on purpose. Opening
    // the console is what connects a broker; a container that dialled out on every start because
    // somebody once saved a host would be a surprise nobody asked for.
    //
    // Bringing the link up when a rule is enabled *later* is deliberately not here. That is a
    // save-time decision and it belongs with the save, not with a supervisor whose whole job is
    // to watch a link that already exists.
    public async Task StartUpAsync(CancellationToken ct)
    {
        // Before the rules, because it governs everything after them and because a console that
        // opens during start-up should read the option rather than the default. Normally already
        // done by StartAsync; this is what makes a direct call — every unit test in the suite —
        // behave like the real thing.
        await ReadOptionOnceAsync(ct);

        try
        {
            var document = await _rules.LoadAsync(ct);

            // Not the same as no rules, and told apart in the log because the two need different
            // things done about them. An unreadable file means the engine is running empty until
            // somebody fixes it; connecting on the chance that it once held an enabled rule would
            // be guessing with the user's broker.
            if (document.Unreadable)
            {
                _log.LogError(
                    "The alert rules could not be read, so no rules are running and the broker is left alone.");
                return;
            }

            if (!document.Rules.Any(rule => rule.Enabled))
            {
                _log.LogInformation(
                    "No alert rules are enabled, so the broker is left alone until somebody connects.");
                return;
            }

            // Past both guards, so this host has something to be connected for — and it goes on
            // having it. SuperviseAsync reads this flag on every fault, which is how the decision
            // made here survives the rest of the run instead of lasting one line.
            _wanted = true;

            // Deliberately not gated on the option. Turning auto-reconnect off is an answer about
            // what should happen when a link *drops*; it is not an instruction to ignore the rules
            // this host was started with. A container that came up having been told not to
            // reconnect, and therefore never connected at all, would evaluate nothing and say
            // nothing about why.
            await AttemptAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogError(ex, "Could not work out whether the alert rules need a broker connection.");
        }
    }

    /// <summary>One look at the link, and at most one connect attempt.</summary>
    public async Task SuperviseAsync(CancellationToken ct)
    {
        var state = _connection.CurrentState;

        // Before the Faulted test and outside it, because the panel's question is not this class's
        // question. This class only acts on a link that broke by itself; the engine is blind
        // whenever the link is not up, including when somebody closed it on purpose and including
        // on a host that never wanted one. Recording it here rather than in a fourth background
        // loop is simply because this is the loop that already looks at the link every second.
        if (state == ConnectionState.Connected) _panel.Seeing(); else _panel.Blind();

        // Faulted is the only state that belongs to this class, and the manager is what makes
        // that a safe test rather than a guess: it writes Disconnected for an explicit
        // DisconnectAsync and Faulted on the successful connect path, so a link that later dies
        // describes itself correctly and a link somebody closed does too. The state IS the "has
        // the user silenced us" flag, and a second flag beside it could only ever disagree.
        //
        // Reopening a link somebody closed on purpose is arguing with them. Their next Connect
        // puts the state back to Connected and puts this class back to work — which is also where
        // _wanted is set for a host whose rules never asked for a link: somebody dialled by hand,
        // so from here on the link is worth keeping up.
        //
        // Connecting is somebody already dialling — this class or the reader — and either way the
        // ladder has nothing to add until it is over.
        if (state != ConnectionState.Faulted)
        {
            if (state == ConnectionState.Connected) _wanted = true;

            // The outage is over, however it ended, so everything that was only true *of* it goes
            // — including the giving-up, which is why that flag can never outlive the fault it
            // was an answer to.
            Rest();
            await AnnounceAsync();
            return;
        }

        // The option, and it is read here rather than at the top so that the two states above it
        // still clear the ladder down. A supervisor turned off in the middle of an outage should
        // not come back to a rung it left behind an hour ago.
        //
        // The start-up decision is held in the same breath. A host with no enabled rule is not
        // this supervisor's business, and a broker that faults on it is somebody else's story —
        // most of this repository's integration tests are exactly that host, and two of them
        // assert a Faulted broker deliberately.
        if (!_enabled || !_wanted || _gaveUp)
        {
            // Not Rest(): the giving-up is about this outage and the outage is still on. Only the
            // schedule is stood down, so that a reader who changes their mind starts from the
            // bottom rung rather than from wherever the ladder had climbed to.
            _active = false;
            _dueAt = null;
            _rung = 0;
            await AnnounceAsync();
            return;
        }

        _active = true;
        var now = _time.GetUtcNow();

        // First sight of this outage. The bottom rung is a wait, not an attempt: a broker that
        // has just dropped is rarely ready in the same second, and hammering it is how a
        // reconnect turns into a flood.
        if (_dueAt is null)
        {
            // The count starts here and not at Rest(), because the one dial start-up makes is not
            // part of any outage: a console opened a second after a failed start-up would have
            // read "attempt 1" about an outage that had not begun. This is the moment one does.
            _attempts = 0;
            _dueAt = now + NextRung();
            await AnnounceAsync();
            return;
        }

        if (now < _dueAt) return;

        await AttemptAsync(ct);
        _dueAt = _time.GetUtcNow() + NextRung();
        await AnnounceAsync();
    }

    /// <summary>Calls off the outage being worked on, and the attempt in flight with it.</summary>
    // Per-outage, and that is the whole of the difference between this and turning the option off.
    // "Stop, I am looking at it" is by far the commoner thing to mean, and answering it by
    // switching supervision off for good would be answering a different question — the reader
    // would then have to remember to switch it back on, and the one thing certain about a
    // forgotten switch is that it is forgotten at the next outage.
    public async Task CancelAsync()
    {
        _gaveUp = true;
        _active = false;
        _dueAt = null;
        _rung = 0;

        // The dial itself, not just the schedule. Half of the ladder's time is spent inside a
        // 20-second connect timeout, so a cancel that only cleared the schedule would leave the
        // reader watching a "Connecting" they had just stopped.
        _connection.CancelAttempt();

        await AnnounceAsync();
    }

    /// <summary>Dials now, whatever the ladder was waiting for.</summary>
    // Works with the option off. "Try now" is a hand on a button rather than a policy, and a
    // reader who has turned supervision off has not thereby said they never want to connect
    // again — they have said they want to be the one who decides when.
    public async Task RetryNowAsync(CancellationToken ct)
    {
        // A reader who presses this has un-given-up by definition, and the ladder starts again
        // from the bottom: this is a fresh go at the broker, not the continuation of a climb.
        _gaveUp = false;
        _rung = 0;
        _dueAt = null;

        await AttemptAsync(ct);

        // Only if it is still down. A dial that worked leaves the state Connected, and the next
        // poll clears all of this anyway; scheduling a rung against a live link would put a
        // countdown on the panel underneath a connection that is up.
        if (_enabled && _connection.CurrentState == ConnectionState.Faulted)
        {
            _wanted = true;
            _active = true;
            _dueAt = _time.GetUtcNow() + NextRung();
        }

        await AnnounceAsync();
    }

    /// <summary>Turns supervision on or off, and remembers the answer.</summary>
    public async Task SetEnabledAsync(bool enabled, CancellationToken ct)
    {
        _enabled = enabled;

        // Turning it on is not the same as being told to climb: the next poll decides that, and
        // it decides it from the bottom rung. Turning it off stands the ladder down without
        // touching the link, which stays exactly as broken as it was.
        if (!enabled)
        {
            _active = false;
            _dueAt = null;
            _rung = 0;
        }
        else
        {
            // A reader turning it back on has plainly stopped giving up on this outage.
            _gaveUp = false;
        }

        try
        {
            await _option.SaveAsync(enabled, ct);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The switch still moved; only the memory of it did not. Failing the request would
            // leave the reader with a switch that refuses to move and a link nobody is watching.
            _log.LogWarning(ex, "Auto-reconnect was set to {Enabled} but could not be saved.", enabled);
        }

        await AnnounceAsync();
    }

    /// <summary>Reads the option before the host reports itself started.</summary>
    // A BackgroundService's StartAsync returns the moment ExecuteAsync reaches its first await,
    // so a console that asked the instant the host came up could be told the default about a
    // setting the file had already answered. Reading one line of JSON is cheap enough to do
    // before the host is open for business; dialling a broker, which is the rest of start-up, is
    // not — that stays inside ExecuteAsync where a 20-second connect timeout costs nobody.
    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        await ReadOptionOnceAsync(cancellationToken);
        await base.StartAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await StartUpAsync(stoppingToken);

            while (!stoppingToken.IsCancellationRequested)
            {
                await Task.Delay(PollInterval, _time, stoppingToken);
                await SuperviseAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException)
        {
            // Shutdown. The link goes with the process.
        }
    }

    /// <summary>Everything that was only true of an outage that is now over.</summary>
    private void Rest()
    {
        _active = false;
        _dueAt = null;
        _rung = 0;
        _attempts = 0;
        _gaveUp = false;
    }

    private TimeSpan NextRung()
    {
        var seconds = Backoff[Math.Min(_rung, Backoff.Count - 1)];
        _rung++;

        return TimeSpan.FromSeconds(seconds);
    }

    private async Task ReadOptionOnceAsync(CancellationToken ct)
    {
        if (_optionRead) return;
        _optionRead = true;

        _enabled = await LoadOptionAsync(ct);
        await AnnounceAsync();
    }

    private async Task<bool> LoadOptionAsync(CancellationToken ct)
    {
        try
        {
            return await _option.LoadAsync(ct) ?? EnabledByDefault;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogWarning(ex, "Could not read the auto-reconnect setting; supervising the link.");

            return EnabledByDefault;
        }
    }

    // Only on a change, and never allowed to break the loop that called it: a hub with no
    // listeners, or one mid-restart, is not a reason to stop watching a broker.
    private async Task AnnounceAsync()
    {
        var status = Status;
        if (status == _announced) return;
        _announced = status;

        try
        {
            await _notifier.NotifyReconnectStatusChangedAsync(status, _time.GetUtcNow());
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            _log.LogDebug(ex, "Could not announce the reconnect status.");
        }
    }

    // Read fresh on every attempt and never cached from start-up. ConnectionService writes the
    // settings down whenever a connect succeeds, so this file always names the broker the user is
    // actually on — while a supervisor holding start-up's copy would answer a drop by dialling
    // whichever broker they left an hour ago, and, because there is only ever one active
    // connection, would take them off the one they moved to.
    private async Task AttemptAsync(CancellationToken ct)
    {
        // Whoever arrives second has nothing to add — see _dialling.
        if (!await _dialling.WaitAsync(0, ct)) return;

        try
        {
            var settings = await _connection.GetSavedSettingsAsync(ct);

            if (settings is null)
            {
                _log.LogWarning(
                    "Alert rules are running but no broker has been saved, so there is nothing to connect to.");
                return;
            }

            _attempts++;
            _log.LogInformation("Connecting to {Endpoint} for the alert rules.", settings.Endpoint);
            await _connection.ConnectAsync(settings, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // The ladder only exists because attempts fail. One that let the failure out would
            // end the loop that is meant to try again — and, with StopHost, the process.
            _log.LogWarning(ex, "Could not reach the broker for the alert rules; will try again.");
        }
        finally
        {
            _dialling.Release();
        }
    }

    // The two stand-ins the optional constructor arguments need. Null objects rather than null
    // checks at every use, which is the shape AlertPanelCounters already set here.
    private sealed class UnsavedOption : IReconnectOptionStore
    {
        public Task<bool?> LoadAsync(CancellationToken ct) => Task.FromResult<bool?>(null);

        public Task SaveAsync(bool enabled, CancellationToken ct) => Task.CompletedTask;
    }

    private sealed class SilentStatus : IReconnectStatusNotifier
    {
        public Task NotifyReconnectStatusChangedAsync(ReconnectStatus status, DateTimeOffset now) =>
            Task.CompletedTask;
    }
}
