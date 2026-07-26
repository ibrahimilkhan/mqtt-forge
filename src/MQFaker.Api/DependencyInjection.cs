using MQFaker.Api.Realtime;
using MQFaker.Application.Services;
using MQFaker.Domain.Abstractions;
using MQFaker.Infrastructure.Mqtt;
using MQFaker.Infrastructure.Persistence;

namespace MQFaker.Api;

public static class DependencyInjection
{
    public static IServiceCollection AddMqFaker(this IServiceCollection services)
    {
        // A single MQTTnet client is shared across all requests (one active connection)
        services.AddSingleton<MqttnetClientProvider>();
        services.AddSingleton<IMqttConnectionManager, MqttnetConnectionManager>();
        services.AddSingleton<IMqttPublisher, MqttnetPublisher>();
        services.AddSingleton<IMessageNotifier, SignalRMessageNotifier>();
        services.AddSingleton<IConnectionStateNotifier, SignalRConnectionStateNotifier>();
        services.AddSingleton<IMqttSubscriber, MqttnetSubscriber>();

        // The settings path is read at resolve time, not registration time, so hosts
        // that add configuration later — such as tests — still supply the right value.
        services.AddSingleton<IConnectionSettingsStore>(sp =>
        {
            var config = sp.GetRequiredService<IConfiguration>();
            var path = config["MqFaker:SettingsPath"]
                ?? Path.Combine(AppContext.BaseDirectory, "connection-settings.json");
            return new JsonConnectionSettingsStore(path);
        });

        services.AddSingleton<ConnectionService>();
        services.AddSingleton<PublishService>();
        services.AddSingleton<SubscriptionService>();
        return services;
    }
}
