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
