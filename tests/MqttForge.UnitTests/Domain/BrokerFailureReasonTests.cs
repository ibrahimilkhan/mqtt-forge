using MqttForge.Domain.Enums;
using Xunit;

namespace MqttForge.UnitTests.Domain;

public class BrokerFailureReasonTests
{
    // The console has a sentence for every one of these, and connectFailure.test.ts counts them
    // from its side. A reason added here and not there reaches a reader as a raw .NET exception
    // message — so the two counts are what keeps the pair honest.
    [Fact]
    public void Every_reason_is_one_the_console_has_words_for()
    {
        Assert.Equal(32, Enum.GetValues<BrokerFailureReason>().Length);
    }
}
