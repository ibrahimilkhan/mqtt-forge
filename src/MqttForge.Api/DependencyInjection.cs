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
            new JsonConnectionSettingsStore(StorePaths.ConnectionSettings(sp.GetRequiredService<IConfiguration>())));

        services.AddSingleton<IColourRuleStore>(sp =>
            new JsonColourRuleStore(StorePaths.ColourRules(sp.GetRequiredService<IConfiguration>())));

        services.AddSingleton<ISavedProfileStore>(sp =>
            new JsonSavedProfileStore(StorePaths.SavedProfiles(sp.GetRequiredService<IConfiguration>())));

        services.AddSingleton<ConnectionService>();
        services.AddSingleton<ColourRuleService>();
        services.AddSingleton<SavedProfileService>();
        services.AddSingleton<PublishService>();
        services.AddSingleton<SubscriptionService>();
        // The picker is registered by the host that owns a window, and by nothing else — a run
        // with no window resolves null here and the interface falls back to a download.
        services.AddSingleton(sp => new ExportService(sp.GetService<IFolderPicker>()));
        return services;
    }
}
