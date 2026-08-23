using Microsoft.AspNetCore.Mvc;
using MqttForge.Api.Contracts;
using MqttForge.Application.Services;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Controllers;

[ApiController]
[Route("api/connection")]
public sealed class ConnectionController : ControllerBase
{
    /// <summary>The longest a chip can carry and still read as a name rather than a sentence.</summary>
    private const int NameLimit = 60;

    private readonly ConnectionService _service;
    private readonly SavedProfileService _profiles;

    public ConnectionController(ConnectionService service, SavedProfileService profiles)
    {
        _service = service;
        _profiles = profiles;
    }

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

        return settings is null ? NoContent() : Ok(SavedConnectionDto.Of(settings));
    }

    // ---- brokers somebody chose to keep ----
    //
    // Apart from the settings above, which are a cache: those are overwritten after every
    // connect that works, and these are written only when somebody presses Save.

    [HttpGet("profiles")]
    public async Task<IActionResult> GetProfiles(CancellationToken ct)
    {
        var profiles = await _profiles.GetAsync(ct);

        return Ok(profiles.Select(one => new SavedProfileDto(one.Name, SavedConnectionDto.Of(one.Settings))));
    }

    // PUT rather than POST: the name is the identity, and saving one that is already here
    // replaces it — which is what somebody correcting a port presses Save to do.
    [HttpPut("profiles")]
    public async Task<IActionResult> SaveProfile(SaveProfileRequestDto dto, CancellationToken ct)
    {
        var name = dto.Name?.Trim();

        // A chip with no word on it is a chip nobody can press deliberately.
        if (string.IsNullOrEmpty(name)) return ValidationProblem("A saved broker needs a name.");
        if (name.Length > NameLimit)
            return ValidationProblem($"A name may be at most {NameLimit} characters.");

        await _profiles.SaveAsync(new SavedBrokerProfile(name, Settings(dto.Connection)), ct);

        return NoContent();
    }

    [HttpDelete("profiles/{name}")]
    public async Task<IActionResult> DeleteProfile(string name, CancellationToken ct) =>
        await _profiles.DeleteAsync(name, ct) ? NoContent() : NotFound();

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
