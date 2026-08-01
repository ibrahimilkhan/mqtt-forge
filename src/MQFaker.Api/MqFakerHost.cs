using FluentValidation;
using FluentValidation.AspNetCore;
using MQFaker.Api.ErrorHandling;
using MQFaker.Api.Hubs;
using MQFaker.Api.Validation;
using MQFaker.Domain.Abstractions;
using Serilog;

namespace MQFaker.Api;

// Both entry points build the same host: the API's own Program and the desktop shell,
// which starts this in-process behind a window. The desktop shell picks its port at
// runtime, which is why urls can override configuration.
public static class MqFakerHost
{
    public static WebApplication Build(string[] args, string? urls = null)
    {
        var builder = WebApplication.CreateBuilder(args);

        if (urls is not null) builder.WebHost.UseUrls(urls);

        builder.Host.UseSerilog((ctx, cfg) => cfg.ReadFrom.Configuration(ctx.Configuration));

        // ASP.NET Core's default part discovery only walks the entry assembly's dependency
        // graph for MVC-referencing libraries. The desktop shell's entry assembly is
        // MQFaker.Desktop, not this one, so without stating the part explicitly the
        // controllers defined here are silently invisible to routing (every API call 404s)
        // when this host is started from that entry point.
        builder.Services.AddControllers()
            .AddApplicationPart(typeof(MqFakerHost).Assembly);
        builder.Services.AddSignalR();
        builder.Services.AddFluentValidationAutoValidation();
        builder.Services.AddValidatorsFromAssemblyContaining<ConnectRequestDtoValidator>();
        builder.Services.AddProblemDetails();
        builder.Services.AddExceptionHandler<MqttExceptionHandler>();

        // Only development runs the interface on a separate origin; both shipped packages
        // serve it from this same host. AllowCredentials is required by SignalR.
        if (builder.Environment.IsDevelopment())
            builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
                p.WithOrigins("http://localhost:5173").AllowAnyHeader().AllowAnyMethod().AllowCredentials()));

        builder.Services.AddMqFaker();

        var app = builder.Build();

        // Turns unexpected errors into ProblemDetails in one place
        app.UseExceptionHandler();
        if (app.Environment.IsDevelopment()) app.UseCors();

        // Serves the interface from wwwroot
        app.UseDefaultFiles();
        app.UseStaticFiles();

        app.MapControllers();
        app.MapHub<MqttHub>("/hubs/mqtt");

        // The subscriber hooks MQTTnet events in its constructor; it is created without
        // waiting for the first request so messages are caught as soon as a connection opens.
        app.Services.GetRequiredService<IMqttSubscriber>();

        return app;
    }
}
