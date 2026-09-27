using Microsoft.AspNetCore.Mvc;
using MqttForge.Api.Contracts;
using MqttForge.Application.Flows;
using MqttForge.Application.Services;

namespace MqttForge.Api.Controllers;

/// <summary>The flows page's endpoints. Nothing here decides anything; FlowService and the compiler do.</summary>
[ApiController]
[Route("api/flows")]
public sealed class FlowController : ControllerBase
{
    /// <summary>The largest body a deploy may send, in bytes.</summary>
    // Worked out from the compiler's own limits, so that every flow it would run fits. A node at its
    // largest is a Publish, an Every or an Inject: a 64 KiB payload and a 1,024-character topic, which
    // UTF-8 makes at most 3 KiB — 67 KiB. Two hundred of those are 13.1 MiB, and their ids, types,
    // positions and setting names, with the 400 wires between them, add 0.1 MiB more. The 2.8 MiB
    // left is JSON's own escaping: a quote or a backslash in a template is two bytes on the wire, so
    // a fifth of every template can be quotes. (FlowDeployLimitTests sends exactly that flow.)
    // A setting with no limit of its own — an If's value, a field path, a webhook address — has
    // this one.
    //
    // Kestrel's default is 30 MB, and a body that size of nothing but tiny nodes is work for the
    // model binder before the compiler can refuse it on the count.
    public const long DeployBodyBytes = 16 * 1024 * 1024;

    private readonly FlowService _flows;
    private readonly FlowEngine _engine;

    public FlowController(FlowService flows, FlowEngine engine)
    {
        _flows = flows;
        _engine = engine;
    }

    [HttpGet]
    public async Task<IActionResult> List(CancellationToken ct)
    {
        var view = await _flows.GetAsync(ct);

        return Ok(new FlowsDto(
            [.. view.Flows.Select(FlowDto.Of)],
            [.. view.Problems.Select(one => new FlowProblemDto(one.FlowId, one.Problem.Key, one.Problem.Message))],
            view.Unreadable,
            view.AllowWebhooks,
            view.AlertTopicPrefix));
    }

    /// <summary>What the hub pushes, for a page that has just opened and has not heard a push yet.</summary>
    [HttpGet("status")]
    public IActionResult Status() => Ok(FlowStatusDto.Of(_engine.Status));

    /// <summary>A deploy: the flow is kept and run, or refused with every reason on the node it is about.</summary>
    [HttpPut("{id}")]
    [RequestSizeLimit(DeployBodyBytes)]
    public async Task<IActionResult> Deploy(string id, FlowDto dto, CancellationToken ct)
    {
        var flow = dto.ToFlow();
        if (flow.Id != id)
            return Refused([new FlowProblem(null, null, "The flow's id in the address and in the body differ.")]);

        var result = await _flows.SaveAsync(flow, ct);

        return result.Flow is null ? Refused(result.Problems) : Ok(new FlowSavedDto(FlowDto.Of(result.Flow)));
    }

    [HttpDelete("{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct) =>
        await _flows.DeleteAsync(id, ct)
            ? NoContent()
            : NotFoundProblem("No such flow", $"There is no flow '{id}' to delete.", "flowUnknown");

    [HttpPost("{id}/nodes/{nodeId}/inject")]
    public IActionResult Inject(string id, string nodeId) =>
        _flows.Inject(id, nodeId)
            ? Accepted()
            : NotFoundProblem("Nothing to inject",
                $"No running flow '{id}' has an Inject node '{nodeId}'. Deploy the flow first.", "injectUnknown");

    // A 400 in ValidationProblemDetails' shape, so the console's ApiError already carries the
    // errors map — keyed flow, node:{id} and edge:{id} — and the reason word it branches on.
    private static ObjectResult Refused(IReadOnlyList<FlowProblem> problems)
    {
        var errors = problems
            .GroupBy(problem => problem.Key)
            .ToDictionary(group => group.Key, group => group.Select(problem => problem.Message).ToArray());

        var problem = new ValidationProblemDetails(errors)
        {
            Status = StatusCodes.Status400BadRequest,
            Title = "The flow was not deployed",
            Detail = problems.Count == 1
                ? problems[0].Message
                : $"{problems.Count} things stopped it. The first: {problems[0].Message}",
        };
        problem.Extensions["reason"] = "flowInvalid";

        return new ObjectResult(problem)
        {
            StatusCode = StatusCodes.Status400BadRequest,
            ContentTypes = { "application/problem+json" },
        };
    }

    private static ObjectResult NotFoundProblem(string title, string detail, string reason)
    {
        var problem = new ProblemDetails { Status = StatusCodes.Status404NotFound, Title = title, Detail = detail };
        problem.Extensions["reason"] = reason;

        return new ObjectResult(problem)
        {
            StatusCode = StatusCodes.Status404NotFound,
            ContentTypes = { "application/problem+json" },
        };
    }
}
