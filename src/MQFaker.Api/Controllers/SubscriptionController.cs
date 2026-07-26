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

    // Filtre yol parçası değil query olarak alınır; '#' ve '/' yolda güvenle taşınamaz
    [HttpDelete]
    public async Task<IActionResult> Unsubscribe([FromQuery] string topicFilter, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(topicFilter))
            return BadRequest(new ProblemDetails { Title = "topicFilter gerekli", Status = 400 });

        await _service.UnsubscribeAsync(topicFilter, ct);
        return NoContent();
    }
}
