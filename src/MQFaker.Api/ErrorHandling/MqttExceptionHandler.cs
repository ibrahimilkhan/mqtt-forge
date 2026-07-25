using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using MQFaker.Domain.Exceptions;

namespace MQFaker.Api.ErrorHandling;

// Bilinen MQTT hatalarını okunabilir ProblemDetails'e çevirir; diğer istisnaları
// bir sonraki işleyiciye (varsayılan 500) bırakır.
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
            BrokerUnreachableException => (StatusCodes.Status502BadGateway, "Broker'a bağlanılamadı"),
            NotConnectedException => (StatusCodes.Status409Conflict, "Bağlantı yok"),
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
