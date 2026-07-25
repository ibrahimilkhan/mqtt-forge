using Microsoft.AspNetCore.Mvc;
using MQFaker.Api.Contracts;
using MQFaker.Application.Services;
using MQFaker.Domain.Models;

namespace MQFaker.Api.Controllers;

[ApiController]
[Route("api/connection")]
public sealed class ConnectionController : ControllerBase
{
    private readonly ConnectionService _service;

    public ConnectionController(ConnectionService service) => _service = service;

    [HttpGet]
    public IActionResult GetState() => Ok(new { state = _service.CurrentState.ToString() });

    [HttpPost]
    public async Task<IActionResult> Connect(ConnectRequestDto dto, CancellationToken ct)
    {
        var settings = new BrokerConnectionSettings(
            dto.Host, dto.Port, dto.ClientId, dto.Username, dto.Password, dto.UseTls);
        await _service.ConnectAsync(settings, ct);
        return Ok(new { state = _service.CurrentState.ToString() });
    }

    [HttpDelete]
    public async Task<IActionResult> Disconnect(CancellationToken ct)
    {
        await _service.DisconnectAsync(ct);
        return NoContent();
    }
}
