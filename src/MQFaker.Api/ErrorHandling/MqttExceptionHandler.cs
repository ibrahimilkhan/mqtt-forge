using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using MQFaker.Domain.Exceptions;

namespace MQFaker.Api.ErrorHandling;

// Turns known MQTT failures into readable ProblemDetails; leaves other exceptions
// to the next handler (default 500).
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
            NotConnectedException => (StatusCodes.Status409Conflict, "Not connected"),
            MessageRejectedException => (StatusCodes.Status400BadRequest, "Message rejected"),
            _ => (0, string.Empty)
        };

        if (status == 0) return false;

        context.Response.StatusCode = status;

        return await _problemDetailsService.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = context,
            Exception = exception,
            ProblemDetails = new ProblemDetails
            {
                Status = status,
                Title = title,
                Detail = exception.Message
            }
        });
    }
}
