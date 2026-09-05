using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;
using MqttForge.Api;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;
using NSubstitute;
using NSubstitute.ExceptionExtensions;

namespace MqttForge.UnitTests.Api;

// Every one of these is a sequence of one-second steps with a fake clock advanced by hand between
// them. Nothing here starts the BackgroundService: ExecuteAsync is a Task.Delay and two calls, and
// a test that started it would be racing a thread-pool continuation against Advance for the right
// to decide what second it is.
public class BrokerLinkSupervisorTests
{
    private static readonly DateTimeOffset T0 = new(2026, 8, 30, 9, 0, 0, TimeSpan.Zero);

    private readonly FakeTimeProvider _time = new(T0);
    private readonly IMqttConnectionManager _manager = Substitute.For<IMqttConnectionManager>();
    private readonly IConnectionSettingsStore _settingsStore = Substitute.For<IConnectionSettingsStore>();
    private readonly IAlertRuleStore _rules = Substitute.For<IAlertRuleStore>();
    private readonly RecordingLogger<BrokerLinkSupervisor> _log = new();

    private static readonly BrokerConnectionSettings Saved =
        new("broker.local", 1883, "mqttforge", null, null, false);

    /// The seconds, counted from T0, at which a connect was actually asked for.
    private readonly List<int> _attempts = [];

    public BrokerLinkSupervisorTests()
    {
        _settingsStore.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<BrokerConnectionSettings?>(Saved));

        _rules.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new AlertRuleDocument([], false, [])));

        // Recorded and refused: the ladder only exists because attempts fail, so the default here
        // has to be failure. The tests that want a success say so.
        _manager.ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>())
            .Returns(_ =>
            {
                _attempts.Add(Second);
                return Task.FromException(new IOException("broker down"));
            });
    }

    private int Second => (int)(_time.GetUtcNow() - T0).TotalSeconds;

    // The container's case unless a test says otherwise: a host told to dial at start-up when
    // the rules want a broker. That is the one the ladder is about; the shipped default, which
    // never dials, has two tests of its own below.
    // One service per test, shared between the supervisor under test and the tests that play the
    // reader: a reader's dial goes through the same ConnectionService the supervisor reads, which
    // is how it learns that somebody pressed Connect.
    private ConnectionService? _service;
    private ConnectionService Service =>
        _service ??= new ConnectionService(_manager, _settingsStore, Substitute.For<ILogger<ConnectionService>>());

    private BrokerLinkSupervisor CreateSut(bool connectOnStart = true) =>
        new(Service, _rules, _log, _time, options: new BrokerLinkOptions(connectOnStart));

    private static AlertRule Rule(bool enabled) =>
        new("r1", "Boiler temperature", enabled, "plant/+/temp", null,
            new ThresholdCondition(ThresholdOp.Gt, 90), null, null, null,
            AlertSeverity.Critical, [new ScreenAction()]);

    private void RulesHold(params AlertRule[] rules) =>
        _rules.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new AlertRuleDocument(rules, false, [])));

    /// <summary>A supervisor that has already been told this link is wanted, with the attempt its
    /// start-up made cleared out of the way.</summary>
    // Every ladder test below starts from a link somebody wanted and that then broke, because that
    // is the only situation this class acts in: a fault on a host with no enabled rule is left
    // alone, which is exactly what A_fault_on_a_host_with_no_enabled_rule_is_left_alone asserts.
    // The start-up attempt is real and is recorded like any other, so it is cleared here and the
    // list each test goes on to assert is the ladder's own. No clock is advanced, so the seconds
    // the ladder lands on are counted from the same T0 the arming happened at.
    private async Task<BrokerLinkSupervisor> WantedAsync()
    {
        RulesHold(Rule(enabled: true));
        var sut = CreateSut();

        await sut.StartUpAsync(CancellationToken.None);
        _attempts.Clear();

        return sut;
    }

    /// One second of wall clock and one look at the link, however many times.
    private async Task PollAsync(BrokerLinkSupervisor sut, int seconds = 1)
    {
        for (var i = 0; i < seconds; i++)
        {
            _time.Advance(BrokerLinkSupervisor.PollInterval);
            await sut.SuperviseAsync(CancellationToken.None);
        }
    }

    [Fact]
    public void Backoff_is_the_ladder_the_spec_names()
    {
        Assert.Equal([1, 2, 4, 8, 16, 30], BrokerLinkSupervisor.Backoff);
    }

    // Today's behaviour, kept: opening the console is what connects a broker, and a container
    // that dialled out on every start because somebody once saved a host would be a surprise.
    [Fact]
    public async Task No_enabled_rule_means_no_connection_at_startup()
    {
        RulesHold(Rule(enabled: false));

        await CreateSut().StartUpAsync(CancellationToken.None);

        Assert.Empty(_attempts);
    }

    // The same decision, held for the rest of the run rather than only for its first second. Every
    // integration host in this repository runs this supervisor and none of them writes an
    // alert-rules.json; two of them assert a Faulted broker on purpose. Without the remembered
    // flag, each of those would be answered by a supervisor dialling a broker that its own
    // start-up had just decided, out loud, not to dial.
    [Fact]
    public async Task A_fault_on_a_host_with_no_enabled_rule_is_left_alone()
    {
        RulesHold(Rule(enabled: false));
        var sut = CreateSut();
        await sut.StartUpAsync(CancellationToken.None);

        _manager.State.Returns(ConnectionState.Faulted);
        await PollAsync(sut, seconds: 120);

        Assert.Empty(_attempts);
    }

    // The shipped case: a rule is enabled and a broker is saved, and still nothing is dialled,
    // because the console in front of the reader is the Broker panel and the dial is theirs to
    // make. The rules are not even read — on this host they do not change the answer.
    [Fact]
    public async Task A_host_not_told_to_connect_on_start_leaves_the_broker_alone_whatever_the_rules_say()
    {
        RulesHold(Rule(enabled: true));
        var sut = CreateSut(connectOnStart: false);

        await sut.StartUpAsync(CancellationToken.None);

        Assert.Empty(_attempts);
        await _rules.DidNotReceive().LoadAsync(Arg.Any<CancellationToken>());
        Assert.Contains(_log.Entries, entry => entry.Level == LogLevel.Information);
    }

    // ...and a link the reader then opens by hand is kept up as any hand-opened link is. The
    // option is about the dial nobody pressed a button for, not about supervision.
    [Fact]
    public async Task A_host_not_told_to_connect_on_start_still_keeps_up_a_link_the_reader_opened()
    {
        RulesHold(Rule(enabled: true));
        var sut = CreateSut(connectOnStart: false);
        await sut.StartUpAsync(CancellationToken.None);

        // The reader connects at second 1, and the link dies straight after.
        _manager.State.Returns(ConnectionState.Connected);
        await PollAsync(sut);

        _manager.State.Returns(ConnectionState.Faulted);
        // Second 2 arms the bottom rung, second 3 spends it.
        await PollAsync(sut, seconds: 2);

        Assert.Equal([3], _attempts);
    }

    [Fact]
    public async Task One_enabled_rule_connects_to_the_saved_broker_exactly_once()
    {
        RulesHold(Rule(enabled: true));

        await CreateSut().StartUpAsync(CancellationToken.None);

        await _manager.Received(1).ConnectAsync(Saved, Arg.Any<CancellationToken>());
    }

    // An unreadable file is not "no rules" and it is not "some rules" either — it is a file
    // nobody can read, and the engine runs empty until somebody fixes it. Connecting on the
    // chance that it once held an enabled rule would be guessing with the user's broker.
    [Fact]
    public async Task An_unreadable_rules_file_is_not_an_enabled_rule()
    {
        _rules.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(new AlertRuleDocument([], Unreadable: true, [])));

        await CreateSut().StartUpAsync(CancellationToken.None);

        Assert.Empty(_attempts);
        Assert.Contains(_log.Entries, entry => entry.Level == LogLevel.Error);
    }

    [Fact]
    public async Task An_enabled_rule_with_no_saved_broker_connects_to_nothing()
    {
        RulesHold(Rule(enabled: true));
        _settingsStore.LoadAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromResult<BrokerConnectionSettings?>(null));

        var exception = await Record.ExceptionAsync(() => CreateSut().StartUpAsync(CancellationToken.None));

        Assert.Null(exception);
        Assert.Empty(_attempts);
        Assert.Contains(_log.Entries, entry => entry.Level == LogLevel.Warning);
    }

    // BackgroundServiceExceptionBehavior defaults to StopHost, so an exception escaping this
    // takes the whole application with it — over a rules file that could not be opened.
    [Fact]
    public async Task A_rules_file_that_cannot_be_read_does_not_take_the_supervisor_down()
    {
        _rules.LoadAsync(Arg.Any<CancellationToken>()).Throws(new IOException("disk gone"));

        var exception = await Record.ExceptionAsync(() => CreateSut().StartUpAsync(CancellationToken.None));

        Assert.Null(exception);
        Assert.Empty(_attempts);
    }

    // The ladder in full. The fault is first seen on the poll at second 1, which arms the bottom
    // rung, so the first attempt lands at second 2 — one second later. From there the gaps are
    // the ladder itself, flattening at thirty and staying there.
    [Fact]
    public async Task The_ladder_waits_one_two_four_eight_sixteen_and_then_thirty_seconds()
    {
        var sut = await WantedAsync();
        _manager.State.Returns(ConnectionState.Faulted);

        await PollAsync(sut, seconds: 130);

        Assert.Equal([2, 4, 8, 16, 32, 62, 92, 122], _attempts);

        var waits = _attempts.Prepend(1).Zip(_attempts, (before, at) => at - before);
        Assert.Equal([1, 2, 4, 8, 16, 30, 30, 30], waits);
    }

    // Without this a link that came back after a bad night would spend the next outage starting
    // at thirty seconds, and a reader would call the reconnect broken.
    [Fact]
    public async Task A_successful_connection_puts_the_ladder_back_at_the_bottom()
    {
        var sut = await WantedAsync();
        _manager.State.Returns(ConnectionState.Faulted);

        // Second 2 and second 4: the ladder is two rungs up.
        await PollAsync(sut, seconds: 5);

        _manager.State.Returns(ConnectionState.Connected);
        await PollAsync(sut);

        _manager.State.Returns(ConnectionState.Faulted);
        // Second 7 arms the bottom rung, second 8 spends it.
        await PollAsync(sut, seconds: 2);

        Assert.Equal([2, 4, 8], _attempts);
    }

    // A link the user closed on purpose is not an outage, and the manager already says which of
    // the two this is — Disconnected for an explicit DisconnectAsync, Faulted for a link that died.
    [Fact]
    public async Task The_users_own_disconnect_stops_the_retries()
    {
        var sut = await WantedAsync();
        _manager.State.Returns(ConnectionState.Faulted);

        await PollAsync(sut, seconds: 5);

        _manager.State.Returns(ConnectionState.Disconnected);
        await PollAsync(sut, seconds: 120);

        Assert.Equal([2, 4], _attempts);
    }

    // The other half of the remembered flag: a host that wanted nothing at start-up starts wanting
    // something the moment somebody opens the link by hand, and from then on it is kept up.
    [Fact]
    public async Task A_user_connect_puts_the_supervisor_back_to_work()
    {
        _manager.State.Returns(ConnectionState.Disconnected);
        var sut = CreateSut();

        await PollAsync(sut, seconds: 60);
        Assert.Empty(_attempts);

        // The user connects at second 61, and the link dies again straight after.
        _manager.State.Returns(ConnectionState.Connected);
        await PollAsync(sut);

        _manager.State.Returns(ConnectionState.Faulted);
        // Second 62 arms the bottom rung, second 63 spends it.
        await PollAsync(sut, seconds: 2);

        Assert.Equal([63], _attempts);
    }

    // Connecting means somebody is already dialling, and it cannot be us: the attempt is awaited
    // inside SuperviseAsync, so it is the user, and two CONNECTs racing through one gate is the
    // thing ConnectionService exists to prevent. Armed first, so that what stops the attempt here
    // is the state and not a supervisor that was never interested in this link.
    [Fact]
    public async Task A_connect_already_in_flight_is_never_raced()
    {
        var sut = await WantedAsync();
        _manager.State.Returns(ConnectionState.Connecting);

        await PollAsync(sut, seconds: 120);

        Assert.Empty(_attempts);
    }

    private static BrokerFailure Failure(BrokerFailureReason reason) =>
        new(reason, "broker.local", 1883, "mqttforge", false, MqttTransport.Tcp, MqttProtocolLevel.Auto);

    // A password the broker rejected is rejected again on every rung, and a redial against a
    // taken client ID takes it back from whoever has it. Neither is the ladder's business.
    [Theory]
    [InlineData(BrokerFailureReason.CredentialsRejected)]
    [InlineData(BrokerFailureReason.SessionTakenOver)]
    [InlineData(BrokerFailureReason.TlsCertUntrusted)]
    [InlineData(BrokerFailureReason.Kicked)]
    public async Task A_fault_a_redial_could_not_fix_is_declined_rather_than_climbed(BrokerFailureReason reason)
    {
        var sut = await WantedAsync();

        _manager.State.Returns(ConnectionState.Faulted);
        _manager.Failure.Returns(Failure(reason));
        await PollAsync(sut, seconds: 120);

        Assert.Empty(_attempts);
        Assert.True(sut.Status.Declined);
        Assert.False(sut.Status.Active);
    }

    [Theory]
    [InlineData(BrokerFailureReason.ConnectionLost)]
    [InlineData(BrokerFailureReason.Refused)]
    [InlineData(BrokerFailureReason.BrokerBusy)]
    public async Task A_broker_that_is_merely_down_is_climbed_for(BrokerFailureReason reason)
    {
        var sut = await WantedAsync();

        _manager.State.Returns(ConnectionState.Faulted);
        _manager.Failure.Returns(Failure(reason));
        await PollAsync(sut, seconds: 3);

        Assert.NotEmpty(_attempts);
        Assert.False(sut.Status.Declined);
    }

    // Retry now is the reader overruling the decline: one try, at their asking.
    [Fact]
    public async Task Retry_now_overrules_a_decline()
    {
        var sut = await WantedAsync();
        _manager.State.Returns(ConnectionState.Faulted);
        _manager.Failure.Returns(Failure(BrokerFailureReason.CredentialsRejected));
        await PollAsync(sut);
        Assert.True(sut.Status.Declined);

        await sut.RetryNowAsync(CancellationToken.None);

        Assert.Single(_attempts);
    }

    [Fact]
    public async Task A_link_that_comes_back_ends_the_decline()
    {
        var sut = await WantedAsync();
        _manager.State.Returns(ConnectionState.Faulted);
        _manager.Failure.Returns(Failure(BrokerFailureReason.CredentialsRejected));
        await PollAsync(sut);

        _manager.State.Returns(ConnectionState.Connected);
        _manager.Failure.Returns((BrokerFailure?)null);
        await PollAsync(sut);

        Assert.False(sut.Status.Declined);
    }

    // The redial the supervisor makes is followed by nobody: the reader's console asks for its
    // filters after *their* Connect, not after this one. So the supervisor asks on its behalf.
    [Fact]
    public async Task A_redial_that_works_puts_the_consoles_filters_back()
    {
        var restorer = Substitute.For<ISubscriptionRestorer>();
        RulesHold(Rule(enabled: true));
        _manager.ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        var sut = new BrokerLinkSupervisor(
            Service, _rules, _log, _time, options: new BrokerLinkOptions(ConnectOnStart: true), restorer: restorer);

        await sut.StartUpAsync(CancellationToken.None);

        await restorer.Received(1).RestoreConsoleFiltersAsync(Arg.Any<CancellationToken>());
    }

    // A filter the broker refuses on the redial is not a failed redial.
    [Fact]
    public async Task A_filter_refused_on_the_redial_does_not_fail_the_redial()
    {
        var restorer = Substitute.For<ISubscriptionRestorer>();
        restorer.RestoreConsoleFiltersAsync(Arg.Any<CancellationToken>())
            .ThrowsAsync(new MessageRejectedException("The broker refused '#'."));
        RulesHold(Rule(enabled: true));
        _manager.ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        var sut = new BrokerLinkSupervisor(
            Service, _rules, _log, _time, options: new BrokerLinkOptions(ConnectOnStart: true), restorer: restorer);

        var exception = await Record.ExceptionAsync(() => sut.StartUpAsync(CancellationToken.None));

        Assert.Null(exception);
        Assert.Contains(_log.Entries, entry => entry.Level == LogLevel.Warning);
    }

    // Measured: a Connect to a wrong password, pressed from a live link, faulted — and the ladder
    // redialled the saved broker, the one the reader had just left. A reader's dial supersedes
    // the link this class was keeping up; if it fails, that is theirs to read under the form.
    [Fact]
    public async Task A_readers_own_failed_dial_is_not_an_outage_to_climb_for()
    {
        var sut = await WantedAsync();
        _manager.State.Returns(ConnectionState.Connected);
        await PollAsync(sut);

        // The reader dials a broker that refuses them. ConnectionService counts the dial; the
        // manager is left Faulted about it.
        await Assert.ThrowsAnyAsync<Exception>(() => Service.ConnectAsync(
            new BrokerConnectionSettings("other.local", 1883, "mqttforge", "u", "wrong", false),
            CancellationToken.None));
        _manager.State.Returns(ConnectionState.Faulted);
        _manager.Failure.Returns(Failure(BrokerFailureReason.Refused));
        _attempts.Clear();

        await PollAsync(sut, seconds: 60);

        Assert.Empty(_attempts);
    }

    // A console that opens mid-outage has nothing of its own to draw from; the status says when
    // the outage began, and keeps saying it through a stop and a decline, until the link is up.
    [Fact]
    public async Task The_status_says_when_the_outage_began_until_the_link_is_back()
    {
        var sut = await WantedAsync();
        Assert.Null(sut.Status.Since);

        _manager.State.Returns(ConnectionState.Faulted);
        _manager.Failure.Returns(Failure(BrokerFailureReason.Refused));
        await PollAsync(sut);
        var began = sut.Status.Since;
        Assert.Equal(T0.AddSeconds(1), began);

        await PollAsync(sut, seconds: 10);
        await sut.CancelAsync();
        Assert.Equal(began, sut.Status.Since);

        _manager.State.Returns(ConnectionState.Connected);
        await PollAsync(sut);
        Assert.Null(sut.Status.Since);
    }

    [Fact]
    public async Task A_fault_on_a_link_nobody_wanted_is_not_an_outage_with_a_beginning()
    {
        RulesHold(Rule(enabled: false));
        var sut = CreateSut();
        await sut.StartUpAsync(CancellationToken.None);

        _manager.State.Returns(ConnectionState.Faulted);
        _manager.Failure.Returns(Failure(BrokerFailureReason.Refused));
        await PollAsync(sut, seconds: 3);

        Assert.Null(sut.Status.Since);
    }

    // A container started with no rules and given its first enabled one an hour later had nobody
    // to notice: the only dial-because-a-rule-wants-one happened at start-up.
    [Fact]
    public async Task A_rule_saved_on_a_host_that_dials_for_rules_gets_a_link()
    {
        RulesHold(Rule(enabled: false));
        var sut = CreateSut(connectOnStart: true);
        await sut.StartUpAsync(CancellationToken.None);
        Assert.Empty(_attempts);

        await sut.WantedAsync(CancellationToken.None);

        Assert.Single(_attempts);
    }

    // ...and a desktop console does not dial because somebody saved a rule. That reader has a
    // Connect button and did not press it.
    [Fact]
    public async Task A_rule_saved_on_a_host_that_waits_for_a_reader_dials_nothing()
    {
        RulesHold(Rule(enabled: false));
        var sut = CreateSut(connectOnStart: false);
        await sut.StartUpAsync(CancellationToken.None);

        await sut.WantedAsync(CancellationToken.None);

        Assert.Empty(_attempts);
    }

    [Fact]
    public async Task A_rule_saved_over_a_live_link_dials_nothing()
    {
        var sut = CreateSut(connectOnStart: true);
        _manager.State.Returns(ConnectionState.Connected);

        await sut.WantedAsync(CancellationToken.None);

        Assert.Empty(_attempts);
    }

    // A dial at the broker that is down is not leaving it: the ladder keeps its place.
    [Fact]
    public async Task A_readers_dial_at_the_broker_that_is_down_does_not_stand_the_ladder_down()
    {
        var sut = await WantedAsync();
        _manager.State.Returns(ConnectionState.Faulted);
        _manager.Failure.Returns(Failure(BrokerFailureReason.Refused));
        await PollAsync(sut, seconds: 2);
        var before = _attempts.Count;

        // The reader presses Connect on the same broker — Saved is broker.local:1883, as the
        // failure is — and is refused like the ladder was.
        await Assert.ThrowsAnyAsync<Exception>(() => Service.ConnectAsync(Saved, CancellationToken.None));
        await PollAsync(sut, seconds: 30);

        Assert.True(_attempts.Count > before + 1, "the ladder should have gone on climbing");
        Assert.True(sut.Status.Active);
    }

    // The other half of the hurry-up: with no outage on, a failed dial is a failed dial. A reader
    // who hung up and then mistyped a port used to be answered by a ladder dialling the broker
    // they had just left — the saved settings — and the rail went green on it.
    [Fact]
    public async Task A_failed_dial_after_a_hand_disconnect_starts_no_ladder()
    {
        var sut = await WantedAsync();

        // The hang-up. The outage, if any, is over and nothing is being worked on.
        _manager.State.Returns(ConnectionState.Disconnected);
        await PollAsync(sut);

        // ...and then a mistyped port, refused where it was aimed.
        var mistyped = Saved with { Port = 21999 };
        await Record.ExceptionAsync(() => Service.ConnectAsync(mistyped, CancellationToken.None));
        _manager.State.Returns(ConnectionState.Faulted);
        _manager.Failure.Returns(Failure(BrokerFailureReason.Refused) with { Port = 21999 });
        _attempts.Clear();

        await PollAsync(sut, seconds: 60);

        Assert.Empty(_attempts);
        Assert.False(sut.Status.Active);
    }

    // ...and a reader's dial that works is a link worth keeping up, exactly as before.
    [Fact]
    public async Task A_readers_dial_that_works_is_kept_up()
    {
        var sut = CreateSut();
        _manager.ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>())
            .Returns(Task.CompletedTask);
        await Service.ConnectAsync(Saved, CancellationToken.None);
        _manager.State.Returns(ConnectionState.Connected);
        await PollAsync(sut);

        _manager.State.Returns(ConnectionState.Faulted);
        _manager.Failure.Returns(Failure(BrokerFailureReason.ConnectionLost));
        _manager.ConnectAsync(Arg.Any<BrokerConnectionSettings>(), Arg.Any<CancellationToken>())
            .Returns(_ => { _attempts.Add(Second); return Task.FromException(new IOException("down")); });
        await PollAsync(sut, seconds: 3);

        Assert.NotEmpty(_attempts);
    }

    [Fact]
    public async Task A_healthy_link_is_never_reconnected()
    {
        var sut = await WantedAsync();
        _manager.State.Returns(ConnectionState.Connected);

        await PollAsync(sut, seconds: 120);

        Assert.Empty(_attempts);
    }

    // The ladder only exists because connects fail. One that let the failure out would end the
    // loop that is supposed to try again — and, with StopHost, the process.
    [Fact]
    public async Task A_broker_that_refuses_never_throws_out_of_a_poll()
    {
        var sut = await WantedAsync();
        _manager.State.Returns(ConnectionState.Faulted);

        _time.Advance(BrokerLinkSupervisor.PollInterval);
        await sut.SuperviseAsync(CancellationToken.None);
        _time.Advance(BrokerLinkSupervisor.PollInterval);

        var exception = await Record.ExceptionAsync(() => sut.SuperviseAsync(CancellationToken.None));

        Assert.Null(exception);
        Assert.Equal([2], _attempts);
    }
}
