using Microsoft.AspNetCore.Mvc;
using MqttForge.Api.Contracts;
using MqttForge.Application.Services;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Controllers;

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

    // One packet for the lot, so subscribing in bulk costs one broker round trip, not N.
    [HttpPost("batch")]
    public async Task<IActionResult> SubscribeBatch(SubscribeBatchDto dto, CancellationToken ct)
    {
        var requests = dto.Filters
            .Select(f => new SubscriptionRequest(f.TopicFilter, f.Qos))
            .ToArray();

        await _service.SubscribeAsync(requests, ct);
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
