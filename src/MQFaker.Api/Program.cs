using FluentValidation;
using FluentValidation.AspNetCore;
using MQFaker.Api;
using MQFaker.Api.ErrorHandling;
using MQFaker.Api.Validation;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

builder.Host.UseSerilog((ctx, cfg) => cfg.ReadFrom.Configuration(ctx.Configuration));

builder.Services.AddControllers();
builder.Services.AddFluentValidationAutoValidation();
builder.Services.AddValidatorsFromAssemblyContaining<ConnectRequestDtoValidator>();
builder.Services.AddProblemDetails();
builder.Services.AddExceptionHandler<MqttExceptionHandler>();
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173").AllowAnyHeader().AllowAnyMethod()));

builder.Services.AddMqFaker();

var app = builder.Build();

// Beklenmedik hataları tek yerde ProblemDetails'e çevirir
app.UseExceptionHandler();
app.UseCors();
app.MapControllers();

app.Run();

// Integration testlerinin WebApplicationFactory ile erişebilmesi için
public partial class Program;
