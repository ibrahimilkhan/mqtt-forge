using Microsoft.AspNetCore.Mvc;
using MqttForge.Api.Contracts;
using MqttForge.Application.Services;

namespace MqttForge.Api.Controllers;

// One document, replaced whole. Rules carry no id because nothing points at one: which rule
// colours a topic is decided by how specific its filter is, not by which row it sits in.
[ApiController]
[Route("api/colour-rules")]
public sealed class ColourRuleController : ControllerBase
{
    private readonly ColourRuleService _service;

    public ColourRuleController(ColourRuleService service) => _service = service;

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var rules = await _service.GetAsync(ct);
        return Ok(new ColourRulesDto([.. rules.Select(ColourRuleDto.Of)]));
    }

    [HttpPut]
    public async Task<IActionResult> Replace(ColourRulesDto dto, CancellationToken ct)
    {
        await _service.ReplaceAsync([.. dto.Rules.Select(rule => rule.ToRule())], ct);
        return NoContent();
    }
}
