using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;
using MqttForge.Api.Validation;
using MqttForge.Application.Services;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Controllers;

[ApiController]
[Route("api/studio")]
public sealed class StudioController : ControllerBase
{
    // A scene is JSON with its models stored apart, so 8 MB is a very large scene; a model is the
    // CAD part itself, and a STEP file of a whole machine runs to a hundred megabytes and more.
    public const long SceneBodyBytes = 8 * 1024 * 1024;
    public const long ModelBodyBytes = 200L * 1024 * 1024;

    private static readonly Dictionary<string, string> ModelTypes = new(StringComparer.Ordinal)
    {
        [".glb"] = "model/gltf-binary",
        [".gltf"] = "model/gltf+json",
        [".stl"] = "model/stl",
        [".obj"] = "model/obj",
    };

    private readonly StudioService _studio;

    public StudioController(StudioService studio) => _studio = studio;

    [HttpGet("scenes")]
    public async Task<IActionResult> List(CancellationToken ct) => Ok(await _studio.ListAsync(ct));

    [HttpGet("scenes/{id}")]
    public async Task<IActionResult> Get(string id, CancellationToken ct)
    {
        var scene = StudioIds.IsSceneId(id) ? await _studio.GetAsync(id, ct) : null;

        return scene is { } found
            ? Content(found.GetRawText(), "application/json")
            : Problem404("No scene", $"There is no scene '{id}'.", "sceneUnknown");
    }

    [HttpPut("scenes/{id}")]
    [RequestSizeLimit(SceneBodyBytes)]
    public async Task<IActionResult> Put(string id, [FromBody] JsonElement scene, CancellationToken ct)
    {
        var errors = StudioIds.IsSceneId(id)
            ? StudioSceneRules.Check(id, scene)
            : new Dictionary<string, string[]> { ["id"] = ["A scene id is letters, digits, '-' and '_', up to 64."] };
        if (errors.Count > 0) return Refused("The scene was not saved", errors, "sceneInvalid");

        await _studio.SaveAsync(id, scene, DateTimeOffset.UtcNow, ct);
        return NoContent();
    }

    [HttpDelete("scenes/{id}")]
    public async Task<IActionResult> Delete(string id, CancellationToken ct) =>
        StudioIds.IsSceneId(id) && await _studio.DeleteAsync(id, ct)
            ? NoContent()
            : Problem404("No scene", $"There is no scene '{id}'.", "sceneUnknown");

    // The body is the file itself rather than a multipart form: one part per request is all the
    // studio sends, and a raw body streams straight to disk through the hash.
    [HttpPost("models")]
    [RequestSizeLimit(ModelBodyBytes)]
    public async Task<IActionResult> Upload([FromQuery] string? ext, CancellationToken ct)
    {
        var extension = ext?.ToLowerInvariant();
        if (!StudioIds.IsModelExtension(extension))
            return Refused("The model was not stored",
                new Dictionary<string, string[]> { ["ext"] = [$"'{ext}' is not a model format the studio keeps."] },
                "modelInvalid");

        var key = await _studio.PutModelAsync(Request.Body, extension!, ct);
        return Ok(new { key });
    }

    [HttpGet("models/{key}")]
    public IActionResult Model(string key)
    {
        var stream = _studio.OpenModel(key);
        if (stream is null) return Problem404("No model", $"There is no model '{key}'.", "modelUnknown");

        // The key is the content's hash, so what it names can never change: cached for good.
        Response.Headers.CacheControl = "public, max-age=31536000, immutable";
        var type = ModelTypes.GetValueOrDefault(Path.GetExtension(key), "application/octet-stream");
        return File(stream, type, lastModified: null, entityTag: new EntityTagHeaderValue($"\"{key}\""));
    }

    private static ObjectResult Refused(string title, Dictionary<string, string[]> errors, string reason)
    {
        var problem = new ValidationProblemDetails(errors) { Status = StatusCodes.Status400BadRequest, Title = title };
        problem.Extensions["reason"] = reason;

        return new ObjectResult(problem)
        {
            StatusCode = StatusCodes.Status400BadRequest,
            ContentTypes = { "application/problem+json" },
        };
    }

    private static ObjectResult Problem404(string title, string detail, string reason)
    {
        var problem = new ProblemDetails { Status = StatusCodes.Status404NotFound, Title = title, Detail = detail };
        problem.Extensions["reason"] = reason;

        return new ObjectResult(problem)
        {
            StatusCode = StatusCodes.Status404NotFound,
            ContentTypes = { "application/problem+json" },
        };
    }
}
