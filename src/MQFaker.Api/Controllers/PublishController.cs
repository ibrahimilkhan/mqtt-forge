using Microsoft.AspNetCore.Mvc;
using MQFaker.Api.Contracts;
using MQFaker.Application.Services;
using MQFaker.Domain.Models;

namespace MQFaker.Api.Controllers;

[ApiController]
[Route("api/publish")]
public sealed class PublishController : ControllerBase
{
    private readonly PublishService _service;

    public PublishController(PublishService service) => _service = service;

    [HttpPost]
    public async Task<IActionResult> Publish(PublishRequestDto dto, CancellationToken ct)
    {
        await _service.PublishAsync(
            new PublishRequest(dto.Topic, dto.Payload, dto.Qos, dto.Retain), ct);
        return Accepted();
    }
}
