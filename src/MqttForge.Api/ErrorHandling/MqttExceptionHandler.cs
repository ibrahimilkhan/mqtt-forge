using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using MqttForge.Api.Contracts;
using MqttForge.Domain.Exceptions;

namespace MqttForge.Api.ErrorHandling;

// Known MQTT failures become ProblemDetails; others fall through to the default 500
public sealed class MqttExceptionHandler : IExceptionHandler
{
    private readonly IProblemDetailsService _problemDetailsService;

    public MqttExceptionHandler(IProblemDetailsService problemDetailsService) =>
        _problemDetailsService = problemDetailsService;

    public async ValueTask<bool> TryHandleAsync(
        HttpContext context, Exception exception, CancellationToken ct)
    {
        var (status, title) = exception switch
        {
            BrokerUnreachableException => (StatusCodes.Status502BadGateway, "Could not connect to broker"),
            // Not a 502: the broker is not the one that ended this.
            ConnectAttemptAbortedException => (StatusCodes.Status409Conflict, "Connect aborted"),
            NotConnectedException => (StatusCodes.Status409Conflict, "Not connected"),
            MessageRejectedException => (StatusCodes.Status400BadRequest, "Message rejected"),
            // Nothing the request did wrong: the rules were valid and where they go is unwritable.
            RulesNotSavedException => (StatusCodes.Status500InternalServerError, "Could not save the colour rules"),
            // A conflict and not a 500, because nothing failed: the file on disk holds something
            // this build could not read, and the request is being stopped from deleting it. 409 is
            // the status that says "the state of the thing you are addressing is in the way",
            // which is exactly the sentence, and it is the one status a console can offer a second
            // button for — the save that says 'discard it, I mean this'.
            AlertRulesUnreadableException => (StatusCodes.Status409Conflict, "The alert rules file could not be read"),
            // The alert twin of RulesNotSavedException, and a separate arm for the reason the
            // exception's own comment gives: a reader who was editing an alert must not be told
            // their colour rules could not be saved. Both types are sealed and neither derives
            // from the other, so the order of these arms carries no trap.
            AlertRulesNotSavedException => (StatusCodes.Status500InternalServerError, "Could not save the alert rules"),
            _ => (0, string.Empty)
        };

        if (status == 0) return false;

        context.Response.StatusCode = status;

        var problemDetails = new ProblemDetails
        {
            Status = status,
            Title = title,
            Detail = exception.Message
        };

        // The console words the sentence the user reads; this says which sentence to word.
        // Detail stays the fallback for reasons it doesn't recognise. 'aborted' is the one
        // reason that asks for no sentence at all — the user knows, they pressed it.
        var reason = exception switch
        {
            BrokerUnreachableException broker => BrokerFailureDto.Name(broker.Reason),
            ConnectAttemptAbortedException => "aborted",
            RulesNotSavedException => "rulesNotSaved",
            // The two words the alerts panel branches on. 'rulesUnreadable' is the one that offers
            // the second button, so it has to be told apart from every other 409 the console can
            // meet — a 409 also means 'not connected' and 'connect aborted' on this API.
            AlertRulesUnreadableException => "rulesUnreadable",
            AlertRulesNotSavedException => "alertRulesNotSaved",
            _ => null
        };

        if (reason is not null) problemDetails.Extensions["reason"] = reason;

        return await _problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = context,
            Exception = exception,
            ProblemDetails = problemDetails
        });
    }
}
