using System.Text;
using MqttForge.Api.Contracts;
using MqttForge.Application.Alerts;
using MqttForge.Domain.Enums;
using MqttForge.Domain.Models;
using Xunit;

namespace MqttForge.UnitTests.Api;

/// <summary>
/// What the panel is sent. The one number in this file that is not a copy is the sample limit:
/// the spec keeps 4 kB of the body that fired the alarm for the webhook to carry, and hands the
/// console 256 bytes of it, because a thousand-row history at 4 kB a row is a 4 MB frame for a
/// list nobody scrolls that far down.
/// </summary>
public class AlertDtoTests
{
    private static readonly DateTimeOffset At = new(2026, 8, 30, 9, 14, 22, 104, TimeSpan.Zero);

    private static Alert AnAlert(string? sample = null, params AlertAction[] actions) =>
        new("a1", "6f1d", "Kazan sıcaklığı", "plant/boiler/temp", AlertSeverity.Critical,
            At, At, ResolvedAt: null, ResolvedBy: null, MutedUntil: null,
            Count: 3, "94.2 > 90", 94.2, sample, actions);

    [Fact]
    public void A_short_sample_is_left_alone()
    {
        Assert.Equal("""{"temp":94.2}""", AlertDto.Of(AnAlert("""{"temp":94.2}""")).Sample);
    }

    [Fact]
    public void A_sample_that_was_never_there_stays_null()
    {
        Assert.Null(AlertDto.Of(AnAlert()).Sample);
    }

    [Fact]
    public void A_long_sample_is_clipped_to_two_hundred_and_fifty_six_bytes()
    {
        var clipped = AlertDto.Of(AnAlert(new string('x', 4096))).Sample;

        Assert.Equal(256, AlertDto.SampleLimit);
        Assert.Equal(256, Encoding.UTF8.GetByteCount(clipped!));
    }

    // Bytes, not characters — and a cut counted in bytes lands in the middle of one. A clip that
    // split a rune would hand the console a replacement character, or an invalid frame, for the
    // one payload the reader most wants to look at.
    [Fact]
    public void Clipping_never_splits_a_character()
    {
        var clipped = AlertDto.Of(AnAlert(new string('x', 255) + "\U0001F600")).Sample!;

        Assert.Equal(255, Encoding.UTF8.GetByteCount(clipped));
        Assert.DoesNotContain('\uFFFD', clipped);
        Assert.Equal(new string('x', 255), clipped);
    }

    [Fact]
    public void An_alert_carries_its_channels_as_words()
    {
        var dto = AlertDto.Of(AnAlert(null, new ScreenAction(), new SoundAction()));

        Assert.Equal(["screen", "sound"], dto.Actions);
        Assert.Equal(AlertSeverity.Critical, dto.Severity);
        Assert.Equal(3, dto.Count);
        Assert.Equal("94.2 > 90", dto.Reason);
    }

    // The two numbers the snapshot cannot hold. Dropped messages are the engine's own count, but
    // webhooks are dropped by a queue in another class, and how long the engine has been blind is
    // a question only the link supervisor can answer.
    //
    // And the warming list, which is on the snapshot and needs no help from anywhere: the sentence
    // is built here rather than in the browser so that the panel, a webhook's reader and anybody
    // curling the endpoint are all told the same thing in the same words.
    [Fact]
    public void The_panel_payload_carries_the_snapshot_and_the_two_numbers_beside_it()
    {
        var snapshot = new AlertSnapshot(
            [AnAlert("""{"temp":94.2}""", new ScreenAction())],
            [],
            [new MutedPair("6f1d", "plant/boiler/temp", At)],
            [new RuleDiagnostic("6f1d", 3, 1200, 4, At, Faulted: false, null)],
            Dropped: 7,
            Suppressed: 2,
            [new CappedRule("6f1d", 12)],
            [new WarmingPair("6f1d", "plant/boiler/flow", 7, 20)]);

        var dto = AlertsDto.Of(snapshot, webhooksDropped: 5, blindSeconds: 42);

        Assert.Single(dto.Active);
        Assert.Empty(dto.History);
        Assert.Equal("plant/boiler/temp", Assert.Single(dto.Muted).Topic);
        Assert.Equal(1200, Assert.Single(dto.Rules).Evaluated);
        Assert.Equal(12, Assert.Single(dto.Capped).Untracked);
        Assert.Equal(7, dto.Dropped);
        Assert.Equal(5, dto.WebhooksDropped);
        Assert.Equal(2, dto.Suppressed);
        Assert.Equal(42, dto.BlindSeconds);

        var warming = Assert.Single(dto.Warming);
        Assert.Equal("plant/boiler/flow", warming.Topic);
        Assert.Equal("warming up, 7/20", warming.Note);
    }

    // The GET carries the server's configuration because the panel's own sentences depend on it:
    // 'webhooks are turned off on this server' and 'published under mqttforge/alerts/' are both
    // things only the server knows. Same shape and same argument as ExportFolderDto.
    [Fact]
    public void The_rules_response_carries_what_only_the_server_knows()
    {
        var rule = new AlertRule("6f1d", "Boiler", Enabled: true, "plant/boiler/temp", null,
            new ThresholdCondition(ThresholdOp.Gt, 90), null, null, null, AlertSeverity.Warn, []);
        var document = new AlertRuleDocument([rule], Unreadable: true, ["9ab2"]);
        var options = new AlertEngineOptions() with { AllowWebhooks = false, TopicPrefix = "site/alarms/" };

        var dto = AlertRulesResponseDto.Of(document, options);

        Assert.Equal("6f1d", Assert.Single(dto.Rules).Id);
        Assert.False(dto.AllowWebhooks);
        Assert.Equal("site/alarms/", dto.TopicPrefix);
        Assert.True(dto.Unreadable);
        Assert.Equal("9ab2", Assert.Single(dto.SkippedIds));
    }
}
