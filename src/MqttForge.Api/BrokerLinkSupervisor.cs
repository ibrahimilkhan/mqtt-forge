using MqttForge.Application.Alerts;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;

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
public sealed class BrokerLinkSupervisor : BackgroundService
{
    /// <summary>Seconds to wait before each successive retry, flattening at the last rung.</summary>
    public static readonly IReadOnlyList<int> Backoff = [1, 2, 4, 8, 16, 30];

    /// <summary>How often the link is looked at. One second, which is also the bottom rung, so
    /// the ladder and the poll never disagree about when an attempt was due.</summary>
    public static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(1);

    private readonly ConnectionService _connection;
    private readonly IAlertRuleStore _rules;
    private readonly ILogger<BrokerLinkSupervisor> _log;
    private readonly TimeProvider _time;

    // When the ladder next allows an attempt. Null means no outage is being worked on — either
    // the link is fine, or it is down for a reason that is none of this class's business.
    private DateTimeOffset? _dueAt;

    // How many waits this outage has already spent, which is where on the ladder the next one is.
    private int _rung;

    // Whether anything ever asked for this link. Set when the rules wanted one at start-up, and
    // set again the moment the state is seen Connected — because a link somebody opened by hand
    // is a link worth keeping up. Without it, a host with no alert rules at all would answer a
    // fault by dialling a broker its own start-up had just decided not to dial: this supervisor
    // runs in every host this product builds, including the ones that have no rules file at all.
    private bool _wanted;

    /// Where the blind clock is kept, so that the endpoint reading it does not have to hold a
    /// BackgroundService. See AlertPanelCounters.
    private readonly AlertPanelCounters _panel;

    // The panel goes last, after the clock, and both are optional. Every existing caller —
    // BrokerLinkSupervisorTests' CreateSut, which passes four positional arguments ending with a
    // FakeTimeProvider — goes on compiling and goes on meaning what it meant. The container fills
    // this one from the registered singleton, because a registered service beats a default value.
    public BrokerLinkSupervisor(
        ConnectionService connection, IAlertRuleStore rules, ILogger<BrokerLinkSupervisor> log,
        TimeProvider? timeProvider = null, AlertPanelCounters? panel = null)
    {
        _connection = connection;
        _rules = rules;
        _log = log;
        _time = timeProvider ?? TimeProvider.System;

        // A throwaway rather than a null check at every use, exactly as the clock above does it.
        // A supervisor built without one writes its blindness where nobody reads it, which is
        // what a test that never asked for the number wants.
        _panel = panel ?? new AlertPanelCounters(_time);
    }

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
        // Connecting is somebody already dialling, and it cannot be us — the attempt below is
        // awaited inside this method — so it is the user, and two CONNECTs racing through one
        // gate is the thing ConnectionService exists to prevent.
        if (state != ConnectionState.Faulted)
        {
            if (state == ConnectionState.Connected) _wanted = true;
            _dueAt = null;
            _rung = 0;
            return;
        }

        // The start-up decision, held. A host with no enabled rule is not this supervisor's
        // business, and a broker that faults on it is somebody else's story — most of this
        // repository's integration tests are exactly that host, and two of them assert a Faulted
        // broker deliberately.
        if (!_wanted) return;

        var now = _time.GetUtcNow();

        // First sight of this outage. The bottom rung is a wait, not an attempt: a broker that
        // has just dropped is rarely ready in the same second, and hammering it is how a
        // reconnect turns into a flood.
        if (_dueAt is null)
        {
            _dueAt = now + NextRung();
            return;
        }

        if (now < _dueAt) return;

        await AttemptAsync(ct);
        _dueAt = _time.GetUtcNow() + NextRung();
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

    private TimeSpan NextRung()
    {
        var seconds = Backoff[Math.Min(_rung, Backoff.Count - 1)];
        _rung++;

        return TimeSpan.FromSeconds(seconds);
    }

    // Read fresh on every attempt and never cached from start-up. ConnectionService writes the
    // settings down whenever a connect succeeds, so this file always names the broker the user is
    // actually on — while a supervisor holding start-up's copy would answer a drop by dialling
    // whichever broker they left an hour ago, and, because there is only ever one active
    // connection, would take them off the one they moved to.
    private async Task AttemptAsync(CancellationToken ct)
    {
        try
        {
            var settings = await _connection.GetSavedSettingsAsync(ct);

            if (settings is null)
            {
                _log.LogWarning(
                    "Alert rules are running but no broker has been saved, so there is nothing to connect to.");
                return;
            }

            _log.LogInformation("Connecting to {Endpoint} for the alert rules.", settings.Endpoint);
            await _connection.ConnectAsync(settings, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // The ladder only exists because attempts fail. One that let the failure out would
            // end the loop that is meant to try again — and, with StopHost, the process.
            _log.LogWarning(ex, "Could not reach the broker for the alert rules; will try again.");
        }
    }
}
