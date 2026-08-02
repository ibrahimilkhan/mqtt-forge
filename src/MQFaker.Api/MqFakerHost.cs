using FluentValidation;
using FluentValidation.AspNetCore;
using MQFaker.Api.ErrorHandling;
using MQFaker.Api.Hubs;
using MQFaker.Api.Validation;
using MQFaker.Domain.Abstractions;
using Serilog;

namespace MQFaker.Api;

// Shared by Program and the desktop shell; urls overrides config since desktop picks its port at runtime
public static class MqFakerHost
{
    public static WebApplication Build(string[] args, string? urls = null)
    {
        var builder = WebApplication.CreateBuilder(args);

        if (urls is not null) builder.WebHost.UseUrls(urls);

        builder.Host.UseSerilog((ctx, cfg) => cfg.ReadFrom.Configuration(ctx.Configuration));

        // Without this, controllers 404 when the entry assembly is MQFaker.Desktop, not this one
        builder.Services.AddControllers()
            .AddApplicationPart(typeof(MqFakerHost).Assembly);
        builder.Services.AddSignalR();
        builder.Services.AddFluentValidationAutoValidation();
        builder.Services.AddValidatorsFromAssemblyContaining<ConnectRequestDtoValidator>();
        builder.Services.AddProblemDetails();
        builder.Services.AddExceptionHandler<MqttExceptionHandler>();

        // Dev only: shipped packages serve the UI from this host. AllowCredentials is required by SignalR
        if (builder.Environment.IsDevelopment())
            builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
                p.WithOrigins("http://localhost:5173").AllowAnyHeader().AllowAnyMethod().AllowCredentials()));

        builder.Services.AddMqFaker();

        var app = builder.Build();

        app.UseExceptionHandler();
        if (app.Environment.IsDevelopment()) app.UseCors();

        app.UseDefaultFiles();
        app.UseStaticFiles();

        app.MapControllers();
        app.MapHub<MqttHub>("/hubs/mqtt");

        // Resolved eagerly so its ctor hooks MQTTnet events before the first request
        app.Services.GetRequiredService<IMqttSubscriber>();

        return app;
    }
}
