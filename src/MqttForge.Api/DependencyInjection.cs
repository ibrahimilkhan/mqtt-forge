using MqttForge.Api.Realtime;
using MqttForge.Application.Services;
using MqttForge.Domain.Abstractions;
using MqttForge.Infrastructure.Mqtt;
using MqttForge.Infrastructure.Persistence;

namespace MqttForge.Api;

public static class DependencyInjection
{
    public static IServiceCollection AddMqttForge(this IServiceCollection services)
    {
        // Single MQTTnet client for all requests (one active connection)
        services.AddSingleton<MqttnetClientProvider>();
        services.AddSingleton<IMqttConnectionManager, MqttnetConnectionManager>();
        services.AddSingleton<IMqttPublisher, MqttnetPublisher>();
        // One instance wearing both hats: the notifier that queues, and the pump that drains it.
        services.AddSingleton<SignalRMessageNotifier>();
        services.AddSingleton<IMessageNotifier>(sp => sp.GetRequiredService<SignalRMessageNotifier>());
        services.AddHostedService(sp => sp.GetRequiredService<SignalRMessageNotifier>());
        services.AddSingleton<IConnectionStateNotifier, SignalRConnectionStateNotifier>();
        services.AddSingleton<IMqttSubscriber, MqttnetSubscriber>();

        // Read at resolve time, not registration, so late-configuring hosts (tests) still work
        services.AddSingleton<IConnectionSettingsStore>(sp =>
        {
            var config = sp.GetRequiredService<IConfiguration>();
            var path = config["MqttForge:SettingsPath"]
                ?? Path.Combine(AppContext.BaseDirectory, "connection-settings.json");
            return new JsonConnectionSettingsStore(path);
        });

        services.AddSingleton<ConnectionService>();
        services.AddSingleton<PublishService>();
        services.AddSingleton<SubscriptionService>();
        return services;
    }
}
