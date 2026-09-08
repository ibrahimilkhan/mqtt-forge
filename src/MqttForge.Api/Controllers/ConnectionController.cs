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
    private readonly CertificatePicker _files;
    private readonly InstallIdentity _identity;

    public ConnectionController(
        ConnectionService service, SavedProfileService profiles, CertificatePicker files,
        InstallIdentity identity)
    {
        _service = service;
        _profiles = profiles;
        _files = files;
        _identity = identity;
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
    /// <summary>What a form with nothing in it should suggest.</summary>
    // The client ID is the whole of it: it carries a per-install suffix so that two MQTTForges on
    // one broker do not take the link from each other for ever — see InstallIdentity. Its own
    // endpoint rather than a field on the saved settings, because it is wanted exactly when
    // there are none.
    [HttpGet("defaults")]
    public IActionResult GetDefaults() => Ok(new
    {
        clientId = _identity.DefaultClientId,

        // Whether this server is inside a container, which changes what an address means rather
        // than what it is: 'localhost' there is the container itself, and a reader whose broker is
        // on the machine running Docker is pointing at a host with nothing on it. The runtime sets
        // this variable in every official .NET image; the Dockerfile inherits it.
        inContainer = Environment.GetEnvironmentVariable("DOTNET_RUNNING_IN_CONTAINER") == "true",
    });

    [HttpGet("settings")]
    public async Task<IActionResult> GetSavedSettings(CancellationToken ct)
    {
        var settings = await _service.GetSavedSettingsAsync(ct);

        return settings is null ? NoContent() : Ok(SavedConnectionDto.Of(settings));
    }

    // ---- the three files an encrypted connection can be given ----
    //
    // The paths are read where the server runs, so naming one by typing it is naming a path on a
    // machine the reader may not be sitting at. Where the host owns a window it also owns a file
    // dialog, and that is the one place a path can be pointed at rather than remembered.

    /// <summary>Whether this host can be asked for a certificate file at all.</summary>
    [HttpGet("certificate-file")]
    public IActionResult CanChooseCertificateFile() => Ok(new CertificateDialogDto(_files.CanChoose));

    /// <summary>
    /// Opens the host's own file dialog, and hands back the path it named.
    /// </summary>
    /// <remarks>
    /// A dismissed dialog is not a failure — it is the answer 'not that one, then' — so it comes
    /// back as no path rather than as an error the interface has to explain away. Nothing is
    /// remembered here: the path's home is the box in the form that asked for it.
    /// </remarks>
    [HttpPost("certificate-file")]
    public async Task<IActionResult> ChooseCertificateFile(PickCertificateFileDto dto, CancellationToken ct)
    {
        // Named and defined, both: a body with no kind in it must not fall through to whichever
        // dialog happens to be first, and a number outside the enum reaches the switch that names
        // the dialog and throws there.
        if (dto.Kind is not { } kind || !Enum.IsDefined(kind))
            return ValidationProblem("That is not a certificate field.");

        if (!_files.CanChoose) return StatusCode(StatusCodes.Status501NotImplemented);

        var answer = await _files.ChooseAsync(kind, ct);

        // A dialog already open belongs to somebody — the second console this app is built to be
        // opened on, most likely — and saying so is better than a second dialog on the same window
        // or a request that hangs until the first is answered.
        if (answer.Choice == CertificatePicker.Choice.AlreadyOpen)
            return Problem(
                "A file dialog is already open on the host. Answer that one first.",
                statusCode: StatusCodes.Status409Conflict);

        return Ok(new CertificateFileDto(answer.Path));
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

    // Deliberately not given the request's token. A dial belongs to the link, not to the browser
    // that asked for it: a reader who reloads the page mid-connect, or whose tab is closed by the
    // system, aborted the dial with it — and the reloaded console then drew an empty form over a
    // broker that was never dialled. Only DELETE /api/connection/attempt calls a dial off, which
    // is the button that says so, and the panel finds a running attempt again after a reload
    // because there is one to find.
    [HttpPost]
    public async Task<IActionResult> Connect(ConnectRequestDto dto, CancellationToken _)
    {
        var alreadyConnected = await _service.ConnectAsync(Settings(dto), CancellationToken.None);

        // The dial's own number goes back with the answer, so the console that made it can abort
        // that one rather than whatever happens to be running — see ConnectionService.CancelAttempt.
        return Ok(new
        {
            state = _service.CurrentState.ToString(),
            alreadyConnected,
            dial = _service.LastDial,
        });
    }

    // Everything the console sends, in the shape the domain wants it. The TLS block collapses
    // to null when nothing in it was filled in: an all-defaults object and no object at all mean
    // the same thing to the connection, and only one of them survives a round trip through the
    // settings file looking like the reader never opened that section.
    private static BrokerConnectionSettings Settings(ConnectRequestDto dto) =>
        new(dto.Host, dto.Port, dto.ClientId, dto.Username, dto.Password, dto.UseTls,
            dto.Transport, dto.ProtocolVersion, dto.WebSocketPath,
            dto.CleanSession, dto.SessionExpiryInterval, Tls(dto.Tls), dto.Subscriptions);

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
    // With a dial named, only that one is called off; with none, whatever is running — which is
    // what Try now and an older console mean by it.
    [HttpDelete("attempt")]
    public IActionResult CancelAttempt([FromQuery] long? dial = null)
    {
        _service.CancelAttempt(dial);
        return NoContent();
    }

    [HttpDelete]
    public async Task<IActionResult> Disconnect(CancellationToken ct)
    {
        await _service.DisconnectAsync(ct);
        return NoContent();
    }
}
