using MQFaker.Application.Services;
using MQFaker.Domain.Abstractions;
using MQFaker.Infrastructure.Mqtt;
using MQFaker.Infrastructure.Persistence;

namespace MQFaker.Api;

public static class DependencyInjection
{
    public static IServiceCollection AddMqFaker(this IServiceCollection services, IConfiguration config)
    {
        // Tek MQTTnet client tüm istekler arasında paylaşılır (tek aktif bağlantı)
        services.AddSingleton<MqttnetClientProvider>();
        services.AddSingleton<IMqttConnectionManager, MqttnetConnectionManager>();
        services.AddSingleton<IMqttPublisher, MqttnetPublisher>();

        var settingsPath = config["MqFaker:SettingsPath"]
            ?? Path.Combine(AppContext.BaseDirectory, "connection-settings.json");
        services.AddSingleton<IConnectionSettingsStore>(_ => new JsonConnectionSettingsStore(settingsPath));

        services.AddSingleton<ConnectionService>();
        services.AddSingleton<PublishService>();
        return services;
    }
}
