using Microsoft.AspNetCore.Mvc;
using MQFaker.Api.Contracts;
using MQFaker.Application.Services;
using MQFaker.Domain.Models;

namespace MQFaker.Api.Controllers;

[ApiController]
[Route("api/subscriptions")]
public sealed class SubscriptionController : ControllerBase
{
    private readonly SubscriptionService _service;

    public SubscriptionController(SubscriptionService service) => _service = service;

    [HttpGet]
    public IActionResult GetActive() => Ok(_service.ActiveFilters);

    [HttpPost]
    public async Task<IActionResult> Subscribe(SubscribeRequestDto dto, CancellationToken ct)
    {
        await _service.SubscribeAsync(new SubscriptionRequest(dto.TopicFilter, dto.Qos), ct);
        return Accepted();
    }

    // Query value, not a path segment: '#' and '/' aren't path-safe
    [HttpDelete]
    public async Task<IActionResult> Unsubscribe([FromQuery] string topicFilter, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(topicFilter))
            return BadRequest(new ProblemDetails { Title = "topicFilter is required", Status = 400 });

        await _service.UnsubscribeAsync(topicFilter, ct);
        return NoContent();
    }
}
