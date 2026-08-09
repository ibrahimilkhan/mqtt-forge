using FluentValidation;
using FluentValidation.AspNetCore;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Net.Http.Headers;
using MqttForge.Api.ErrorHandling;
using MqttForge.Api.Hubs;
using MqttForge.Api.Validation;
using MqttForge.Domain.Abstractions;
using Serilog;

namespace MqttForge.Api;

// Shared by Program and the desktop shell; urls overrides config since desktop picks its port at runtime
public static class MqttForgeHost
{
    public static WebApplication Build(string[] args, string? urls = null)
    {
        var builder = WebApplication.CreateBuilder(args);

        if (urls is not null) builder.WebHost.UseUrls(urls);

        builder.Host.UseSerilog((ctx, cfg) => cfg.ReadFrom.Configuration(ctx.Configuration));

        // Without this, controllers 404 when the entry assembly is MqttForge.Desktop, not this one
        builder.Services.AddControllers()
            .AddApplicationPart(typeof(MqttForgeHost).Assembly);
        builder.Services.AddSignalR();
        builder.Services.AddFluentValidationAutoValidation();
        builder.Services.AddValidatorsFromAssemblyContaining<ConnectRequestDtoValidator>();
        builder.Services.AddProblemDetails();
        builder.Services.AddExceptionHandler<MqttExceptionHandler>();

        // Dev only: shipped packages serve the UI from this host. AllowCredentials is required by SignalR
        if (builder.Environment.IsDevelopment())
            builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
                p.WithOrigins("http://localhost:5173").AllowAnyHeader().AllowAnyMethod().AllowCredentials()));

        builder.Services.AddMqttForge();

        var app = builder.Build();

        app.UseExceptionHandler();
        if (app.Environment.IsDevelopment()) app.UseCors();

        app.UseDefaultFiles();
        app.UseStaticFiles(new StaticFileOptions { OnPrepareResponse = CacheByFilename });

        app.MapControllers();
        app.MapHub<MqttHub>("/hubs/mqtt");

        // Resolved eagerly so its ctor hooks MQTTnet events before the first request
        app.Services.GetRequiredService<IMqttSubscriber>();

        return app;
    }

    // Vite hashes every asset filename, so those are safe to keep forever. index.html is the
    // one file whose name never changes, and it names the hashed bundles — cache it and the
    // whole UI stays pinned to whichever build the client saw first.
    private static void CacheByFilename(StaticFileResponseContext context)
    {
        var headers = context.Context.Response.GetTypedHeaders();

        headers.CacheControl = context.Context.Request.Path.StartsWithSegments("/assets")
            ? new CacheControlHeaderValue { Public = true, MaxAge = TimeSpan.FromDays(365) }
            : new CacheControlHeaderValue { NoCache = true };
    }
}
