using Microsoft.AspNetCore.Mvc;
using MqttForge.Api.Contracts;

namespace MqttForge.Api.Controllers;

/// <summary>The supervisor, as something a reader can see and answer.</summary>
// Its own controller rather than four more actions on ConnectionController, which is already the
// largest in the app and is about one thing: the settings a link is made from. These four are
// about the standing arrangement to keep one — a different question, asked at a different time,
// by a panel that is usually looking at something else.
//
// Under api/connection all the same, because that is what it is about, and because a console
// that had to learn a second root for it would be learning a distinction that only exists here.
[ApiController]
[Route("api/connection/reconnect")]
public sealed class ReconnectController : ControllerBase
{
    private readonly BrokerLinkSupervisor _supervisor;

    public ReconnectController(BrokerLinkSupervisor supervisor) => _supervisor = supervisor;

    /// <summary>What is being done about the link, and whether anything is allowed to be.</summary>
    // The console is pushed this on every change and asks for it once on load, the same
    // arrangement the connection state has. Neither is enough on its own: the push covers a
    // console that was watching, and this covers one that has just been opened.
    [HttpGet]
    public IActionResult GetStatus() => Ok(ReconnectStatusDto.Of(_supervisor.Status, _supervisor.Now));

    /// <summary>Turns supervision on or off, and remembers the answer.</summary>
    [HttpPut]
    public async Task<IActionResult> SetEnabled(ReconnectOptionDto dto, CancellationToken ct)
    {
        // A body with no answer in it is not an answer. Defaulting it either way would let a
        // malformed request quietly turn supervision off, which is the one outcome nobody would
        // notice until a broker dropped.
        if (dto.Enabled is not { } enabled)
            return ValidationProblem("Say whether auto-reconnect should be on or off.");

        await _supervisor.SetEnabledAsync(enabled, ct);

        return Ok(ReconnectStatusDto.Of(_supervisor.Status, _supervisor.Now));
    }

    /// <summary>Dials now, whatever the ladder was waiting for.</summary>
    // Answers with the status rather than with the outcome of the dial. The outcome arrives on
    // the connection state, which is where every other connect result in this app arrives, and a
    // second copy of it here would be a second thing that can disagree.
    [HttpPost]
    public async Task<IActionResult> RetryNow(CancellationToken ct)
    {
        await _supervisor.RetryNowAsync(ct);

        return Ok(ReconnectStatusDto.Of(_supervisor.Status, _supervisor.Now));
    }

    /// <summary>Calls off the outage being worked on, and the attempt in flight with it.</summary>
    // Not the same as PUT false, and the panel offers both: this one is "stop, I am looking at
    // it" and lasts until the next connection that works, where the switch is the standing answer.
    [HttpDelete]
    public async Task<IActionResult> Cancel()
    {
        await _supervisor.CancelAsync();

        return Ok(ReconnectStatusDto.Of(_supervisor.Status, _supervisor.Now));
    }
}
