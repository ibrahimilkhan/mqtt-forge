using Microsoft.AspNetCore.Mvc;
using MqttForge.Api.Contracts;
using MqttForge.Application.Alerts;
using MqttForge.Application.Services;
using MqttForge.Domain.Exceptions;
using MqttForge.Domain.Models;

namespace MqttForge.Api.Controllers;

/// <summary>
/// The rules a user writes, and the alarms they produced.
/// </summary>
// One controller for two nouns, which ColourRuleController's one-route-per-class shape would have
// split in half. They belong together: every endpoint below is one panel's, four of the five read
// or write the same engine, and a rule set and the alarms it caused are a single subject to
// everyone except a routing table. Hence [Route("api")] and a path on each action.
//
// Nothing here decides anything about alerting, and nothing here maps anything. The rule service
// owns whether a save may go through, the engine's core owns every judgement, and the DTOs own
// every translation between the wire and the domain — AlertRulesDto.ToRules, AlertRuleDto.Of,
// AlertRulesResponseDto.Of, AlertsDto.Of. This class is the wiring between the three: a document
// read, a command posted, a snapshot projected.
[ApiController]
[Route("api")]
public sealed class AlertController : ControllerBase
{
    private readonly AlertRuleService _rules;
    private readonly AlertEngine _engine;
    private readonly AlertEngineOptions _options;
    private readonly AlertPanelCounters _panel;

    public AlertController(AlertRuleService rules, AlertEngine engine, AlertEngineOptions options,
                           AlertPanelCounters panel)
    {
        _rules = rules;
        _engine = engine;
        _options = options;
        _panel = panel;
    }

    /// <summary>The rule set, and the two things about this host a rule editor has to know.</summary>
    /// <remarks>
    /// Answers 409 when the file as a whole could not be read. A file that loaded except for one
    /// rule this build does not understand comes back as 200 carrying <c>skippedIds</c>: the panel
    /// has a red line to draw about exactly that, and it cannot draw it from a status code.
    /// </remarks>
    [HttpGet("alert-rules")]
    public async Task<IActionResult> GetRules(CancellationToken ct)
    {
        var document = await _rules.GetAsync(ct);

        // The exact shape JsonAlertRuleStore uses to say 'none of it': its Unreadable() helper
        // returns ([], true, []), while the per-rule path always names what it skipped. So an
        // empty SkippedIds beside Unreadable means the document itself was unreadable, and there
        // is nothing here worth showing anybody.
        //
        // Thrown rather than answered here, so that this 409 and the one PUT produces are the same
        // 409: one status, one reason word, one place to change either.
        if (document.Unreadable && document.SkippedIds.Count == 0)
            throw new AlertRulesUnreadableException(
                "The alert rules file could not be read. No rules are running. Repair the file, or " +
                "save a rule set asking for what is there to be discarded.");

        return Ok(AlertRulesResponseDto.Of(document, _options));
    }

    /// <summary>Replaces the whole rule set, and answers with what was actually written.</summary>
    /// <remarks>
    /// The saved rules come back because two things about them are decided on the way in: a rule
    /// that arrived with no id was given one, and a webhook header sent by name alone was filled
    /// in from the file. The console has to see both or its next save undoes them.
    /// </remarks>
    [HttpPut("alert-rules")]
    public async Task<IActionResult> ReplaceRules(
        AlertRulesDto dto, [FromQuery] bool discardUnreadable, CancellationToken ct)
    {
        // Read before mapping, and a second read of a file ReplaceAsync will read again a moment
        // later. Deliberately: the service's read is the one that decides whether the save is
        // allowed at all, and sharing one read between the two would tie a security decision to a
        // convenience.
        var current = await _rules.GetAsync(ct);

        // The mapping is AlertRulesDto's, not this class's. It is where the id is handed out and
        // where a header sent by name alone is filled in from the file, and both of those are
        // pinned by AlertRuleDtoTests — a second copy here would be a second set of answers with
        // no test on it. An unknown channel throws out of ToAction; the validator has already
        // refused it, so that throw is unreachable from a request.
        var rules = dto.ToRules(current.Rules);

        // Throws AlertRulesUnreadableException when the file holds something unreadable and the
        // caller did not say to discard it, and AlertRulesNotSavedException when the write fails.
        // Both travel out of here untouched; MqttExceptionHandler is where they become an answer.
        await _rules.ReplaceAsync(rules, discardUnreadable, ct);

        return Ok(new AlertRulesSavedDto([.. rules.Select(AlertRuleDto.Of)], Warnings(rules)));
    }

    /// <summary>Everything the alerts panel draws, as one read.</summary>
    // One endpoint and not four, because the panel draws them together and four polls would show
    // four moments. The snapshot is a single immutable object the pump publishes, so this reads
    // one reference and never takes a lock on state the message path is writing. The two numbers
    // beside it are the ones the core cannot know, read off the object its writers share; see
    // AlertPanelCounters for why they are not on the snapshot.
    [HttpGet("alerts")]
    public IActionResult GetAlerts() =>
        Ok(AlertsDto.Of(_engine.Snapshot, _panel.WebhooksDropped, _panel.BlindSeconds));

    /// <summary>Silences one (rule, topic) pair, or lifts a silence with zero minutes.</summary>
    /// <remarks>
    /// The pair is the address, not an alert id: a mute outlives the alert it was set on — an
    /// alarm that clears and rings again an hour later is a different alert with a different id —
    /// and a topic carries '/', so it cannot go in a path anyway.
    /// </remarks>
    [HttpPost("alerts/mute")]
    public IActionResult Mute(MuteRequestDto dto)
    {
        var snapshot = _engine.Snapshot;

        // Checked here because the core deliberately will not. It drops a mute for a pair it does
        // not hold and returns an empty outcome, so that a console muting a row the rules have
        // just edited away cannot fault the pump — right in there, and wrong out here, where
        // somebody pressed a button and is owed an answer about the row they pressed it on.
        //
        // Both lists, because a muted pair whose alarm has since resolved is still a pair the user
        // can reasonably un-mute, and it is not in Active any more.
        var known =
            snapshot.Active.Any(alert => alert.RuleId == dto.RuleId && alert.Topic == dto.Topic) ||
            snapshot.Muted.Any(pair => pair.RuleId == dto.RuleId && pair.Topic == dto.Topic);

        if (!known)
        {
            var problem = new ProblemDetails
            {
                Status = StatusCodes.Status404NotFound,
                Title = "No such alert",
                Detail = $"No alert on this engine belongs to rule '{dto.RuleId}' and topic " +
                         $"'{dto.Topic}'. The rule may have been edited, or the alarm may have gone."
            };

            problem.Extensions["reason"] = "alertUnknown";

            // Written out rather than through Problem(), which has no overload that carries an
            // extension, and with the content type pinned so this reads as a problem document to
            // the same console code that reads every other failure on this API.
            return new ObjectResult(problem)
            {
                StatusCode = StatusCodes.Status404NotFound,
                ContentTypes = { "application/problem+json" }
            };
        }

        // Posted, never applied. This is a Kestrel thread and the core has not a lock in it; the
        // queue is the only place the two worlds are allowed to meet. It is also what keeps the
        // ordering honest — a mute posted after an arrival is applied after that arrival.
        _engine.Post(new MuteCommand(dto.RuleId, dto.Topic, dto.Minutes));

        return NoContent();
    }

    /// <summary>Empties the session's alert history. The active alarms are not history.</summary>
    [HttpDelete("alerts/history")]
    public IActionResult ClearHistory()
    {
        _engine.Post(new ClearHistoryCommand());

        return NoContent();
    }

    /// <summary>What was allowed but is worth saying out loud.</summary>
    // Not FluentValidation's job and it cannot be made into one: a ValidationFailure fails
    // IsValid, which is a 400, so a naive implementation of "webhooks are off on this host" would
    // refuse the save outright. The rule is kept, the file is written, and the panel is told the
    // channel will not fire — because the operator who turned webhooks off and the user writing
    // the rule are frequently not the same person, and the rule is still worth having the day the
    // setting changes.
    //
    // This is the one thing in this class that is not mapping: it is an answer about *this host*,
    // and a DTO factory has no options object to ask.
    private IReadOnlyList<SaveWarningDto> Warnings(IReadOnlyList<AlertRule> rules)
    {
        if (_options.AllowWebhooks) return [];

        var warnings = new List<SaveWarningDto>();

        foreach (var rule in rules)
            if (rule.Actions.Any(action => action is WebhookAction))
                warnings.Add(new SaveWarningDto(rule.Id, "webhooksDisabled"));

        return warnings;
    }
}
