using MqttForge.Api.Contracts;
using MqttForge.Domain.Models;

namespace MqttForge.UnitTests.Api;

public sealed class FlowDtoTests
{
    [Fact]
    public void Variables_travel_both_ways()
    {
        var flow = new Flow("f1", "Watch", true, [], []) { Variables = [new FlowVariable("limit", "90")] };

        var dto = FlowDto.Of(flow);
        Assert.Equal([new FlowVariableDto("limit", "90")], dto.Variables);

        Assert.Equal([new FlowVariable("limit", "90")], dto.ToFlow().Variables);
    }

    // A body built by hand: no list is no variables, and a variable missing its parts has empty
    // ones, which the compiler then refuses with a sentence like every other mistake.
    [Fact]
    public void A_body_without_variables_or_with_holes_still_maps()
    {
        Assert.Empty(new FlowDto("f1", "Watch", true, [], []).ToFlow().Variables);

        var flow = new FlowDto("f1", "Watch", true, [], [], [new FlowVariableDto(null, null)]).ToFlow();
        Assert.Equal([new FlowVariable("", "")], flow.Variables);
    }
}
