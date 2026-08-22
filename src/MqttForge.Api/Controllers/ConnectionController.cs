using Microsoft.AspNetCore.Mvc;
using MqttForge.Api.Contracts;
using MqttForge.Application.Services;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Controllers;

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

        var tls = settings.Tls;

        return Ok(new SavedConnectionDto(
            settings.Host, settings.Port, settings.ClientId, settings.Username,
            HasPassword: !string.IsNullOrEmpty(settings.Password), settings.UseTls,
            settings.Transport, settings.ProtocolVersion, settings.WebSocketPath,
            settings.CleanSession, settings.SessionExpiryInterval,
            // Null rather than an object of defaults, so a console reading this can tell a
            // connection that never touched the TLS section from one that set it all back.
            tls is null ? null : new SavedTlsOptionsDto(
                tls.AllowUntrustedCertificates,
                tls.CertificateAuthorityPath,
                tls.ClientCertificatePath,
                tls.ClientCertificateKeyPath,
                HasClientCertificatePassword: !string.IsNullOrEmpty(tls.ClientCertificatePassword),
                tls.SniHost,
                tls.AlpnProtocol)));
    }

    [HttpPost]
    public async Task<IActionResult> Connect(ConnectRequestDto dto, CancellationToken ct)
    {
        var alreadyConnected = await _service.ConnectAsync(Settings(dto), ct);
        return Ok(new { state = _service.CurrentState.ToString(), alreadyConnected });
    }

    // Everything the console sends, in the shape the domain wants it. The TLS block collapses
    // to null when nothing in it was filled in: an all-defaults object and no object at all mean
    // the same thing to the connection, and only one of them survives a round trip through the
    // settings file looking like the reader never opened that section.
    private static BrokerConnectionSettings Settings(ConnectRequestDto dto) =>
        new(dto.Host, dto.Port, dto.ClientId, dto.Username, dto.Password, dto.UseTls,
            dto.Transport, dto.ProtocolVersion, dto.WebSocketPath,
            dto.CleanSession, dto.SessionExpiryInterval, Tls(dto.Tls));

    private static BrokerTlsSettings? Tls(TlsOptionsDto? dto)
    {
        if (dto is null) return null;

        var settings = new BrokerTlsSettings(
            dto.AllowUntrustedCertificates,
            Trimmed(dto.CertificateAuthorityPath),
            Trimmed(dto.ClientCertificatePath),
            Trimmed(dto.ClientCertificateKeyPath),
            // Not trimmed: a password is whatever it is, spaces included.
            dto.ClientCertificatePassword,
            Trimmed(dto.SniHost),
            Trimmed(dto.AlpnProtocol));

        return settings.IsDefault ? null : settings;
    }

    // A path field a reader emptied comes back as "", which is not the same as a path they never
    // filled in — except that here it is, and the difference is only visible as a file that
    // cannot be opened.
    private static string? Trimmed(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

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
