using Microsoft.AspNetCore.Mvc;
using MqttForge.Api.Contracts;
using MqttForge.Application.Services;

namespace MqttForge.Api.Controllers;

// Getting the readings out of the console is the part every tool leaves undone, and the browser
// cannot do it here: the window loads a LAN address over plain http, which is not a secure
// context, so the folder picker is as absent as the clipboard. The dialog belongs to the host and
// the writing belongs here.
[ApiController]
[Route("api/export")]
public sealed class ExportController : ControllerBase
{
    private readonly ExportService _service;

    public ExportController(ExportService service) => _service = service;

    /// <summary>Where saved readings are going, and whether this host can be asked to change it.</summary>
    [HttpGet("folder")]
    public IActionResult Folder() => Ok(new ExportFolderDto(_service.Folder, _service.CanChoose));

    /// <summary>
    /// Opens the host's own folder dialog.
    /// </summary>
    /// <remarks>
    /// A dismissed dialog is not a failure — it is the answer 'not there, then' — so it comes back
    /// as the folder unchanged rather than as an error the interface has to explain away.
    /// </remarks>
    [HttpPost("folder")]
    public async Task<IActionResult> Choose(CancellationToken ct)
    {
        if (!_service.CanChoose) return StatusCode(StatusCodes.Status501NotImplemented);

        // A dialog already open belongs to somebody — the second console this app is built to be
        // opened on, most likely — and saying so is better than a second dialog on the same window
        // or a request that hangs until the first is answered.
        if (await _service.ChooseAsync(ct) == ExportService.Choice.AlreadyOpen)
            return Problem(
                "A folder dialog is already open on the host.",
                statusCode: StatusCodes.Status409Conflict);

        return Ok(new ExportFolderDto(_service.Folder, _service.CanChoose));
    }

    [HttpPost("csv")]
    public async Task<IActionResult> SaveCsv(SaveCsvDto dto, CancellationToken ct)
    {
        if (_service.Folder is null)
            return Problem("No folder has been chosen to save into.", statusCode: StatusCodes.Status409Conflict);

        if (dto.Content.Length > ExportService.LargestExport)
            return Problem("That run is too large to save.", statusCode: StatusCodes.Status413PayloadTooLarge);

        try
        {
            return Ok(new SavedDto(await _service.SaveAsync(dto.Name, dto.Content, ct)));
        }
        catch (DirectoryNotFoundException)
        {
            // The folder was chosen and has since gone — an unmounted volume, a deleted directory.
            return Problem("The chosen folder is no longer there.", statusCode: StatusCodes.Status409Conflict);
        }
    }
}
