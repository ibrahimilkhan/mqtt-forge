using FluentValidation;
using FluentValidation.AspNetCore;
using Microsoft.AspNetCore.Cors.Infrastructure;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Extensions.Options;
using Microsoft.Net.Http.Headers;
using MqttForge.Api.Contracts;
using MqttForge.Api.ErrorHandling;
using MqttForge.Api.Hubs;
using MqttForge.Api.Validation;
using MqttForge.Domain.Abstractions;
using Serilog;

namespace MqttForge.Api;

// Shared by Program and the desktop shell; urls overrides config since desktop picks its port at runtime
public static class MqttForgeHost
{
    /// <summary>Where it listens when nothing else says. See the note in <see cref="Build"/>.</summary>
    public const string DefaultUrls = "http://0.0.0.0:5169";

    /// <param name="configure">
    /// What only the host knows how to provide. The folder dialog belongs to the window, and a
    /// run with no window registers none — which is what makes the interface fall back.
    /// </param>
    public static WebApplication Build(
        string[] args,
        string? urls = null,
        Action<IServiceCollection>? configure = null)
    {
        var builder = WebApplication.CreateBuilder(args);

        // A published app carries no launchSettings.json, so without a default Kestrel falls back
        // to port 5000 — which on macOS AirPlay already answers on. This used to be pinned in
        // appsettings.json, where it silently beat ASPNETCORE_URLS and ASPNETCORE_HTTP_PORTS:
        // the prefixed environment provider sits below the JSON file, so the two variables any
        // .NET user would reach for did nothing, and the container warned about it at every
        // start. Filling the gap only when the environment named no binding leaves both working.
        if (builder.Configuration["Urls"] is null && builder.Configuration["HTTP_PORTS"] is null)
            builder.WebHost.UseUrls(DefaultUrls);

        if (urls is not null) builder.WebHost.UseUrls(urls);

        builder.Host.UseSerilog((ctx, cfg) => cfg.ReadFrom.Configuration(ctx.Configuration));

        // Ten seconds to stop, pinned rather than inherited. The spec's "Sayılar" table costs the
        // close at ten with four of them for the drain — long enough for a webhook already handed
        // to HttpClient to get its answer or give up, and for the engine to write alert-state.json
        // down. Docker sends SIGKILL ten seconds after SIGTERM by default, so a host holding out
        // for the framework's thirty would simply be killed halfway through that, having saved
        // nothing.
        //
        // Pinned because the default has already moved: the spec was written against five
        // seconds, which was shorter than a single webhook timeout, and .NET 10 hands out thirty.
        // Neither number is this app's; this one is.
        builder.Services.Configure<HostOptions>(options => options.ShutdownTimeout = TimeSpan.FromSeconds(10));

        // Without this, controllers 404 when the entry assembly is MqttForge.Desktop, not this one
        builder.Services.AddControllers()
            .AddApplicationPart(typeof(MqttForgeHost).Assembly)
            .AddJsonOptions(o => WireJson.Apply(o.JsonSerializerOptions));

        // The same treatment for the hub, which sends the same two DTOs. See WireJson.
        builder.Services.AddSignalR()
            .AddJsonProtocol(o => WireJson.Apply(o.PayloadSerializerOptions));
        builder.Services.AddFluentValidationAutoValidation();
        builder.Services.AddValidatorsFromAssemblyContaining<ConnectRequestDtoValidator>();
        builder.Services.AddProblemDetails();
        builder.Services.AddExceptionHandler<MqttExceptionHandler>();

        // Dev only: shipped packages serve the UI from this host. AllowCredentials is required by SignalR
        // OriginGuard trusts whatever this names, so an origin added here may change things as well
        // as read them.
        if (builder.Environment.IsDevelopment())
            builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
                p.WithOrigins("http://localhost:5173").AllowAnyHeader().AllowAnyMethod().AllowCredentials()));

        builder.Services.AddMqttForge();
        builder.Services.AddSingleton<OriginGuardLog>();
        configure?.Invoke(builder.Services);

        var app = builder.Build();

        app.UseExceptionHandler();

        // Before anything is served, and only while nobody has taken the question over: a host
        // named in AllowedHosts means the operator has said which names this answers to, and
        // ASP.NET's own filtering is already enforcing exactly that. '*' — what ships, and what
        // an unset value means — is the case with no answer at all, which is the one that needs
        // one. See HostGuard for why a name is refused where an address is not.
        if (Guarding(builder.Configuration))
            app.Use(async (context, next) =>
            {
                if (!HostGuard.IsAllowed(context.Request.Host.Host))
                {
                    context.Response.StatusCode = StatusCodes.Status400BadRequest;
                    return;
                }

                await next(context);
            });

        // Whether or not the guard above stands: a name the operator chose is no more a reason to
        // take a request from another site's page than an address is. See OriginGuard for which
        // requests, and why one that names no origin is still served.
        var trusted = TrustedOrigins(app.Services);
        var refusals = app.Services.GetRequiredService<OriginGuardLog>();
        app.Use(async (context, next) =>
        {
            if (!OriginGuard.IsAllowed(context.Request, trusted))
            {
                // Said in the log only when it is this app's own page but for the scheme: a proxy
                // that ends TLS in front of an app nobody told. See OriginGuardLog.
                refusals.Refused(context.Request);

                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                return;
            }

            await next(context);
        });

        if (app.Environment.IsDevelopment()) app.UseCors();

        app.UseDefaultFiles();
        app.UseStaticFiles(new StaticFileOptions { OnPrepareResponse = CacheByFilename });

        app.MapControllers();
        app.MapHub<MqttHub>("/hubs/mqtt");

        // Resolved eagerly so its ctor hooks MQTTnet events before the first request
        app.Services.GetRequiredService<IMqttSubscriber>();

        return app;
    }

    /// <summary>
    /// Whether the guard applies. Setting <c>AllowedHosts</c> to anything but <c>*</c> is how an
    /// operator says they want a name of their own answered, and hands the question to ASP.NET.
    /// </summary>
    private static bool Guarding(IConfiguration configuration) =>
        configuration["AllowedHosts"] is null or "" or "*";

    /// <summary>
    /// The origins besides the app's own whose pages may change things here: those the CORS policy
    /// lets read an answer, so that the two cannot come to disagree. Only Development has a policy,
    /// naming the dev server; a shipped package trusts no other origin at all.
    /// </summary>
    private static Func<string, bool> TrustedOrigins(IServiceProvider services)
    {
        var cors = services.GetRequiredService<IOptions<CorsOptions>>().Value;

        return cors.GetPolicy(cors.DefaultPolicyName)?.IsOriginAllowed ?? (_ => false);
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
