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
    public IActionResult GetState() =>
        Ok(new
        {
            state = _service.CurrentState.ToString(),
            failure = BrokerFailureDto.Of(_service.CurrentFailure),
            connection = BrokerLinkDto.Of(_service.CurrentLink)
        });

    // Lets the console prefill the connection form
    [HttpGet("settings")]
    public async Task<IActionResult> GetSavedSettings(CancellationToken ct)
    {
        var settings = await _service.GetSavedSettingsAsync(ct);
        if (settings is null) return NoContent();

        return Ok(new SavedConnectionDto(
            settings.Host, settings.Port, settings.ClientId, settings.Username,
            HasPassword: !string.IsNullOrEmpty(settings.Password), settings.UseTls));
    }

    [HttpPost]
    public async Task<IActionResult> Connect(ConnectRequestDto dto, CancellationToken ct)
    {
        var settings = new BrokerConnectionSettings(
            dto.Host, dto.Port, dto.ClientId, dto.Username, dto.Password, dto.UseTls);
        var alreadyConnected = await _service.ConnectAsync(settings, ct);
        return Ok(new { state = _service.CurrentState.ToString(), alreadyConnected });
    }

    // The attempt, not the connection: a panel the user has since navigated away from may have
    // left one in flight, and the request that started it is nobody's to hang up on but its own.
    [HttpDelete("attempt")]
    public IActionResult CancelAttempt()
    {
        _service.CancelAttempt();
        return NoContent();
    }

    [HttpDelete]
    public async Task<IActionResult> Disconnect(CancellationToken ct)
    {
        await _service.DisconnectAsync(ct);
        return NoContent();
    }
}
