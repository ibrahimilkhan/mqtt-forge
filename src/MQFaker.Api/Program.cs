using FluentValidation;
using FluentValidation.AspNetCore;
using MQFaker.Api;
using MQFaker.Api.ErrorHandling;
using MQFaker.Api.Hubs;
using MQFaker.Api.Validation;
using MQFaker.Domain.Abstractions;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseSerilog((ctx, cfg) => cfg.ReadFrom.Configuration(ctx.Configuration));

builder.Services.AddControllers();
builder.Services.AddSignalR();
builder.Services.AddFluentValidationAutoValidation();
builder.Services.AddValidatorsFromAssemblyContaining<ConnectRequestDtoValidator>();
builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<MqttExceptionHandler>();
// AllowCredentials is required for the SignalR connection made from the React dev server
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173").AllowAnyHeader().AllowAnyMethod().AllowCredentials()));

builder.Services.AddMqFaker();

var app = builder.Build();

// Turns unexpected errors into ProblemDetails in one place
app.UseExceptionHandler();
app.UseCors();

// Serves the development test console in wwwroot
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapControllers();
app.MapHub<MqttHub>("/hubs/mqtt");

// The subscriber hooks MQTTnet events in its constructor; it is created without
// waiting for the first request so messages are caught as soon as a connection opens.
app.Services.GetRequiredService<IMqttSubscriber>();

app.Run();

// Exposed so integration tests can reach it through WebApplicationFactory
public partial class Program;
