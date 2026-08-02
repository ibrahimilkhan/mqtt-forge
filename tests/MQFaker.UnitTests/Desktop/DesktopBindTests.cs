using MQFaker.Desktop;

namespace MQFaker.UnitTests.Desktop;

public sealed class DesktopBindTests
{
    [Fact]
    public void Uses_the_lan_bind_when_it_succeeds()
    {
        var outcome = DesktopBind.Decide(lanBindSucceeded: true, loopbackBindSucceeded: false);

        Assert.Equal(DesktopBind.Outcome.Lan, outcome);
    }

    [Fact]
    public void Falls_back_to_loopback_when_the_lan_bind_is_refused()
    {
        var outcome = DesktopBind.Decide(lanBindSucceeded: false, loopbackBindSucceeded: true);

        Assert.Equal(DesktopBind.Outcome.LoopbackOnly, outcome);
    }

    [Fact]
    public void Reports_unavailable_when_nothing_binds_at_all()
    {
        var outcome = DesktopBind.Decide(lanBindSucceeded: false, loopbackBindSucceeded: false);

        Assert.Equal(DesktopBind.Outcome.Unavailable, outcome);
    }

    [Fact]
    public void Prefers_the_lan_bind_even_if_loopback_was_also_reported_as_working()
    {
        // Driver never tries loopback after LAN succeeds, but Decide() shouldn't depend on that
        var outcome = DesktopBind.Decide(lanBindSucceeded: true, loopbackBindSucceeded: true);

        Assert.Equal(DesktopBind.Outcome.Lan, outcome);
    }
}
