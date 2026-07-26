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
// AllowCredentials, React geliştirme sunucusundan kurulan SignalR bağlantısı için gerekli
builder.Services.AddCors(o => o.AddDefaultPolicy(p =>
    p.WithOrigins("http://localhost:5173").AllowAnyHeader().AllowAnyMethod().AllowCredentials()));

builder.Services.AddMqFaker();

var app = builder.Build();

// Beklenmedik hataları tek yerde ProblemDetails'e çevirir
app.UseExceptionHandler();
app.UseCors();

// wwwroot'taki geliştirme test konsolunu servis eder
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapControllers();
app.MapHub<MqttHub>("/hubs/mqtt");

// Abone dinleyicisi kurucusunda MQTTnet olaylarına bağlanır; ilk istek beklenmeden
// oluşturulur ki bağlantı kurulur kurulmaz gelen mesajlar yakalanabilsin.
app.Services.GetRequiredService<IMqttSubscriber>();

app.Run();

// Integration testlerinin WebApplicationFactory ile erişebilmesi için
public partial class Program;
