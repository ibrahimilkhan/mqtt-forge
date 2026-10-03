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
    /// <summary>The largest body a save or a test may send, in bytes.</summary>
    // Worked out from the compiler's own limits, for a flow written with ordinary text. The largest node
    // is now a Webhook: a 64 KiB body and a 2,048-character address, which UTF-8 makes at most 6 KiB —
    // 70 KiB. A flow is a Start, an End and 198 of those, 13.5 MiB, and its 50 variables of 64 KiB each
    // add 3.1 MiB. A fifth of every body and value written as quotes — the console writes a quote or a
    // backslash as two bytes — adds 3.1 MiB more, and the ids, types, positions and wires 0.2 MiB:
    // 19.9 MiB. (FlowDeployLimitTests sends exactly that flow.)
    //
    // Not every flow the compiler would run fits. A control character goes on the wire as \u00XX, six
    // bytes for one, so bodies of nothing but control characters are 74 MiB. A limit that let those
    // through would let 74 MiB of anything through — two and a half times Kestrel's own default of
    // 30 MB — for the model binder to read before the compiler can refuse it on the count. So such a
    // flow is refused with a 413, unread.
    //
    // A setting with no limit of its own — an If's field, a variable's name — has this one.
    public const long DeployBodyBytes = 24 * 1024 * 1024;

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
