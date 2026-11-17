using Microsoft.Extensions.Time.Testing;
using MqttForge.Domain.Models;
using MqttForge.Infrastructure.Alerts;
using Xunit;

namespace MqttForge.UnitTests.Infrastructure;

/// <summary>
/// What the connection manager is told when a link drops: which alert published a moment ago.
/// </summary>
public class AlertPublishWitnessTests
{
    private readonly FakeTimeProvider _time = new();

    [Fact]
    public void Names_the_publish_that_went_within_the_window()
    {
        var witness = new AlertPublishWitness(_time);

        witness.Saw("Hot plant", "alerts/hot/plant/1");
        _time.Advance(AlertPublishWitness.Window);

        Assert.Equal(new RefusedPublish("Hot plant", "alerts/hot/plant/1"), witness.Recent());
    }

    // A link that goes a while after an alarm went for some other reason, as far as anyone knows.
    [Fact]
    public void Names_nothing_once_the_window_has_passed()
    {
        var witness = new AlertPublishWitness(_time);

        witness.Saw("Hot plant", "alerts/hot/plant/1");
        _time.Advance(AlertPublishWitness.Window + TimeSpan.FromMilliseconds(1));

        Assert.Null(witness.Recent());
    }

    [Fact]
    public void Names_the_latest_of_two()
    {
        var witness = new AlertPublishWitness(_time);

        witness.Saw("Hot plant", "alerts/hot/plant/1");
        witness.Saw("Cold plant", "alerts/cold/plant/2");

        Assert.Equal(new RefusedPublish("Cold plant", "alerts/cold/plant/2"), witness.Recent());
    }

    // A new link: a publish made on the one before it is not something this one dropped over.
    [Fact]
    public void Forgets_what_it_saw_when_told_to()
    {
        var witness = new AlertPublishWitness(_time);

        witness.Saw("Hot plant", "alerts/hot/plant/1");
        witness.Forget();

        Assert.Null(witness.Recent());
    }
}
